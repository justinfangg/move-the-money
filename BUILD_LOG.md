# Build log

<!--
  DRAFT. This was written during the build as a factual record of what happened.
  Rewrite it in your own voice before submitting: what you noticed, what you
  pushed back on, and what you'd want to be asked about.
-->

This was built with an AI coding assistant, Claude Code. The commit history is the real sequence of work, including a commit whose load tests were known to deadlock and the fix that followed it. The list below covers where a tool, a framework default or a first draft pointed the wrong way, and how each one was caught.

## Where things went wrong, or nearly did

### 1. `FOR UPDATE` deadlocked under load (`546522f` → `7b1ecf2`)

The first version of the transfer locked both accounts with `SELECT … ORDER BY id FOR UPDATE`. That's the textbook answer, and locking in id order is the textbook deadlock prevention. The deterministic race test passed. The HTTP load tests hung.

The Postgres log showed **167 `deadlock detected` errors**, each one costing about 1s of `deadlock_timeout`. Here's the cause. The transfer first runs `INSERT INTO transfers`, and the foreign-key checks on that insert take `FOR KEY SHARE` on both account rows. Two transfers on the same account both get `KEY SHARE`, since those don't conflict. Then each one asks for `FOR UPDATE`, which *does* conflict with the other's `KEY SHARE`. Each waits on the other. Ordering the `FOR UPDATE` didn't help, because the conflicting locks were already held.

The fix was `FOR NO KEY UPDATE`. It is compatible with `KEY SHARE` but still conflicts with itself, so transfers still serialize per account. It's also the lock a plain `UPDATE` takes anyway.

Lesson: the deterministic test alone wouldn't have caught this. The burst tests did.

### 2. The race-test harness had its own bug

The first run of the deterministic test failed with the *correct* implementation. The flag "did Y reach its read while X was paused?" was checked after both transactions had finished. By then, Y had legitimately reached its read *after* X committed. The fix was to snapshot the flag at the moment X is released.

Lesson: a test that fails isn't necessarily a test that's right. It's worth reading what it actually measured.

### 3. Proving the race test can fail

A concurrency test that always passes might simply never be racing. So I checked it two ways:
- **Control implementations in the test file.** Two lockless transfers run through the same harness, and the tests assert they *break*. One creates 100 cents from nothing through a lost update. The other is only stopped by the `CHECK` constraint.
- **A mutation of the real code.** I deleted `FOR NO KEY UPDATE` from `src/ledger/transfer.ts` and ran the race test. It failed: Y was never blocked by X. Then I restored the line.

During that mutation run, the command was set up to finish with `git checkout src/ledger/transfer.ts` to undo the mutation. That would have reverted to the *committed* file, which still had the `FOR UPDATE` deadlock, and thrown away the uncommitted fix. The run was stopped before that step executed, and the line was restored by hand. Later mutation checks used a backup copy instead.

### 4. The property test passed against an off-by-one

The first fast-check property test still passed when I changed the funds check to `balance <= amount`, which wrongly refuses to let anyone spend their whole balance. Random amounts almost never equal a balance exactly. The generator now sometimes sends exactly the whole balance, or one cent more. The mutant then failed every run (3/3).

### 5. Framework defaults that quietly change money input

These were found while the project was still an HTTP API. The API has since been replaced by a CLI (see 8), but the code and tests for these fixes are in the history.

- **`JSON.parse` rounds before you can validate.** `JSON.parse("100.000000000000001")` is exactly `100`, and `9007199254740993` becomes `…992`. No check on the parsed value can see that. The fix uses the reviver's `context.source` (Node 22+) to reject any number literal that isn't a plain integer.
- **Fastify's Ajv uses `coerceTypes`.** Declaring `amount_cents: {type: "integer"}` would quietly accept `"100"`. Amount fields are left untyped in the schema and validated by `requireCents`.
- **Fastify's Ajv uses `removeAdditional`.** `{"initial_balance_cents": 1, "bonus": 1}` was accepted, with `bonus` silently dropped. A test caught it. That option is now off.
- **`pg` returns `BIGINT` as a string.** The usual advice is to install a parser that does `parseInt`. Instead, the parser throws if the value isn't a safe integer, and the schema caps balances at 2^53−1, so the case can't occur in practice.

### 6. The int8 parser caught my own test helper

The property tests generate balances near 2^53. Each balance fits, but `SUM(balance_cents)` across accounts in the invariant helper didn't. The parser threw instead of returning a rounded total, which is exactly why it throws. The helper now compares totals as BigInt.

### 7. A dropped connection would have crashed the server

The atomicity test kills the transfer's own Postgres backend between the debit and the credit. The data was fine: nothing committed. But `pg` emits an `'error'` event on a client whose connection drops. With no listener, Node treats that as an uncaught exception and the process exits. `withTransaction` now listens while it holds a client and discards the client if `ROLLBACK` fails. The pool also has an idle-error handler.

### 8. Switching from an HTTP API to a CLI (`ab8ffb1` → `f9263ed`)

After the API was finished, I decided a CLI was a better fit for the brief. I did the switch in steps so the tests stayed green throughout:
1. Move all input validation into the ledger functions. Until then, only the HTTP schemas checked amounts, ids and keys. Removing the HTTP layer without this step would have left the ledger accepting anything.
2. Add the CLI alongside the API.
3. Port the HTTP-based tests to call the ledger directly, and add tests that race real CLI processes.
4. Delete the API.

Things that came up along the way:
- **Parsing typed dollars.** The obvious `Math.round(Number(text) * 100)` is wrong, because `Number("0.29") * 100` is `28.999999999999996`. Rounding hides that particular case but not the general problem. `parseAmount` splits the string and uses BigInt, and refuses more than two decimal places instead of rounding them.
- **`--key` is required for `transfer`.** An auto-generated key would be different on every run, so pressing Enter twice would move the money twice. That's exactly the failure rule 3 describes.
- **Process tests vs. the deterministic test.** Spawning 12 CLI processes at once shows the guarantees hold across processes. It can't prove they overlapped in the database, because process start-up jitter is in the tens of milliseconds. The `pg_blocking_pids` test is still the proof. The process test is supporting evidence.

## Decisions I'd want to talk about

- **CLI vs HTTP API.** The ledger doesn't care which one sits in front of it, and the history has both.
- **Pessimistic locks vs SERIALIZABLE**, and what happens to a hot account. See the README.
- **Whether a failed attempt should burn its idempotency key.** Currently it doesn't. A retry after funding succeeds.
- **A balance column plus a ledger, vs a ledger only.** The tests treat their agreement as an invariant.
