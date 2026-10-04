# Build log

I built this with an AI coding assistant, Claude Code. I made the decisions: Postgres over SQLite, TypeScript, a CLI as the interface, what counted as done, and what to verify before calling it done. The tool wrote most of the code and tests. This log is about the places where its first answer was wrong or incomplete, how each one was caught, and what changed as a result.

Every failure below can be reproduced by making the one-line change described. The numbers come from re-running each experiment against the final code.

## How the project is shaped

All four rules are enforced in the ledger module (`src/ledger/`) and the database schema, not in the CLI. The CLI parses arguments, calls the ledger and prints the result. So the tests that matter run real concurrent transactions against the ledger and Postgres directly, and a smaller set runs the actual `move-money` command as separate processes.

## Where my tools led me astray

### 1. The "textbook" lock deadlocked under load

The first version of the transfer locked both accounts with `SELECT … ORDER BY id FOR UPDATE`. That's the standard answer, and locking in a consistent order is the standard deadlock prevention, so it looked right. The deterministic race test passed. Then the load test hung: 100 transfers at once over 20 database connections, all draining one account.

**Caught by:** the load test, and the Postgres log, which was full of `deadlock detected`. Putting `FOR UPDATE` back to re-check it gives **116 deadlocks in 90 seconds**, and the test never finishes.

**Cause:** each transfer starts with `INSERT INTO transfers`, and Postgres's foreign-key checks on that insert take a `FOR KEY SHARE` lock on both account rows. Two transfers touching the same account both hold `KEY SHARE`. Then each asks for `FOR UPDATE`, which conflicts with the other's `KEY SHARE`, so each waits forever on the other. Lock ordering couldn't help, because the conflicting locks were taken before the ordered `SELECT` ever ran.

**Fix:** `FOR NO KEY UPDATE`. It doesn't conflict with `KEY SHARE`, but it still conflicts with itself, so two transfers on the same account still queue up. Result: 0 deadlocks, and 20 out of 20 green runs of the concurrency tests.

**What I took from it:** the precise interleaving test would never have found this. Correct-looking locking code needs a burst of real concurrent load as well as a deterministic test.

### 2. A failing test that was itself wrong

The first run of the rule 1 race test failed against the *correct* implementation. The test checks "did the second transfer reach its balance check while the first one was paused?", but it read that flag after both transfers had finished. By then, the second transfer had legitimately reached its check after the first one committed.

**Fix:** record the flag at the moment the first transfer is released.

**What I took from it:** "the test fails" and "the code is broken" aren't the same claim. It's worth reading what a test actually measured before trusting it in either direction.

### 3. Making sure the race test can fail at all

A concurrency test that always passes might simply never be racing, so its passing proves nothing. I wanted evidence that it can catch the bug:
- **Broken implementations in the test file.** Two transfers that skip the lock are run through the same harness, and the tests assert they *break*. One creates a dollar from nothing (a lost update). The other is only saved by the database's `CHECK (balance_cents >= 0)` backstop.
- **Breaking the real code.** With `FOR NO KEY UPDATE` deleted from `src/ledger/transfer.ts`, the race test fails, because the second transfer is never blocked.

There was also a near-miss. The tool set up that first experiment to "undo" the change with `git checkout src/ledger/transfer.ts`. That would have restored the last *committed* file, which still had the deadlock, and silently thrown away the uncommitted fix. It was stopped before that step ran. Since then, experiments like this restore from a backup copy of the file, never from git.

### 4. A property test that missed an off-by-one

The first randomized (fast-check) test still passed when the funds check was changed to `balance <= amount`. That bug stops anyone from spending their entire balance. Random amounts almost never land exactly on an account's balance, so the one case that matters never came up.

**Fix:** the generator now deliberately sends exactly the whole balance, or one cent more. The broken version now fails every run (3 out of 3).

### 5. A crash hiding behind correct data

