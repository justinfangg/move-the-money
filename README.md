# Move the money

`move-money` is a small command-line ledger. Accounts hold a balance in CAD, and money moves between them. Postgres enforces the four rules, and tests that force the dangerous cases prove them.

**Stack:** TypeScript on Node 22, Postgres 17 via `pg`, Vitest, and fast-check. The CLI uses Node's built-in `parseArgs`, with no CLI framework.

## Running it

You need **Node 22+** and a **Postgres** instance. Pick one of these:

```sh
# Option A: Homebrew
brew install postgresql@17 && brew services start postgresql@17
createdb move_money && createdb move_money_test

# Option B: Docker (creates both databases, on port 5433)
docker compose up -d --wait
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/move_money
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/move_money_test
```

The Docker database uses port 5433, so it can run alongside a Postgres you already have on 5432. `--wait` returns once the database is ready. `docker compose down -v` removes it.

Then:

```sh
npm install
npm run build           # compiles to dist/
npm link                # optional: puts `move-money` on your PATH
move-money migrate      # or: npm run db:migrate
```

Without `npm link`, use `./dist/cli.js …`. To run from source with no build step, use `npm run cli -- …`.

Defaults: `DATABASE_URL=postgres://localhost:5432/move_money`, `TEST_DATABASE_URL=postgres://localhost:5432/move_money_test`.

## Using it

```
move-money open <amount> [--key <key>]
move-money balance <account-id>
move-money transfer <from-account-id> <to-account-id> <amount> --key <key>
move-money history <account-id> [--limit <n>]
move-money migrate
```

```console
$ move-money open 100
Opened account 955a48b2-ea09-47ce-95ea-f97ed0c3269b with 100.00 CAD.

$ move-money open 0
Opened account 39fa9724-0e2b-4b44-a3fd-4fe5745fb6d9 with 0.00 CAD.

$ KEY=$(uuidgen)
$ move-money transfer 955a48b2-… 39fa9724-… 25.50 --key $KEY
Transferred 25.50 CAD from 955a48b2-… to 39fa9724-… (transfer aa5aef31-…).

$ move-money transfer 955a48b2-… 39fa9724-… 25.50 --key $KEY      # ran it again by accident
Already applied: transfer aa5aef31-… (25.50 CAD from 955a48b2-… to 39fa9724-…). No money moved this time.

$ move-money transfer 955a48b2-… 39fa9724-… 500 --key $(uuidgen)
error: insufficient funds                                          # exit code 1

$ move-money history 955a48b2-…
when                      kind      amount  balance  counterparty
2026-10-04T02:16:14.295Z  debit     -25.50    74.50  to 39fa9724-…
2026-10-04T02:16:14.178Z  opening  +100.00   100.00
```

- **Amounts** are dollars with at most two decimal places (`25`, `25.5`, `25.50`). Anything that can't be represented exactly in cents is refused, never rounded: `25.555`, `1e3`, `-5`, `$5`, `1,000`.
- **`--key`** is required for `transfer`. Use a fresh key for each transfer you intend, and reuse it if you retry. Running the same command twice, whether from a double Enter, shell history or a retry loop in a script, then moves the money only once. Reusing a key with a different amount or different accounts is refused.
- **`--json`** gives machine-readable output on stdout. Errors go to stderr as `{"error": code, "message"}`.
- **Exit codes:** `0` success · `1` refused (insufficient funds, not found, key conflict, balance limit) · `2` bad usage (including negative or sub-cent amounts) · `3` unexpected error.

## Running the tests

```sh
npm test                # migrates the test DB, then runs everything (~4s)
npm run typecheck
```

The tests use a real Postgres, never mocks, because the guarantees being tested live in the database. Test files run one after another because they share a database. Inside each test, concurrency is real: up to 20 pooled connections with transactions in flight at once, and, in `test/cli-process.test.ts`, separate OS processes running the CLI simultaneously.

## How each rule is enforced and proved

