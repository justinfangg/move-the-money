import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyConflictError, InsufficientFundsError } from "../src/errors.js";
import { getAccount, openAccount } from "../src/ledger/accounts.js";
import { transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Rule 3: the same transfer submitted twice is applied once. "The same
 * transfer" means the same idempotency key. The caller generates it once per
 * intended transfer and reuses it on every retry. test/cli-process.test.ts
 * covers the same thing with separate OS processes.
 */

const pool = makeTestPool(25);

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

async function newAccount(balanceCents: number): Promise<string> {
  return (await openAccount(pool, { initialBalanceCents: balanceCents })).value.id;
}

async function balanceOf(id: string): Promise<number> {
  return (await getAccount(pool, id)).balance_cents;
}

async function transferCount(): Promise<number> {
  const { rows } = await pool.query("SELECT count(*) AS n FROM transfers");
  return rows[0].n;
}

const send = (from: string, to: string, amountCents: number, key: string) =>
  transfer(pool, { fromAccountId: from, toAccountId: to, amountCents, idempotencyKey: key });

describe("rule 3: the same transfer submitted twice is applied once", () => {
  it("a sequential retry returns the original transfer and moves no more money", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);

    const first = await send(a, b, 30, "retry-me");
    const second = await send(a, b, 30, "retry-me");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(30);
    expect(await transferCount()).toBe(1);
  });

  it("20 identical requests arriving at once are applied exactly once", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(0);

    const results = await Promise.all(Array.from({ length: 20 }, () => send(a, b, 250, "double-click")));

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.value.id)).size).toBe(1);
    expect(await balanceOf(a)).toBe(750);
    expect(await balanceOf(b)).toBe(250);
    expect(await transferCount()).toBe(1);
  });

  it("a replay returns the original result even after the balance has been spent", async () => {
    // The retry must not be re-evaluated against today's balance: the money
    // already moved, and the caller needs to hear "done", not "insufficient".
    const a = await newAccount(100);
    const b = await newAccount(0);
    await send(a, b, 100, "all-of-it");
    expect(await balanceOf(a)).toBe(0);

    const retry = await send(a, b, 100, "all-of-it");
    expect(retry.replayed).toBe(true);
    expect(await balanceOf(b)).toBe(100);
  });

  it("reusing a key for a different transfer is refused, not silently replayed", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const c = await newAccount(0);
    await send(a, b, 10, "k");

    for (const [from, to, amount] of [
      [a, b, 11],
      [a, c, 10],
      [b, a, 10],
    ] as const) {
      await expect(send(from, to, amount, "k")).rejects.toBeInstanceOf(IdempotencyConflictError);
    }
    expect(await balanceOf(a)).toBe(90);
    expect(await transferCount()).toBe(1);
  });

  it("concurrent requests with one key but different amounts: exactly one is applied", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(0);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => send(a, b, 10 + i, "contested")));

    const applied = results.filter((r) => r.status === "fulfilled" && !r.value.replayed);
    expect(applied).toHaveLength(1);
    const winner = (applied[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof send>>>).value.value.amount_cents;
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(IdempotencyConflictError);
    }
    expect(await balanceOf(a)).toBe(1_000 - winner);
    expect(await transferCount()).toBe(1);
  });

  it("a failed attempt does not burn the key: the retry is evaluated fresh", async () => {
    // Deliberate choice: an attempt that is rejected rolls back entirely,
    // including the key. If the caller retries after the account is funded,
    // the transfer goes through. See README "Design decisions".
    const a = await newAccount(50);
    const b = await newAccount(0);
    const funder = await newAccount(100);

    await expect(send(a, b, 80, "pay-rent")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await transferCount()).toBe(0);

    await send(funder, a, 100, "top-up");

    const retry = await send(a, b, 80, "pay-rent");
    expect(retry.replayed).toBe(false);
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(80);
  });

  it("concurrent retries of a transfer that can't be afforded all fail, and leave nothing behind", async () => {
    const a = await newAccount(10);
    const b = await newAccount(0);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => send(a, b, 50, "cant-afford")));
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    }
    expect(await transferCount()).toBe(0);
    expect(await balanceOf(a)).toBe(10);
  });

  it("keys are global: the same key from a different payer is a conflict, not a second transfer", async () => {
    const a = await newAccount(100);
    const b = await newAccount(100);
    const c = await newAccount(0);
    await send(a, c, 10, "shared");
    await expect(send(b, c, 10, "shared")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
