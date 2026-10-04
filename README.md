# Move the money

This is a small ledger service. Accounts hold a balance in CAD cents, and money moves between them through an HTTP API. Postgres enforces the four rules, and tests that force the dangerous cases prove them.

**Stack:** TypeScript on Node 22, Fastify, Postgres 17 via `pg`, Vitest, and fast-check.

## Running it

You need **Node 22+**. The strict JSON parsing relies on `JSON.parse` source-text access, which Node 22 has. You also need a **Postgres** instance. Pick one of these:

```sh
# Option A: Homebrew
brew install postgresql@17 && brew services start postgresql@17
createdb move_money && createdb move_money_test

# Option B: Docker (creates both databases)
docker compose up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/move_money
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/move_money_test
```

Then:

```sh
npm install
npm run db:migrate      # applies db/migrations/*.sql to DATABASE_URL
npm start               # http://127.0.0.1:3000  (PORT to override)
```

Defaults: `DATABASE_URL=postgres://localhost:5432/move_money`, `TEST_DATABASE_URL=postgres://localhost:5432/move_money_test`.

## Running the tests

```sh
npm test                # migrates the test DB, then runs everything (~3s)
npm run typecheck
```

The tests use a real Postgres, never mocks, because the guarantees being tested live in the database. Test files run one after another because they share a database. Inside each test, concurrency is real: multiple pooled connections, plus real HTTP requests against a listening server.

## API

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/accounts` | `{"initial_balance_cents": 10000}`. The `Idempotency-Key` header is optional. |
| `GET` | `/accounts/:id` | Balance |
| `GET` | `/accounts/:id/transactions?limit=100` | Ledger entries, newest first |
| `POST` | `/transfers` | `{"from_account_id", "to_account_id", "amount_cents"}`. The `Idempotency-Key` header is **required**. |
| `GET` | `/transfers/:id` | |

```sh
A=$(curl -s -XPOST localhost:3000/accounts -H 'content-type: application/json' \
      -d '{"initial_balance_cents": 10000}' | jq -r .id)
B=$(curl -s -XPOST localhost:3000/accounts -H 'content-type: application/json' \
      -d '{"initial_balance_cents": 0}' | jq -r .id)

curl -s -XPOST localhost:3000/transfers -H 'content-type: application/json' \
     -H 'idempotency-key: 7f1c…' \
     -d "{\"from_account_id\":\"$A\",\"to_account_id\":\"$B\",\"amount_cents\":2550}"

