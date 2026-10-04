import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { InsufficientFundsError } from "../src/errors.js";
import { getAccount, openAccount } from "../src/ledger/accounts.js";
import { transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Rule 1: an account's balance can never go negative, including when two
 * transfers compete for the same money at the same moment.
 *
 * Firing two requests with Promise.all and checking the result is not proof:
 * if they happen to run one after the other, a broken implementation passes
 * too. So the main test *forces* the dangerous interleaving:
 *
 *   X: lock rows ─ read balance (100) ─ ── paused ── ── ── ── ── debit ─ commit
 *   Y:                                   start ─ [blocked on X's lock] ─ ─ ─ ─ read balance (0) ─ reject
 *
 * X stops inside its transaction after it has locked the rows and *before* it
 * has checked funds or debited. Y starts while X is stopped. The test then
 * asks Postgres (pg_blocking_pids) whether Y is waiting on X, which proves
 * the two transactions really overlapped. Only then is X let go.
 *
 * To show the harness can actually catch the bug, the same race runs against
 * two deliberately broken implementations, and the tests assert that they
 * *fail* in the expected way.
 */

const pool = makeTestPool(20);

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

async function newAccount(balanceCents: number): Promise<string> {
  return (await openAccount(pool, { initialBalanceCents: balanceCents })).value.id;
}

async function balanceOf(id: string): Promise<number> {
  return (await getAccount(pool, id)).balance_cents;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]!.pid;
}

/** Resolves true once some other backend is waiting on a lock held by `pid`. */
async function isSomethingBlockedBy(pid: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [
    pid,
  ]);
  return rows.length > 0;
}

/**
 * A transfer implementation under test. `pause` must be called at the point
 * where the implementation has read whatever it will base its funds check on,
 * but before it has checked or written anything.
 */
type TransferImpl = (
  args: { from: string; to: string; amountCents: number; key: string },
  pause: (client: pg.PoolClient) => Promise<void>,
) => Promise<unknown>;

const realTransfer: TransferImpl = ({ from, to, amountCents, key }, pause) =>
  transfer(pool, { fromAccountId: from, toAccountId: to, amountCents, idempotencyKey: key }, { afterLock: pause });

interface RaceOutcome {
  x: PromiseSettledResult<unknown>;
  y: PromiseSettledResult<unknown>;
  /** Y was observed waiting on a lock held by X while X was paused. */
  yWaitedForX: boolean;
  /** Y got all the way to its own pause point while X was paused. */
  yReadWhileXPaused: boolean;
}

/**
 * Two transfers of 100 out of the same account, forced to overlap: X stops
 * at its pause point, then Y is started. We wait until Y is either blocked
 * behind X or has done its own read, and only then release X.
 */
async function raceForTheSameMoney(
  impl: TransferImpl,
  a: string,
  b: string,
  c: string,
): Promise<RaceOutcome> {
  const xPaused = deferred<number>();
  const releaseX = deferred();
  const x = impl({ from: a, to: b, amountCents: 100, key: "x" }, async (client) => {
    xPaused.resolve(await backendPid(client));
    await releaseX.promise;
  });
  const xSettled = Promise.allSettled([x]);
  const xPid = await Promise.race([xPaused.promise, xSettled.then(() => null)]);
  if (xPid === null) throw new Error("X finished without reaching its pause point");

  let yReachedPause = false;
  const y = impl({ from: a, to: c, amountCents: 100, key: "y" }, async () => {
    yReachedPause = true;
  });
  let ySettled = false;
  const yResult = Promise.allSettled([y]).then(([r]) => {
    ySettled = true;
    return r!;
  });

  let yWaitedForX = false;
  const deadline = Date.now() + 5_000;
  while (!yWaitedForX && !ySettled && !yReachedPause) {
    if (Date.now() > deadline) throw new Error("Y neither blocked nor progressed within 5s");
    yWaitedForX = await isSomethingBlockedBy(xPid);
    if (!yWaitedForX) await new Promise((r) => setTimeout(r, 5));
  }
  // Settle the race between "Y is blocked" and "Y slipped through": if Y
  // is not blocked, give it a moment to finish so the outcome is clear.
  if (!yWaitedForX) await Promise.race([yResult, new Promise((r) => setTimeout(r, 200))]);

  // Snapshot *before* releasing X: once X commits, Y is expected to proceed
  // and reach its pause point legitimately.
  const yReadWhileXPaused = yReachedPause;
  releaseX.resolve();
  const [[xr], yr] = await Promise.all([xSettled, yResult]);
  return { x: xr!, y: yr, yWaitedForX, yReadWhileXPaused };
}