| Rule | How it's enforced | Where it's proved |
|---|---|---|
| **1. Never negative** | Both account rows are locked (`FOR NO KEY UPDATE`, in id order) *before* funds are checked, and the debit happens under the same lock. As a backstop, `CHECK (balance_cents >= 0)` means even an application bug can't commit an overdraft. | `test/concurrency.test.ts`, `test/cli-process.test.ts` |
| **2. All or nothing** | One transaction covers the transfer row, both balance updates and both ledger entries. | `test/atomicity.test.ts` |
| **3. Applied once** | The `transfers.idempotency_key` column is `UNIQUE`. The transfer claims the key with `INSERT … ON CONFLICT DO NOTHING` inside the same transaction. A concurrent duplicate blocks on the unique index until the first one commits, then replays it. | `test/idempotency.test.ts`, `test/cli-process.test.ts` |
| **4. Exact** | Amounts are integer cents in `BIGINT`. Typed amounts are parsed to cents with string and BigInt arithmetic, never floats. `Number("0.29") * 100` is `28.999999999999996`. `int8` values are converted to JS numbers only when exact, and the schema caps balances at 2^53−1. | `test/properties.test.ts`, `test/money.test.ts` |

After **every** test, `assertInvariants()` runs and checks four things:
- No balance is negative.
- Each balance equals the sum of its ledger entries.
- Each transfer is exactly one matching debit and one matching credit.
- Total money held equals total money ever opened.

### The rule 1 test

If you fire two transfers at once and they happen to run one after the other, even a broken implementation passes. So `test/concurrency.test.ts` forces the overlap:

1. Account A holds 100. Transfer X (100 to B) locks the rows, then **pauses inside its transaction** through a test hook, before it checks funds.
2. Transfer Y (100 to C) starts.
3. The test asks Postgres with `pg_blocking_pids()` until it sees **Y waiting on a lock held by X**. That is evidence the two really overlap.
4. X is released. X succeeds. Y then reads the spent balance and is refused for insufficient funds. A ends at 0.

To show the harness can catch the bug, the same race runs against two deliberately naive implementations that lock nothing. The tests assert that these **fail**:
- One writes a balance computed from a stale read. Both transfers "succeed" and 100 cents of money is created, and `assertInvariants` notices.
- The other uses a relative `balance - amount`. Only the `CHECK` constraint stops it from going to −100.

I also deleted the lock clause from the real code and confirmed the main test fails. That run is recorded in [BUILD_LOG.md](BUILD_LOG.md).

Around that test:
- **Load tests** fire 100 simultaneous transfers to drain one account. Exactly ⌊1000/30⌋ = 33 succeed. Opposing A→B / B→A transfers and a 6-account mesh run at once, and must not deadlock.
- **`test/cli-process.test.ts`** runs 12 separate `move-money` processes racing to spend 3.00 in 1.00 pieces. Exactly 3 win. These process tests show the guarantees hold across processes. The deterministic test is the one that *proves* overlap, because process start-up timing can't.

## Design decisions and tradeoffs

- **A CLI over a ledger module.** Every rule lives in `src/ledger/` and the database schema. The CLI only parses arguments, calls the ledger and prints the result, so it has almost nothing that could break a rule. On a CLI, the "double-click" is re-running a command, which `--key` covers. The cost: there's no long-lived process, so every invocation opens its own small connection pool. That's fine for people and scripts, but wrong for high volumes.
- **Postgres** rather than SQLite or in-memory, because the rules are fundamentally about concurrent transactions. Postgres has row-level locks, `CHECK` constraints and unique indexes, so the database holds the line even when application code is wrong. Several CLI processes at once need a real database server anyway. SQLite would serialize all writes, which makes rule 1 trivially true and the test meaningless.
- **Pessimistic row locks at READ COMMITTED, rather than SERIALIZABLE.** A transfer touches exactly two known rows, so locking them is simple, predictable, and needs no retry loop. SERIALIZABLE would also be correct, but every caller would need retry-on-`40001` logic. The cost is that a very hot account serializes its transfers.
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** The `INSERT INTO transfers` FK check takes `KEY SHARE` locks on both accounts. `FOR UPDATE` conflicts with those, so concurrent transfers deadlocked. `NO KEY UPDATE` doesn't conflict with them, but it still conflicts with itself. The full story is in the build log.
- **A balance column plus an append-only ledger**, rather than deriving balances from the ledger. Reading the balance is O(1), and the lock has one obvious row to sit on. The ledger exists for history and for cross-checking. The tests assert that the two never disagree.
- **Integer cents in `BIGINT`, not `NUMERIC` and not floats.** The only operations are add, subtract and compare, and those are exact on integers.
- **The ledger module validates its own input** (amounts, ids, keys) rather than trusting the CLI. Any future caller gets the same checks.
- **The idempotency key lives on the transfer row and commits atomically with it.** No separate idempotency store can get out of sync. A replay returns the original transfer even if the balance has changed since. Reusing a key with a different request is refused rather than silently replayed.
- **`--key` is required, not auto-generated.** An auto-generated key would differ on every run, so re-running the command would move the money twice. That's exactly the failure rule 3 is about.
- **A rejected attempt doesn't consume its key.** The rejection rolls back the key along with everything else. If you retry after the account is funded, the transfer goes through. That suits "retry until it works", but it does mean a retry can succeed where the first attempt failed. The alternative is to store failed outcomes and replay them. It's tested either way, and it's the decision I'd most want to discuss.
- **Keys are global, not per-account.** That's simpler. A collision is treated as a conflict, not a second transfer.

