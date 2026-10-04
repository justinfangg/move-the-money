import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { getAccount, openAccount } from "../src/ledger/accounts.js";
import { transfer } from "../src/ledger/transfer.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * Rule 3: the same transfer submitted twice is applied once. "The same
 * transfer" means the same Idempotency-Key. The client generates it once per
 * intended transfer and reuses it on every retry.
 */

const pool = makeTestPool(25);
const app = buildApp({ pool });
let baseUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(async () => {
  await app.close();
  await pool.end();
});

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

function post(body: Record<string, unknown>, key?: string) {
  return fetch(`${baseUrl}/transfers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
    body: JSON.stringify(body),
  });
}

const body = (from: string, to: string, amountCents: number) => ({
  from_account_id: from,
  to_account_id: to,
  amount_cents: amountCents,
});

describe("rule 3: the same transfer submitted twice is applied once", () => {
  it("a sequential retry returns the original transfer and moves no more money", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);

    const first = await post(body(a, b, 30), "retry-me");
    const second = await post(body(a, b, 30), "retry-me");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(30);
    expect(await transferCount()).toBe(1);
  });

  it("20 identical requests arriving at once are applied exactly once", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(0);

    const responses = await Promise.all(Array.from({ length: 20 }, () => post(body(a, b, 250), "double-click")));
    const statuses = responses.map((r) => r.status).sort();
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);
    expect(ids.size).toBe(1);
    expect(await balanceOf(a)).toBe(750);
    expect(await balanceOf(b)).toBe(250);
    expect(await transferCount()).toBe(1);
  });

  it("a replay returns the original result even after the balance has been spent", async () => {
    // The retry must not be re-evaluated against today's balance: the money
    // already moved, and the client needs to hear "done", not "insufficient".
    const a = await newAccount(100);
    const b = await newAccount(0);
    expect((await post(body(a, b, 100), "all-of-it")).status).toBe(201);
    expect(await balanceOf(a)).toBe(0);

    const retry = await post(body(a, b, 100), "all-of-it");
    expect(retry.status).toBe(200);
    expect(await balanceOf(b)).toBe(100);
  });

  it("reusing a key for a different transfer is refused, not silently replayed", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const c = await newAccount(0);
    expect((await post(body(a, b, 10), "k")).status).toBe(201);

    for (const different of [body(a, b, 11), body(a, c, 10), body(b, a, 10)]) {
      const res = await post(different, "k");
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("idempotency_key_conflict");
    }
    expect(await balanceOf(a)).toBe(90);
    expect(await transferCount()).toBe(1);
  });

  it("concurrent requests with one key but different bodies: exactly one is applied", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(0);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post(body(a, b, 10 + i), "contested")),
    );
    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    const winner = (await created[0]!.json()).amount_cents as number;
    // Everyone else either replayed the winner (same amount) or got 409.
    for (const r of responses) expect([200, 201, 409]).toContain(r.status);
    expect(await balanceOf(a)).toBe(1_000 - winner);
    expect(await transferCount()).toBe(1);
  });

  it("a failed attempt does not burn the key: the retry is evaluated fresh", async () => {
    // Deliberate choice: an attempt that is rejected rolls back entirely,
    // including the key. If the client retries after the account is funded,
    // the transfer goes through. See README "Idempotency".
    const a = await newAccount(50);
    const b = await newAccount(0);
    const funder = await newAccount(100);

    const tooSoon = await post(body(a, b, 80), "pay-rent");
    expect(tooSoon.status).toBe(422);
    expect(await transferCount()).toBe(0);

    expect((await post(body(funder, a, 100), "top-up")).status).toBe(201);

    const retry = await post(body(a, b, 80), "pay-rent");
    expect(retry.status).toBe(201);
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(80);
  });

  it("concurrent retries of a transfer that can't be afforded all fail, and leave nothing behind", async () => {
    const a = await newAccount(10);
    const b = await newAccount(0);
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body(a, b, 50), "cant-afford")));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(422));
    expect(await transferCount()).toBe(0);
    expect(await balanceOf(a)).toBe(10);
  });

  it("keys are global: the same key from a different payer is a conflict, not a second transfer", async () => {
    // Keys are global, not per-account. Two different clients choosing the
    // same key is a client bug; we refuse rather than guess.
    const a = await newAccount(100);
    const b = await newAccount(100);
    const c = await newAccount(0);
    expect((await post(body(a, c, 10), "shared")).status).toBe(201);
    expect((await post(body(b, c, 10), "shared")).status).toBe(409);
  });

  it("requires a usable Idempotency-Key header", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    expect((await post(body(a, b, 10))).status).toBe(400);
    expect((await post(body(a, b, 10), "")).status).toBe(400);
    expect((await post(body(a, b, 10), "x".repeat(256))).status).toBe(400);
    expect(await transferCount()).toBe(0);
  });

  it("the service layer is idempotent too, not just the HTTP layer", async () => {
    const a = await newAccount(100);
    const b = await newAccount(0);
    const input = { fromAccountId: a, toAccountId: b, amountCents: 5, idempotencyKey: "svc" };
    const results = await Promise.all(Array.from({ length: 10 }, () => transfer(pool, input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.value.id)).size).toBe(1);
    expect(await balanceOf(a)).toBe(95);
  });
});