describe("rule 1: two transfers competing for the same money", () => {
  it("the second transfer waits for the first, then sees the spent balance and is rejected", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const c = await newAccount(0);

    const outcome = await raceForTheSameMoney(realTransfer, a, b, c);

    // The two transactions really did overlap: Y was stuck behind X's lock
    // and never got to read the balance until X was done.
    expect(outcome.yWaitedForX).toBe(true);
    expect(outcome.yReadWhileXPaused).toBe(false);

    expect(outcome.x.status).toBe("fulfilled");
    expect(outcome.y.status).toBe("rejected");
    expect((outcome.y as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);

    expect(await balanceOf(a)).toBe(0);
    expect(await balanceOf(b)).toBe(100);
    expect(await balanceOf(c)).toBe(0);
  });

  describe("the harness catches broken implementations", () => {
    // Both of these read the balance without locking it, which is the
    // classic check-then-act race.

    it("control: unlocked read + absolute write => lost update creates money", async () => {
      const naive: TransferImpl = ({ from, to, amountCents, key }, pause) =>
        withTransaction(pool, async (client) => {
          const t = await client.query<{ id: string }>(
            "INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents) VALUES ($1, $2, $3, $4) RETURNING id",
            [key, from, to, amountCents],
          );
          const { rows } = await client.query<{ balance_cents: number }>(
            "SELECT balance_cents FROM accounts WHERE id = $1",
            [from],
          );
          await pause(client);
          const balance = rows[0]!.balance_cents;
          if (balance < amountCents) throw new InsufficientFundsError();
          // BUG: writes a value computed from a stale read.
          await client.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [balance - amountCents, from]);
          await client.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
            amountCents,
            to,
          ]);
          await client.query(
            `INSERT INTO ledger_entries (account_id, transfer_id, kind, amount_cents, balance_after_cents)
             VALUES ($1, $3, 'debit', $4, $5), ($2, $3, 'credit', $6, $6)`,
            [from, to, t.rows[0]!.id, -amountCents, balance - amountCents, amountCents],
          );
        });

      const a = await newAccount(100);
      const b = await newAccount(0);
      const c = await newAccount(0);
      const outcome = await raceForTheSameMoney(naive, a, b, c);

      // Nothing stopped Y; both read 100, both "succeeded".
      expect(outcome.yWaitedForX).toBe(false);
      expect(outcome.yReadWhileXPaused).toBe(true);
      expect(outcome.x.status).toBe("fulfilled");
      expect(outcome.y.status).toBe("fulfilled");
      // 100 went in; 200 came out. The invariant check must notice.
      expect((await balanceOf(b)) + (await balanceOf(c))).toBe(200);
      await expect(assertInvariants(pool)).rejects.toThrow();

      await resetDb(pool); // leave a clean slate for afterEach
    });

    it("control: unlocked read + relative write => the CHECK constraint is the only thing that saves it", async () => {
      const naive: TransferImpl = ({ from, to, amountCents, key }, pause) =>
        withTransaction(pool, async (client) => {
          const t = await client.query<{ id: string }>(
            "INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents) VALUES ($1, $2, $3, $4) RETURNING id",
            [key, from, to, amountCents],
          );
          const { rows } = await client.query<{ balance_cents: number }>(
            "SELECT balance_cents FROM accounts WHERE id = $1",
            [from],
          );
          await pause(client);
          if (rows[0]!.balance_cents < amountCents) throw new InsufficientFundsError();
          const debited = await client.query<{ balance_cents: number }>(
            "UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2 RETURNING balance_cents",
            [amountCents, from],
          );
          const credited = await client.query<{ balance_cents: number }>(
            "UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2 RETURNING balance_cents",
            [amountCents, to],
          );
          await client.query(
            `INSERT INTO ledger_entries (account_id, transfer_id, kind, amount_cents, balance_after_cents)
             VALUES ($1, $3, 'debit', $4, $5), ($2, $3, 'credit', $6, $7)`,
            [
              from,
              to,
              t.rows[0]!.id,
              -amountCents,
              debited.rows[0]!.balance_cents,
              amountCents,
              credited.rows[0]!.balance_cents,
            ],
          );
        });

      const a = await newAccount(100);
      const b = await newAccount(0);
      const c = await newAccount(0);
      const outcome = await raceForTheSameMoney(naive, a, b, c);

      // Both passed the funds check against a balance of 100...
      expect(outcome.yReadWhileXPaused).toBe(true);
      expect(outcome.y.status).toBe("fulfilled");
      // ...and X's debit would have taken A to -100. The database refused.
      expect(outcome.x.status).toBe("rejected");
      expect((outcome.x as PromiseRejectedResult).reason).toMatchObject({
        code: "23514",
        constraint: "balance_non_negative",
      });
      expect(await balanceOf(a)).toBe(0);
      // afterEach checks the invariants still hold.
    });
  });
});

