# Build log

<!--
  DRAFT. This was written during the build as a factual record of what happened.
  Rewrite it in your own voice before submitting: what you noticed, what you
  pushed back on, and what you'd want to be asked about.
-->

This was built with an AI coding assistant, Claude Code. Below is what went wrong, or nearly did, and how each problem was caught and fixed. The numbers in this log come from re-running each experiment against the final code. Every one of the failures below can be reproduced by making the one-line change described.

## The approach

Every guarantee lives in the ledger module (`src/ledger/`) and in the database schema. The `move-money` CLI only parses arguments, calls the ledger and prints the result. So the tests that matter exercise the ledger directly with real concurrent transactions, and a smaller set runs the real CLI as separate processes.

## What went wrong, and how it was caught

### 1. `FOR UPDATE` deadlocked under load

The first version of the transfer locked both accounts with `SELECT … ORDER BY id FOR UPDATE`. That's the textbook answer, and locking in id order is the textbook deadlock prevention. The deterministic race test passed. The load tests hung: 100 transfers at once, 20 database connections, all draining one account.

**How it was caught:** the Postgres log was full of `deadlock detected`. When I put `FOR UPDATE` back to re-check it for this log, the load tests produced **116 deadlocks in 90 seconds** and never finished. Each one costs about 1s of `deadlock_timeout` before Postgres kills one side.

**Why:** a transfer first runs `INSERT INTO transfers`, and the foreign-key checks on that insert take `FOR KEY SHARE` locks on both account rows. Two transfers on the same account both get `KEY SHARE`, since those locks don't conflict. Then each one asks for `FOR UPDATE`, which *does* conflict with the other's `KEY SHARE`. Each waits on the other. Ordering the `FOR UPDATE` didn't help, because the conflicting locks were already held before it ran.

**Fix:** `FOR NO KEY UPDATE`. It is compatible with `KEY SHARE`, but it still conflicts with itself, so transfers on the same account still queue up one at a time. It's also the lock a plain `UPDATE` takes anyway. Afterwards: 0 deadlocks, and 20/20 green runs of the concurrency tests.

**Lesson:** the deterministic test alone would never have found this. It needed a burst of real concurrent transfers.

### 2. The race test had its own bug

The first run of the deterministic race test failed with the *correct* implementation. The test asks "did Y reach its balance check while X was paused?", but the flag was checked after both transactions had finished. By then, Y had legitimately reached its check *after* X committed.

**Fix:** snapshot the flag at the moment X is released.

**Lesson:** a failing test isn't automatically a correct test. It's worth reading what it actually measured.

### 3. Proving the race test can actually fail

A concurrency test that always passes might simply never be racing. So I checked it two ways:
- **Control implementations in the test file.** Two lockless transfers run through the same harness, and the tests assert they *break*. One creates 100 cents from nothing through a lost update. The other is only stopped by the `CHECK (balance_cents >= 0)` constraint.
- **A mutation of the real code.** I deleted `FOR NO KEY UPDATE` from `src/ledger/transfer.ts`. The race test fails: Y is never blocked by X. Then I restored the line.

There was a near-miss. The first mutation run was set up to finish with `git checkout src/ledger/transfer.ts` to undo the change. That would have reverted to the last *committed* version, which still had the `FOR UPDATE` deadlock, and silently thrown away the uncommitted fix. The run was stopped before that step executed. Since then, every mutation check restores from a backup copy of the file, never from git.

### 4. The property test passed against an off-by-one

The first fast-check property test still passed when I changed the funds check to `balance <= amount`, which wrongly refuses to let anyone spend their whole balance. Random amounts almost never equal a balance exactly, so the bug's only trigger never came up.

**Fix:** the generator now sometimes sends exactly the whole balance, or one cent more. The mutant fails every run (3/3 on re-check).

### 5. The int8 parser caught my own test helper

`pg` returns `BIGINT` as a string. Instead of the usual `parseInt` parser, mine throws if a value isn't exactly representable as a JS number. The schema caps balances at 2^53−1 so this can't happen to a balance. The property tests generate balances near that cap, though. Each balance fits, but the invariant helper's `SUM(balance_cents)` across all accounts didn't. The parser threw instead of returning a rounded total, which is exactly why it throws. The helper now compares totals as BigInt.

### 6. A dropped database connection would have crashed the CLI mid-transfer

The atomicity tests kill the transfer's own Postgres connection between the debit and the credit. The data was fine: nothing committed, and both balances were untouched. But `pg` also emits an `'error'` event on a client whose connection drops. With no listener, Node treats that as an uncaught exception and the process dies with `ECONNRESET` instead of reporting an error. Re-checked by removing the fix: the test run reports exactly that unhandled `ECONNRESET`.

**Fix:** `withTransaction` listens for errors while it holds a client, and discards the client if `ROLLBACK` fails. The pool also has an idle-error handler.

### 7. Turning typed dollars into cents

The obvious `Number(text) * 100` is wrong: `Number("0.29") * 100` is `28.999999999999996`. Wrapping it in `Math.round` hides that particular case but keeps floats in the money path.

**Fix:** `parseAmount` splits the string at the decimal point and builds the cents with BigInt. It refuses more than two decimal places instead of rounding (`25.555`, `0.001`). It also refuses anything that isn't a plain number: `1e3`, `$5`, `1,000`, `.5`.

### 8. What the end-to-end run of the real command found

Running the installed `move-money` command by hand, through every command and error path, turned up three things the in-process tests hadn't:
- `move-money open -5` reported `Unknown option '-5'`. That's correct from the argument parser's point of view, but what the user typed was a negative amount. It now says `amounts can't be negative`.
- An unknown flag printed the entire help text. It now prints one line and points to `--help`.
- `npm run build` didn't clear `dist/`, so deleted source files left stale compiled files behind. The build now starts from an empty `dist/`.

## Design decisions I'd want to talk about

- **Why a CLI.** Every rule is enforced in the ledger module and the database, so the interface is deliberately thin. On a CLI, the "double-click" is re-running a command, which `--key` covers. The cost: each invocation opens its own small connection pool, which suits people and scripts but not high volume.
- **`--key` is required, not auto-generated.** An auto-generated key would differ on every run, so pressing Enter twice would move the money twice. That's exactly what rule 3 forbids.
- **Pessimistic locks vs SERIALIZABLE**, and what happens to a very busy account. See the README.
- **Whether a failed attempt should use up its idempotency key.** Currently it doesn't. A retry after the account is funded succeeds.
- **A balance column plus a ledger, vs a ledger only.** The tests treat their agreement as an invariant after every test.
- **The process tests vs the deterministic test.** Spawning 12 CLI processes at once shows the guarantees hold across processes. It can't prove they overlapped in the database, because process start-up jitter is in the tens of milliseconds. The `pg_blocking_pids` test is the proof, and the process test is supporting evidence.
