# Build log

## What I set out to do

Build the smallest thing that provably keeps the four rules, and put the effort into the proof rather than features. Concretely, I wanted:
- every rule enforced by Postgres itself, not just by application code;
- a rule 1 test that *forces* two transfers to overlap, rather than hoping they do;
- evidence that each test can actually fail.

I built it with Claude Code. I made the calls on stack, interface, scope and what counted as done, and the tool wrote most of the code.

## Where AI genuinely helped

- **Diagnosing the deadlock** (below). It read the Postgres deadlock log and traced the cause to the foreign-key check's `KEY SHARE` lock. That was Postgres knowledge I'd have taken much longer to find on my own.
- **The rule 1 test design.** One transfer pauses inside its transaction, and Postgres's `pg_blocking_pids()` confirms the second is blocked behind it before the first is released. It also suggested putting deliberately broken transfers through the same test, to show the test catches what it claims to.
- **Breadth.** Property-based tests against an exact BigInt model, a test that kills the database connection mid-transfer, and a check of every invariant after every test. That's more coverage than I'd have written alone in the time.

## Where it was confidently wrong, and how I caught it

1. **The "textbook" lock deadlocked.** It locked both accounts with `FOR UPDATE` in id order, which is the standard answer. Under 100 concurrent transfers it deadlocked: re-running it gives 116 deadlocks in 90 seconds. **Caught by** the load test hanging. **Fix:** `FOR NO KEY UPDATE`, which gives 0 deadlocks and 20/20 green runs. The precise interleaving test alone would never have found this.
2. **A test that passed against a bug.** Its first property test still passed with `balance <= amount`, an off-by-one that blocks spending your whole balance. **Caught by** deliberately breaking the code to see whether the test noticed. The generator now hits exact balances.
3. **A test that failed against correct code.** The race test read a flag after both transfers had finished, so it reported a race that hadn't happened. **Caught by** reading what the test actually measured.
4. **A destructive "undo".** To revert an experiment, it ran `git checkout` on the file. That would have thrown away the uncommitted deadlock fix. It was stopped before it ran.
5. **Docker instructions that pointed at the wrong database.** With Postgres already on port 5432, the documented URL reached my local server instead of the container. **Caught by** actually running the Docker setup rather than trusting it. It now uses port 5433.

Testing the CLI by hand also caught smaller things the tests hadn't: `-5` reported as "unknown option", and "at least 1" when it meant one cent.

## What it suggested that I rejected

- **SQLite for storage.** It recommended SQLite for zero setup. I chose Postgres. SQLite serializes all writes, so rule 1 would hold trivially, and the concurrency test would prove nothing about locking. Postgres also lets the database enforce the rules itself (`CHECK`, `UNIQUE`, row locks), so a bug in my code can't commit a negative balance.

## What I shipped that I'm not comfortable with

- **No ownership.** Anyone with an account ID can move money out of it. Authentication was out of scope, but a real system can't work this way.
- **The tests wipe their database.** Each test runs `TRUNCATE` on its tables. If `TEST_DATABASE_URL` pointed at real data, the tests would delete it. There is no guard against that.
- **Failed transfers don't use up their idempotency key.** A retry after the account is funded succeeds. That's tested and deliberate, but a client might expect "retry" to give the original answer.
- **Keys never expire, and there's no `lock_timeout`.** A process that hangs mid-transfer holds its row locks until the connection dies.
