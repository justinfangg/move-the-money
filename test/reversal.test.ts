import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  NotFoundError,
  ValidationError,
} from "../src/errors.js";
import { getAccount, listTransactions, openAccount } from "../src/ledger/accounts.js";
import { AlreadyReversedError, getTransfer, reverseTransfer, transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Reversals: a transfer undone in full, at most once, recorded as a new
 * transfer that points back at the original. assertInvariants runs after each
 * test, so every reversal here is also checked to be a matched debit/credit
 * pair that creates or destroys no money.
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

const reverse = (transferId: string, key: string) => reverseTransfer(pool, { transferId, idempotencyKey: key });

describe("reversals", () => {
  it("returns the money and links the reversal to the original", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const original = (await send(a, b, 30, "pay")).value;

    const { value: reversal, replayed } = await reverse(original.id, "undo");

    expect(replayed).toBe(false);
    expect(reversal).toMatchObject({
      from_account_id: b,
      to_account_id: a,
      amount_cents: 30,
      reverses_transfer_id: original.id,
    });
    expect(await balanceOf(a)).toBe(100);
    expect(await balanceOf(b)).toBe(0);
    expect(await getTransfer(pool, original.id)).toMatchObject({
      reverses_transfer_id: null,
      reversed_by_transfer_id: reversal.id,
    });
    expect(await getTransfer(pool, reversal.id)).toMatchObject({
      reverses_transfer_id: original.id,
      reversed_by_transfer_id: null,
    });

    const [latestA] = await listTransactions(pool, a, 1);
    expect(latestA).toMatchObject({
      kind: "credit",
      amount_cents: 30,
      transfer_id: reversal.id,
      reverses_transfer_id: original.id,
      counterparty_account_id: b,
    });
  });

  it("a retry with the same key is a replay and moves no more money", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const original = (await send(a, b, 30, "pay")).value;

    const first = await reverse(original.id, "undo");
    const second = await reverse(original.id, "undo");

    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(await balanceOf(a)).toBe(100);
    expect(await transferCount()).toBe(2);
  });

  it("a replay still succeeds after the returned money has been spent", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const c = await newAccount(0);
    const original = (await send(a, b, 100, "pay")).value;
    await reverse(original.id, "undo");
    await send(a, c, 100, "spend");

    expect((await reverse(original.id, "undo")).replayed).toBe(true);
  });

  it("refuses to reverse the same transfer twice with different keys", async () => {
    const a = await newAccount(100);
    const b = await newAccount(100);
    const original = (await send(a, b, 30, "pay")).value;
    await reverse(original.id, "undo-1");

    await expect(reverse(original.id, "undo-2")).rejects.toBeInstanceOf(AlreadyReversedError);
    expect(await balanceOf(a)).toBe(100);
    expect(await balanceOf(b)).toBe(100);
  });

  it("20 concurrent reversals with different keys: exactly one applies", async () => {
    const a = await newAccount(100);
    const b = await newAccount(1_000);
    const original = (await send(a, b, 40, "pay")).value;

    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => reverse(original.id, `undo-${i}`)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(AlreadyReversedError);
    }
    expect(await balanceOf(a)).toBe(100);
    expect(await balanceOf(b)).toBe(1_000);
  });

  it("refuses when the recipient no longer has the money, and writes nothing", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const c = await newAccount(0);
    const original = (await send(a, b, 50, "pay")).value;
    await send(b, c, 30, "spend");

    await expect(reverse(original.id, "undo")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balanceOf(b)).toBe(20);
    expect(await transferCount()).toBe(2);
    // The key wasn't consumed: once b has the money again, the same key works.
    await send(c, b, 30, "refill");
    expect((await reverse(original.id, "undo")).replayed).toBe(false);
  });

  it("refuses to reverse a reversal", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const original = (await send(a, b, 30, "pay")).value;
    const reversal = (await reverse(original.id, "undo")).value;

    await expect(reverse(reversal.id, "undo-undo")).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a key already used for a different request", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const first = (await send(a, b, 10, "pay-1")).value;
    const second = (await send(a, b, 10, "pay-2")).value;
    await reverse(first.id, "undo");

    // Same key, different transfer to reverse.
    await expect(reverse(second.id, "undo")).rejects.toBeInstanceOf(IdempotencyConflictError);
    // A key used for a plain transfer.
    await expect(reverse(second.id, "pay-1")).rejects.toBeInstanceOf(IdempotencyConflictError);
    // A plain transfer reusing the reversal's key, even with the same accounts and amount.
    await expect(send(b, a, 10, "undo")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("reports an unknown or malformed transfer id", async () => {
    await expect(reverse("00000000-0000-4000-8000-000000000000", "undo")).rejects.toBeInstanceOf(NotFoundError);
    await expect(reverse("nope", "undo")).rejects.toBeInstanceOf(ValidationError);
  });
});