describe("rule 1 under load, over HTTP", () => {
  const app = buildApp({ pool });
  let baseUrl: string;

  beforeEach(async () => {
    if (!baseUrl) {
      await app.listen({ port: 0, host: "127.0.0.1" });
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    }
  });
  afterAll(() => app.close());

  function post(from: string, to: string, amountCents: number, key: string) {
    return fetch(`${baseUrl}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ from_account_id: from, to_account_id: to, amount_cents: amountCents }),
    });
  }

  it("100 simultaneous requests draining one account: exactly as many succeed as the balance allows", async () => {
    const source = await newAccount(1_000);
    const sinks = await Promise.all(Array.from({ length: 5 }, () => newAccount(0)));

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => post(source, sinks[i % sinks.length]!, 30, `drain-${i}`)),
    );
    const statuses = responses.map((r) => r.status);

    // floor(1000 / 30) = 33 transfers fit; 1000 - 33*30 = 10 is left over.
    expect(statuses.filter((s) => s === 201)).toHaveLength(33);
    expect(statuses.filter((s) => s === 422)).toHaveLength(67);
    expect(await balanceOf(source)).toBe(10);
    const sinkTotal = (await Promise.all(sinks.map(balanceOf))).reduce((x, y) => x + y, 0);
    expect(sinkTotal).toBe(990);
  });

  it("transfers in opposite directions at once neither deadlock nor lose money", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(1_000);

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        i % 2 === 0 ? post(a, b, 1 + (i % 37), `ab-${i}`) : post(b, a, 1 + (i % 41), `ba-${i}`),
      ),
    );
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 422);
    expect(unexpected.map((r) => r.status)).toEqual([]);
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(2_000);
  });

  it("many accounts sending to each other at once: no deadlocks, money conserved", async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, () => newAccount(500)));
    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, i) => {
        const from = accounts[i % 6]!;
        const to = accounts[(i * 7 + 1) % 6]!;
        return from === to ? null : post(from, to, 1 + ((i * 13) % 90), `mesh-${i}`);
      }).filter((p): p is Promise<Response> => p !== null),
    );
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 422);
    expect(unexpected.map((r) => r.status)).toEqual([]);
    const total = (await Promise.all(accounts.map(balanceOf))).reduce((x, y) => x + y, 0);
    expect(total).toBe(3_000);
  });
});
