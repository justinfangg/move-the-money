import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { InsufficientFundsError, NotFoundError, ValidationError } from "../src/errors.js";
import { getAccount, listTransactions, openAccount } from "../src/ledger/accounts.js";
import { transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Rule 2: a transfer is all or nothing. These tests break a transfer at the
 * worst possible moment — after the debit has been written, before the credit
 * — and check that no trace of it survives.
 */

const pool = makeTestPool(5);
const observer = makeTestPool(2); // a separate connection, like another client

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(async () => {
  await pool.end();
  await observer.end();
});

async function newAccount(balanceCents: number): Promise<string> {
  return (await openAccount(pool, { initialBalanceCents: balanceCents })).value.id;
}

async function balanceOf(id: string): Promise<number> {
  return (await getAccount(pool, id)).balance_cents;
}

async function countRows(table: "transfers" | "ledger_entries"): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM ${table}`);
  return rows[0].n;
}

async function expectUntouched(a: string, b: string): Promise<void> {
  expect(await balanceOf(a)).toBe(100);
  expect(await balanceOf(b)).toBe(50);
  expect(await countRows("transfers")).toBe(0);
  expect(await countRows("ledger_entries")).toBe(2); // just the two opening entries
  expect(await listTransactions(pool, a, 10)).toHaveLength(1);
}

describe("rule 2: all or nothing", () => {
  it("an error between debit and credit leaves no trace", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);

    const attempt = transfer(
      pool,
      { fromAccountId: a, toAccountId: b, amountCents: 40, idempotencyKey: "k" },
      {
        afterDebit: async (client) => {
          // Prove the debit really happened inside the transaction...
          const { rows } = await client.query("SELECT balance_cents FROM accounts WHERE id = $1", [a]);
          expect(rows[0].balance_cents).toBe(60);
          throw new Error("simulated failure after debit");
        },
      },
    );

    await expect(attempt).rejects.toThrow("simulated failure after debit");
    // ...and that none of it survived.
    await expectUntouched(a, b);
  });

  it("the database connection dying between debit and credit leaves no trace", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);

    const attempt = transfer(
      pool,
      { fromAccountId: a, toAccountId: b, amountCents: 40, idempotencyKey: "k" },
      {
        afterDebit: async (client) => {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          // Kill our own backend from outside, as if the app server or the
          // network died mid-transfer.
          await observer.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
        },
      },
    );

    await expect(attempt).rejects.toThrow();
    await expectUntouched(a, b);

    // The pool must not hand out the dead connection again.
    const next = await transfer(pool, { fromAccountId: a, toAccountId: b, amountCents: 40, idempotencyKey: "k2" });
    expect(next.replayed).toBe(false);
    expect(await balanceOf(a)).toBe(60);
    expect(await balanceOf(b)).toBe(90);
  });

  it("no other connection ever sees the half-done state", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);
    let seenMidway: { a: number; b: number } | undefined;

    await transfer(
      pool,
      { fromAccountId: a, toAccountId: b, amountCents: 40, idempotencyKey: "k" },
      {
        afterDebit: async () => {
          const { rows } = await observer.query<{ id: string; balance_cents: number }>(
            "SELECT id, balance_cents FROM accounts WHERE id = ANY($1::uuid[])",
            [[a, b]],
          );
          const by = Object.fromEntries(rows.map((r) => [r.id, r.balance_cents]));
          seenMidway = { a: by[a]!, b: by[b]! };
        },
      },
    );

    // While the debit was written but not committed, the outside world still
    // saw the original balances, not 60/50.
    expect(seenMidway).toEqual({ a: 100, b: 50 });
    expect(await balanceOf(a)).toBe(60);
    expect(await balanceOf(b)).toBe(90);
  });

  it("insufficient funds changes nothing", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);
    await expect(send(a, b, 101, "k")).rejects.toBeInstanceOf(InsufficientFundsError);
    await expectUntouched(a, b);
  });

  it("an unknown account on either side changes nothing", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(send(a, ghost, 10, "k")).rejects.toBeInstanceOf(NotFoundError);
    await expect(send(ghost, a, 10, "k2")).rejects.toBeInstanceOf(NotFoundError);
    await expectUntouched(a, b);
  });

  it("rejects transfers to the same account, and invalid amounts, before touching anything", async () => {
    const a = await newAccount(100);
    const b = await newAccount(50);
    await expect(send(a, a, 10, "k1")).rejects.toBeInstanceOf(ValidationError);
    for (const bad of [0, -10, 10.5, Number.NaN, 2 ** 53]) {
      await expect(send(a, b, bad, `bad-${bad}`), `amount ${bad}`).rejects.toBeInstanceOf(ValidationError);
    }
    await expectUntouched(a, b);
  });
});

function send(from: string, to: string, amountCents: number, key: string) {
  return transfer(pool, { fromAccountId: from, toAccountId: to, amountCents, idempotencyKey: key });
}
