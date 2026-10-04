import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { getAccount, openAccount } from "../src/ledger/accounts.js";
import { transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Rule 4: amounts are exact. If a cent goes missing anywhere, the system is
 * wrong. Rather than pick examples, generate random account sets and random
 * transfer sequences, run them, and compare against an independent model
 * that uses BigInt (so the model itself can't suffer float or overflow
 * errors). Every run also has to pass assertInvariants.
 */

const pool = makeTestPool(20);

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

const MAX = Number.MAX_SAFE_INTEGER;

const openingBalance = fc.oneof(
  fc.integer({ min: 0, max: 1_000 }),
  fc.integer({ min: 0, max: 100_000_000 }),
  // Big balances, so sums and the cap get exercised, not just small numbers.
  fc.integer({ min: MAX - 1_000_000, max: MAX }),
);

const scenario = fc.record({
  openings: fc.array(openingBalance, { minLength: 2, maxLength: 5 }),
  transfers: fc.array(
    fc.record({
      from: fc.nat(),
      to: fc.nat(),
      // Random amounts almost never land exactly on a balance, which is where
      // off-by-one bugs live (an earlier version of this test passed with
      // `balance <= amount` in place of `balance < amount`). So sometimes
      // send exactly the whole balance, or one cent more.
      amount: fc.oneof(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: MAX }),
        fc.constant("whole balance" as const),
        fc.constant("whole balance + 1" as const),
      ),
    }),
    { maxLength: 25 },
  ),
});

async function setUp(openings: number[]): Promise<string[]> {
  await resetDb(pool);
  const ids: string[] = [];
  for (const cents of openings) ids.push((await openAccount(pool, { initialBalanceCents: cents })).value.id);
  return ids;
}

async function balances(ids: string[]): Promise<bigint[]> {
  return Promise.all(ids.map(async (id) => BigInt((await getAccount(pool, id)).balance_cents)));
}

describe("rule 4: no cent is ever created or lost", () => {
  it("sequential random transfers match a BigInt model exactly", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ openings, transfers }) => {
        const ids = await setUp(openings);
        const model = openings.map(BigInt);

        for (const [i, t] of transfers.entries()) {
          const from = t.from % ids.length;
          const to = t.to % ids.length;
          if (from === to) continue;
          const amount =
            t.amount === "whole balance"
              ? model[from]!
              : t.amount === "whole balance + 1"
                ? model[from]! + 1n
                : BigInt(t.amount);
          if (amount < 1n || amount > BigInt(MAX)) continue;
          const modelAllows = model[from]! >= amount && model[to]! + amount <= BigInt(MAX);

          try {
            await transfer(pool, {
              fromAccountId: ids[from]!,
              toAccountId: ids[to]!,
              amountCents: Number(amount),
              idempotencyKey: `seq-${i}`,
            });
            expect(modelAllows, `transfer ${i} succeeded but the model says it shouldn't`).toBe(true);
            model[from]! -= amount;
            model[to]! += amount;
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            expect(modelAllows, `transfer ${i} was refused (${err.code}) but the model allows it`).toBe(false);
          }
        }

        expect(await balances(ids)).toEqual(model);
        await assertInvariants(pool);
      }),
      { numRuns: 60 },
    );
  });

  it("concurrent random transfers: final balances are exactly what the successful ones add up to", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ openings, transfers }) => {
        const ids = await setUp(openings);
        const valid = transfers
          .map((t, i) => {
            const from = t.from % ids.length;
            const amount =
              t.amount === "whole balance"
                ? openings[from]!
                : t.amount === "whole balance + 1"
                  ? openings[from]! + 1
                  : t.amount;
            return { from, to: t.to % ids.length, amount, i };
          })
          .filter((t) => t.from !== t.to && Number.isSafeInteger(t.amount) && t.amount >= 1);

        const results = await Promise.allSettled(
          valid.map((t) =>
            transfer(pool, {
              fromAccountId: ids[t.from]!,
              toAccountId: ids[t.to]!,
              amountCents: t.amount,
              idempotencyKey: `conc-${t.i}`,
            }),
          ),
        );

        // We can't predict *which* transfers win a race, but whichever did,
        // the balances must be exactly openings + what succeeded.
        const expected = openings.map(BigInt);
        results.forEach((r, k) => {
          if (r.status === "rejected") {
            expect(r.reason, "only business-rule refusals are acceptable").toBeInstanceOf(AppError);
            return;
          }
          const t = valid[k]!;
          expected[t.from]! -= BigInt(t.amount);
          expected[t.to]! += BigInt(t.amount);
        });

        expect(await balances(ids)).toEqual(expected);
        for (const b of expected) expect(b >= 0n).toBe(true);
        await assertInvariants(pool);
      }),
      { numRuns: 30 },
    );
  });
});

describe("the edges of the representable range", () => {
  it("moves the largest possible amount without losing a cent", async () => {
    const a = (await openAccount(pool, { initialBalanceCents: MAX })).value.id;
    const b = (await openAccount(pool, { initialBalanceCents: 0 })).value.id;
    await transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: MAX, idempotencyKey: "max" });
    expect((await getAccount(pool, a)).balance_cents).toBe(0);
    expect((await getAccount(pool, b)).balance_cents).toBe(MAX);
  });

  it("refuses a credit that would push a balance past the cap, and changes nothing", async () => {
    const a = (await openAccount(pool, { initialBalanceCents: 10 })).value.id;
    const b = (await openAccount(pool, { initialBalanceCents: MAX - 5 })).value.id;
    await expect(
      transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: 10, idempotencyKey: "overflow" }),
    ).rejects.toMatchObject({ code: "balance_limit_exceeded" });
    expect((await getAccount(pool, a)).balance_cents).toBe(10);
    expect((await getAccount(pool, b)).balance_cents).toBe(MAX - 5);
  });

  it("does odd-cent amounts exactly (no 0.1 + 0.2 style drift)", async () => {
    // 10 cents and 20 cents as integers: 30, never 30.000000000000004.
    const a = (await openAccount(pool, { initialBalanceCents: 30 })).value.id;
    const b = (await openAccount(pool, { initialBalanceCents: 0 })).value.id;
    await transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: 10, idempotencyKey: "t1" });
    await transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: 20, idempotencyKey: "t2" });
    expect((await getAccount(pool, a)).balance_cents).toBe(0);
    expect((await getAccount(pool, b)).balance_cents).toBe(30);
  });
});