One test kills the transfer's own database connection between the debit and the credit. The data was always fine: the transaction rolled back and neither balance moved. But the Postgres driver also raises an `'error'` event when a connection drops. With nothing listening, Node treats that as an uncaught exception, and the CLI died with `ECONNRESET` instead of reporting an error. Removing the fix brings that exact crash back.

**Fix:** listen for connection errors while a transaction holds a connection, and throw away a connection whose rollback failed.

### 6. Floats sneaking into money

- **Typed amounts.** The obvious way to turn `"0.29"` into cents is `Number(text) * 100`, which gives `28.999999999999996`. `Math.round` would hide that case but keep floats in the money path. Instead, `parseAmount` splits the text at the decimal point and builds the cents with BigInt. It refuses anything finer than a cent (`25.555`) rather than rounding it.
- **Big numbers from the database.** The driver returns 64-bit integers as strings. The common advice is `parseInt`, which silently rounds past 2^53. I used a converter that refuses instead, and capped balances at 2^53−1 in the schema. It paid off once: a test helper summed every balance in the database, the total went past 2^53, and the converter threw instead of quietly returning a wrong total. The helper now adds up those totals with BigInt.

## What I checked myself, and what that found

- **"Can you transfer negative money?"** I asked this outright, because a system that accepts a negative transfer pays someone money out of nowhere. I had it try every route through the real command: `-5`, `-0.01`, `-0`, `0`, a Unicode minus `−5`, `+5`, `(5)`, and `-- -5` to get past the argument parser. It also tried inserting a negative transfer straight into the database. Every attempt was refused, by four separate layers: the CLI, the amount parser, the ledger, and the database constraints. Both balances were untouched.
- **A clean clone, like a reviewer would get.** Fresh clone from GitHub, `npm ci`, build, migrate a new database, run the full suite, then use the command. Everything passed.
- **Running the installed command by hand** turned up things the in-process tests hadn't:
  - `move-money open -5` said "Unknown option '-5'". It now says amounts can't be negative.
  - Unknown flags dumped the entire help text. They now get one line.
  - The build left stale compiled files in `dist/`.
  - `transfer … 0` said "amount must be at least 1". That meant one *cent*, but you type dollars. It now says "at least 0.01 (1 cent)".
- **Testing the Docker setup** found a real bug in the instructions. My machine already runs Postgres on port 5432. The documented `docker compose up -d` started the container without complaint, but the documented connection URL then reached my *other* Postgres. It failed only because that server has no `postgres` user. On a machine where it did, the tests would have quietly run against the wrong database. The container now uses port 5433. It also has a health check, so `docker compose up --wait` doesn't return until the database is ready. That check connects over TCP, because during first-time setup the Postgres image runs a temporary local-only server that would otherwise count as "ready" too early. Verified from a fresh volume: migrate, all 106 tests, and a transfer plus a replay through the CLI.

## Decisions I'd like to talk about

- **Why a CLI.** Every rule lives in the ledger and the database, so the interface is deliberately thin. On a command line, the "double-click" is running the same command twice, and `--key` covers that. The cost: every command opens its own small connection pool. That's fine for people and scripts, but not for high volume.
- **`--key` is required, not generated for you.** A generated key would be different every run, so pressing Enter twice would move the money twice, which is exactly what rule 3 forbids.
- **Locking rows vs SERIALIZABLE.** Locking two known rows is simple and needs no retry loop. The cost is that one very busy account processes its transfers one at a time.
- **A failed transfer doesn't use up its key.** If you retry after the account is funded, it goes through. The alternative is to remember failures and replay them. Both are defensible, and I'd want the product's view.
- **A balance column plus a ledger**, rather than only a ledger. Balance reads are fast and there's one row to lock. The tests check after every single test that the two never disagree.
- **Process tests vs the deterministic test.** Twelve CLI processes racing for the same money shows the rules hold across separate processes. But process start-up timing is too noisy to *prove* they overlapped. The test that pauses one transfer and asks Postgres whether the other is blocked is the actual proof.