curl -s localhost:3000/accounts/$A                 # {"balance_cents":7450,...}
curl -s localhost:3000/accounts/$B/transactions
```

Responses:

- A new transfer returns `201`.
- A replay of the same key and body returns `200` with the header `Idempotent-Replay: true`.
- Errors return `{"error": code, "message"}`, with these codes:
  - `400 invalid_request`
  - `404 not_found`
  - `409 idempotency_key_conflict`
  - `422 insufficient_funds`
  - `422 balance_limit_exceeded`

## How each rule is enforced and proved

| Rule | How it's enforced | Where it's proved |
|---|---|---|
| **1. Never negative** | Both account rows are locked (`FOR NO KEY UPDATE`, in id order) *before* funds are checked, and the debit happens under the same lock. As a backstop, `CHECK (balance_cents >= 0)` means even an application bug can't commit an overdraft. | `test/concurrency.test.ts` |
| **2. All or nothing** | One transaction covers the transfer row, both balance updates and both ledger entries. | `test/atomicity.test.ts` |
| **3. Applied once** | The `transfers.idempotency_key` column is `UNIQUE`. The transfer claims the key with `INSERT … ON CONFLICT DO NOTHING` inside the same transaction. A concurrent duplicate blocks on the unique index until the first one commits, then replays it. | `test/idempotency.test.ts` |
| **4. Exact** | Amounts are integer cents in `BIGINT`. The request JSON is checked *before* `JSON.parse` rounds anything, so `10.5`, `1e2` and `100.000000000000001` are all rejected. `int8` values are converted to JS numbers only when exact, and the schema caps balances at 2^53−1. | `test/properties.test.ts`, `test/money.test.ts` |

After **every** test, `assertInvariants()` runs and checks four things:
- No balance is negative.
- Each balance equals the sum of its ledger entries.
- Each transfer is exactly one matching debit and one matching credit.
- Total money held equals total money ever opened.

### The rule 1 test

If you fire two requests at once and they happen to run one after the other, even a broken implementation passes. So `test/concurrency.test.ts` forces the overlap:

1. Account A holds 100. Transfer X (100 to B) locks the rows, then **pauses inside its transaction** through a test hook, before it checks funds.
2. Transfer Y (100 to C) starts.
3. The test asks Postgres with `pg_blocking_pids()` until it sees **Y waiting on a lock held by X**. That is evidence the two really overlap.
4. X is released. X succeeds. Y then reads the spent balance and gets `insufficient_funds`. A ends at 0.

To show the harness can catch the bug, the same race runs against two deliberately naive implementations that lock nothing. The tests assert that these **fail**:
- One writes a balance computed from a stale read. Both transfers "succeed" and 100 cents of money is created, and `assertInvariants` notices.
- The other uses a relative `balance - amount`. Only the `CHECK` constraint stops it from going to −100.

I also deleted the lock clause from the real code and confirmed the main test fails. That run is recorded in [BUILD_LOG.md](BUILD_LOG.md).

The same file also has load tests over real HTTP:
- 100 simultaneous transfers drain one account. Exactly ⌊1000/30⌋ = 33 succeed.
- Opposing A→B and B→A transfers run at once.
- A 6-account mesh of transfers runs at once.

None of these may deadlock or return a 500.

## Design decisions and tradeoffs

- **Postgres** rather than SQLite or in-memory, because the rules are fundamentally about concurrent transactions. Postgres has row-level locks, `CHECK` constraints and unique indexes, so the database holds the line even when application code is wrong. SQLite would serialize all writes, which makes rule 1 trivially true and the test meaningless. The cost is that running the project needs a Postgres instance.
- **Pessimistic row locks at READ COMMITTED, rather than SERIALIZABLE.** A transfer touches exactly two known rows, so locking them is simple, predictable, and needs no retry loop. SERIALIZABLE would also be correct, but every caller would need retry-on-`40001` logic. The cost is that a very hot account serializes its transfers. See "What I'd do next".
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** The `INSERT INTO transfers` FK check takes `KEY SHARE` locks on both accounts. `FOR UPDATE` conflicts with those, so concurrent transfers deadlocked. `NO KEY UPDATE` doesn't conflict with them, but it still conflicts with itself. The full story is in the build log.
- **A balance column plus an append-only ledger**, rather than deriving balances from the ledger. Reading the balance is O(1), and the lock has one obvious row to sit on. The ledger exists for history and for cross-checking. The tests assert that the two never disagree.
- **Integer cents in `BIGINT`, not `NUMERIC` and not floats.** The only operations are add, subtract and compare, and those are exact on integers. The API takes integers only. A string like `"10.00"` is rejected rather than interpreted, because the client should say exactly what it means.
- **The idempotency key lives on the transfer row and commits atomically with it.** No separate idempotency store can get out of sync. A replay returns the original transfer even if the balance has changed since. Reusing a key with a different body returns `409` rather than silently returning the old transfer.
- **A rejected attempt doesn't consume its key.** The rejection rolls back the key along with everything else. If a client retries after the account is funded, the transfer goes through. That suits "retry until it works", but it does mean a retry can succeed where the first attempt failed. The alternative is to store failed outcomes and replay them, which suits "never surprise me". It's tested either way, and it's the decision I'd most want to discuss with the product team.
- **Keys are global, not per-account.** That's simpler. A collision between two clients is treated as a conflict, not a second transfer.

## What I chose not to build

- Authentication, users, ownership of accounts, signup.
- Multiple currencies or FX. The `currency` field is always `CAD`.
- Deposits and withdrawals from outside the system. Money only enters through opening balances.
- Recording failed transfer attempts, and expiring idempotency keys (they currently live forever).
- Cursor pagination on history. It only has `limit`.
- Deployment, metrics, structured request logging beyond Fastify's default, and rate limiting.
- An ORM or migration framework. There's one SQL file and a ~50-line runner.

## What I'd do next

1. **Hot-account contention.** Every transfer from one account serializes on its row. For a payroll-style account, that's the throughput ceiling. Options: queue the debits, use sub-ledgers or "bucket" rows, or do optimistic checks with a conditional `UPDATE … WHERE balance >= amount`. I'd measure before choosing.
2. **Idempotency hygiene.** Scope keys per client, set a TTL with cleanup, and optionally store failed outcomes so replays are byte-for-byte identical in every case.
3. **An outbox table**, written in the same transaction, so other systems learn about transfers exactly once.
4. **A reconciliation job** that runs the `assertInvariants` checks against production data on a schedule and alerts on any drift.
5. **A transfer state machine** (`pending → posted / failed`) for flows that leave the ledger, such as card networks or EFT. There, "all or nothing" spans more than one database.
6. A sustained load test (k6) rather than burst tests, plus timeouts: `lock_timeout` and `statement_timeout` so a stuck transaction can't hold a lock indefinitely.

## Layout

```
db/migrations/001_init.sql   schema and the CHECK/UNIQUE backstops
src/money.ts                 strict JSON parsing and amount validation
src/ledger/transfer.ts       the transfer transaction
src/ledger/accounts.ts       open account, balance, history
src/db/pool.ts               pool, int8 parser, withTransaction
src/routes/*                 HTTP layer
test/helpers.ts              assertInvariants()
test/concurrency.test.ts     rule 1
test/atomicity.test.ts       rule 2
test/idempotency.test.ts     rule 3
test/properties.test.ts      rule 4 (property-based) and edge amounts
```
