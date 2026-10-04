import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { getAccount, listTransactions, openAccount } from "../src/ledger/accounts.js";
import { getTransfer, transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

// The ledger functions are the boundary every caller goes through, so they
// validate their own input rather than trusting the caller to have done it.

const pool = makeTestPool(2);
beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

async function count(table: "accounts" | "transfers"): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM ${table}`);
  return rows[0].n;
}

describe("ledger input validation", () => {
  it.each([
    ["negative", -1],
    ["fractional", 10.5],
    ["string", "100"],
    ["unsafe", 2 ** 53],
    ["NaN", Number.NaN],
  ])("refuses a %s opening balance", async (_label, value) => {
    await expect(openAccount(pool, { initialBalanceCents: value as number })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await count("accounts")).toBe(0);
  });

  it.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 0.5],
    ["string", "10"],
  ])("refuses a %s transfer amount", async (_label, value) => {
    const a = (await openAccount(pool, { initialBalanceCents: 100 })).value.id;
    const b = (await openAccount(pool, { initialBalanceCents: 0 })).value.id;
    await expect(
      transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: value as number, idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await count("transfers")).toBe(0);
  });

  it("refuses malformed ids and idempotency keys", async () => {
    const a = (await openAccount(pool, { initialBalanceCents: 100 })).value.id;
    const b = (await openAccount(pool, { initialBalanceCents: 0 })).value.id;
    const ok = { fromAccountId: a, toAccountId: b, amountCents: 1, idempotencyKey: "k" };
    for (const bad of [
      { ...ok, fromAccountId: "nope" },
      { ...ok, toAccountId: "" },
      { ...ok, idempotencyKey: "" },
      { ...ok, idempotencyKey: "x".repeat(256) },
      { ...ok, toAccountId: a },
    ]) {
      await expect(transfer(pool, bad)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(getAccount(pool, "nope")).rejects.toBeInstanceOf(ValidationError);
    await expect(listTransactions(pool, "nope", 10)).rejects.toBeInstanceOf(ValidationError);
    await expect(getTransfer(pool, "nope")).rejects.toBeInstanceOf(ValidationError);
    expect(await count("transfers")).toBe(0);
  });

  it("treats ids case-insensitively", async () => {
    const a = (await openAccount(pool, { initialBalanceCents: 100 })).value.id;
    expect((await getAccount(pool, a.toUpperCase())).id).toBe(a);
  });
});
