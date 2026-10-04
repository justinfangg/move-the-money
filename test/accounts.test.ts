import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

const pool = makeTestPool(5);
const app = buildApp({ pool });

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(async () => {
  await app.close();
  await pool.end();
});

function open(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/accounts",
    headers: { "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /accounts", () => {
  it("opens an account with the given balance", async () => {
    const res = await open({ initial_balance_cents: 12_345 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ balance_cents: 12_345, currency: "CAD" });
  });

  it("allows a zero opening balance", async () => {
    const res = await open({ initial_balance_cents: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json().balance_cents).toBe(0);
  });

  it.each([
    ["negative", "-1"],
    ["fractional", "10.5"],
    ["sub-precision fractional", "100.000000000000001"],
    ["exponent", "1e5"],
    ["string", '"100"'],
    ["null", "null"],
    ["unsafe integer", "9007199254740993"],
  ])("rejects a %s opening balance", async (_label, literal) => {
    const res = await open(`{"initial_balance_cents": ${literal}}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    const { rows } = await pool.query("SELECT count(*) AS n FROM accounts");
    expect(rows[0].n).toBe(0);
  });

  it("rejects missing, extra and malformed bodies", async () => {
    expect((await open({})).statusCode).toBe(400);
    expect((await open({ initial_balance_cents: 1, bonus: 1 })).statusCode).toBe(400);
    expect((await open("{not json")).statusCode).toBe(400);
  });

  it("opens one account per idempotency key", async () => {
    const first = await open({ initial_balance_cents: 500 }, { "idempotency-key": "open-1" });
    const second = await open({ initial_balance_cents: 500 }, { "idempotency-key": "open-1" });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);
    const { rows } = await pool.query("SELECT count(*) AS n FROM accounts");
    expect(rows[0].n).toBe(1);
  });

  it("refuses to reuse an account idempotency key for a different opening balance", async () => {
    await open({ initial_balance_cents: 500 }, { "idempotency-key": "open-1" });
    const res = await open({ initial_balance_cents: 900 }, { "idempotency-key": "open-1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("idempotency_key_conflict");
  });
});

describe("GET /accounts/:id", () => {
  it("returns the balance", async () => {
    const { id } = (await open({ initial_balance_cents: 777 })).json();
    const res = await app.inject({ method: "GET", url: `/accounts/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, balance_cents: 777 });
  });

  it("404s for an unknown account and 400s for a malformed id", async () => {
    const missing = await app.inject({ method: "GET", url: "/accounts/00000000-0000-4000-8000-000000000000" });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: "/accounts/not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
  });
});

describe("GET /accounts/:id/transactions", () => {
  it("starts with the opening entry", async () => {
    const { id } = (await open({ initial_balance_cents: 250 })).json();
    const res = await app.inject({ method: "GET", url: `/accounts/${id}/transactions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      expect.objectContaining({ kind: "opening", amount_cents: 250, balance_after_cents: 250, transfer_id: null }),
    ]);
  });

  it("404s for an unknown account", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/accounts/00000000-0000-4000-8000-000000000000/transactions",
    });
    expect(res.statusCode).toBe(404);
  });
});
