import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestPool, resetDb } from "./helpers.js";

// These bypass the application entirely. They prove the database itself
// refuses the states the rules forbid, so a bug in application code can't
// commit them either.

const pool = makeTestPool(2);
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function insertAccount(balance: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO accounts (balance_cents) VALUES ($1) RETURNING id",
    [balance],
  );
  return rows[0]!.id;
}

describe("schema backstops", () => {
  it("rejects a negative balance", async () => {
    const id = await insertAccount(100);
    await expect(
      pool.query("UPDATE accounts SET balance_cents = balance_cents - 101 WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "balance_non_negative" });
  });

  it("rejects a balance a JS number can't represent exactly", async () => {
    await expect(insertAccount(2 ** 53)).rejects.toMatchObject({ constraint: "balance_js_safe" });
  });

  it("rejects zero, negative and self transfers", async () => {
    const a = await insertAccount(100);
    const b = await insertAccount(100);
    const insert = (from: string, to: string, amount: number, key: string) =>
      pool.query(
        "INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents) VALUES ($1, $2, $3, $4)",
        [key, from, to, amount],
      );
    await expect(insert(a, b, 0, "k1")).rejects.toMatchObject({ constraint: "amount_positive" });
    await expect(insert(a, b, -5, "k2")).rejects.toMatchObject({ constraint: "amount_positive" });
    await expect(insert(a, a, 5, "k3")).rejects.toMatchObject({ constraint: "distinct_accounts" });
  });

  it("rejects a duplicate idempotency key", async () => {
    const a = await insertAccount(100);
    const b = await insertAccount(100);
    const insert = () =>
      pool.query(
        "INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents) VALUES ('same', $1, $2, 1)",
        [a, b],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });

  it("returns BIGINT as an exact JS number, and refuses ones it can't represent", async () => {
    const ok = await pool.query("SELECT 9007199254740991::bigint AS n");
    expect(ok.rows[0].n).toBe(Number.MAX_SAFE_INTEGER);
    await expect(pool.query("SELECT 9007199254740993::bigint AS n")).rejects.toThrow(/safe-integer/);
  });
});