## What went wrong, and how it was caught

The full story, with how to reproduce each failure, is in [BUILD_LOG.md](BUILD_LOG.md). In short:

| What went wrong | How it was caught | Fix |
|---|---|---|
| Locking accounts with `FOR UPDATE` deadlocked under load. The FK check on the transfer insert had already taken `KEY SHARE` locks, and `FOR UPDATE` conflicts with them. | The load tests hung. Postgres logged 116 deadlocks in 90 seconds. | `FOR NO KEY UPDATE`: 0 deadlocks, 20/20 green runs. |
| The race test failed against *correct* code. It checked Y's progress after both transfers had finished. | Reading what the failing test actually measured. | Snapshot the flag at the moment X is released. |
| The property test passed with an off-by-one (`balance <= amount`). | Deliberately introducing that bug and seeing the test stay green. | The generator now also sends exactly the whole balance, or one cent more. |
| The invariant helper summed balances past 2^53. | The strict int8 parser threw instead of rounding. | Compare totals as BigInt. |
| A dropped database connection mid-transfer would have crashed the CLI with an uncaught `ECONNRESET`. No data was harmed. | The atomicity test that kills the connection between the debit and the credit. | Handle client errors in `withTransaction`, and discard the broken connection. |
| `move-money open -5` said "Unknown option", unknown flags dumped the whole help text, and `transfer … 0` said "at least 1" (meaning one cent). | An end-to-end run of the installed command. | Clear one-line errors, with amounts in dollars and cents. |
| With Postgres already on port 5432, the Docker instructions' URL reached the *other* server, not the container. | Actually running the Docker setup. | The container uses port 5433, plus a health check behind `up --wait`. |

I also checked that the tests can fail. With the lock deleted from the real code, the race test fails. Two deliberately broken transfers in the test file are asserted to break.

## What I chose not to build

- Authentication, users, ownership of accounts.
- Multiple currencies or FX. Everything is CAD.
- Deposits and withdrawals from outside the system. Money only enters through opening balances.
- Recording failed transfer attempts, and expiring idempotency keys (they currently live forever).
- Pagination beyond `--limit` on history.
- An ORM or migration framework. There's one SQL file and a ~50-line runner.

## What I'd do next

1. **Hot-account contention.** Every transfer from one account serializes on its row. For a payroll-style account, that's the throughput ceiling. Options: queue the debits, use sub-ledgers or "bucket" rows, or do optimistic checks with a conditional `UPDATE … WHERE balance >= amount`. I'd measure before choosing.
2. **Idempotency hygiene.** Scope keys per client, set a TTL with cleanup, and optionally store failed outcomes so replays are identical in every case.
3. **An outbox table**, written in the same transaction, so other systems learn about transfers exactly once.
4. **A reconciliation command** (`move-money verify`) that runs the `assertInvariants` checks against real data and exits non-zero on any drift.
5. **Timeouts:** `lock_timeout` and `statement_timeout`, so a stuck process can't hold a lock indefinitely.
6. **A long-running service** in front of the same ledger module, if this needed to serve many clients at once instead of one command at a time.

## Layout

```
db/migrations/001_init.sql   schema and the CHECK/UNIQUE backstops
src/cli.ts                   the move-money command
src/money.ts                 amount parsing/formatting, exact to the cent
src/validate.ts              id and idempotency-key validation
src/ledger/transfer.ts       the transfer transaction
src/ledger/accounts.ts       open account, balance, history
src/db/pool.ts               pool, int8 parser, withTransaction
test/helpers.ts              assertInvariants()
test/concurrency.test.ts     rule 1 (the forced race, and load)
test/cli-process.test.ts     rules 1 and 3 across separate CLI processes
test/atomicity.test.ts       rule 2
test/idempotency.test.ts     rule 3
test/properties.test.ts      rule 4 (property-based) and edge amounts
test/cli.test.ts             CLI behaviour, output and exit codes
```
