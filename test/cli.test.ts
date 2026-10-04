import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

// The CLI run in-process against the test database. test/cli-process.test.ts
// runs it as real separate processes.

const pool = makeTestPool(5);
beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, pool, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function cliJson(...argv: string[]) {
  const res = await cli(...argv, "--json");
  return { ...res, json: res.out ? JSON.parse(res.out) : undefined };
}

async function open(amount: string): Promise<string> {
  const res = await cliJson("open", amount);
  expect(res.code).toBe(EXIT.ok);
  return res.json.account.id;
}

async function balanceCents(id: string): Promise<number> {
  return (await cliJson("balance", id)).json.balance_cents;
}

describe("open", () => {
  it("opens an account and prints its id", async () => {
    const res = await cli("open", "100.25");
    expect(res.code).toBe(EXIT.ok);
    expect(res.out).toMatch(/^Opened account [0-9a-f-]{36} with 100\.25 CAD\.$/);
  });

  it("stores the amount as exact cents", async () => {
    const res = await cliJson("open", "0.29");
    expect(res.json.account.balance_cents).toBe(29);
  });

  it.each(["10.555", "1e3", "$5", "ten"])("refuses %s as an amount, and creates nothing", async (amount) => {
    const res = await cli("open", amount);
    expect(res.code).toBe(EXIT.usage);
    expect(res.err).toMatch(/at most two decimal places/);
    const { rows } = await pool.query("SELECT count(*) AS n FROM accounts");
    expect(rows[0].n).toBe(0);
  });

  it.each(["-5", "-0.01", "-.5"])("says a negative amount (%s) is negative, not an unknown option", async (amount) => {
    const res = await cli("open", amount);
    expect(res.code).toBe(EXIT.usage);
    expect(res.err).toBe(`error: amounts can't be negative (got ${amount})`);
    const { rows } = await pool.query("SELECT count(*) AS n FROM accounts");
    expect(rows[0].n).toBe(0);
  });

  it("opens once per --key", async () => {
    const first = await cliJson("open", "50", "--key", "open-1");
    const again = await cli("open", "50", "--key", "open-1");
    expect(again.code).toBe(EXIT.ok);
    expect(again.out).toMatch(/already opened with this key/);
    const conflict = await cli("open", "60", "--key", "open-1");
    expect(conflict.code).toBe(EXIT.refused);
    const { rows } = await pool.query("SELECT id FROM accounts");
    expect(rows).toEqual([{ id: first.json.account.id }]);
  });
});

describe("balance", () => {
  it("prints the balance", async () => {
    const id = await open("12.34");
    const res = await cli("balance", id);
    expect(res.code).toBe(EXIT.ok);
    expect(res.out).toBe(`${id}  12.34 CAD`);
  });

  it("reports unknown and malformed account ids", async () => {
    const missing = await cli("balance", "00000000-0000-4000-8000-000000000000");
    expect(missing.code).toBe(EXIT.refused);
    expect(missing.err).toMatch(/not found/);
    const malformed = await cli("balance", "abc");
    expect(malformed.code).toBe(EXIT.usage);
  });
});

describe("transfer", () => {
  it("moves money and says so", async () => {
    const a = await open("100");
    const b = await open("0");
    const res = await cli("transfer", a, b, "25.50", "--key", "t1");
    expect(res.code).toBe(EXIT.ok);
    expect(res.out).toMatch(new RegExp(`^Transferred 25\\.50 CAD from ${a} to ${b} \\(transfer [0-9a-f-]{36}\\)\\.$`));
    expect(await balanceCents(a)).toBe(7450);
    expect(await balanceCents(b)).toBe(2550);
  });

  it("requires --key, and explains why", async () => {
    const a = await open("100");
    const b = await open("0");
    const res = await cli("transfer", a, b, "10");
    expect(res.code).toBe(EXIT.usage);
    expect(res.err).toMatch(/needs --key/);
    expect(await balanceCents(a)).toBe(10000);
  });

  it("running the same command twice moves the money once", async () => {
    const a = await open("100");
    const b = await open("0");
    const first = await cli("transfer", a, b, "40", "--key", "rent");
    const second = await cli("transfer", a, b, "40", "--key", "rent");
    expect(first.code).toBe(EXIT.ok);
    expect(second.code).toBe(EXIT.ok);
    expect(second.out).toMatch(/^Already applied: .* No money moved this time\.$/);
    expect(await balanceCents(a)).toBe(6000);
  });

  it("refuses to reuse a key for a different transfer", async () => {
    const a = await open("100");
    const b = await open("0");
    await cli("transfer", a, b, "40", "--key", "k");
    const res = await cliJson("transfer", a, b, "41", "--key", "k");
    expect(res.code).toBe(EXIT.refused);
    expect(JSON.parse(res.err)).toMatchObject({ error: "idempotency_key_conflict" });
    expect(await balanceCents(a)).toBe(6000);
  });

  it("refuses an overdraft with exit code 1 and changes nothing", async () => {
    const a = await open("10");
    const b = await open("0");
    const res = await cliJson("transfer", a, b, "10.01", "--key", "too-much");
    expect(res.code).toBe(EXIT.refused);
    expect(JSON.parse(res.err)).toMatchObject({ error: "insufficient_funds" });
    expect(await balanceCents(a)).toBe(1000);
    expect(await balanceCents(b)).toBe(0);
  });

  it("refuses sub-cent and malformed amounts before touching anything", async () => {
    const a = await open("10");
    const b = await open("0");
    for (const amount of ["0", "0.001", "-1", "1e1", "1.5.0"]) {
      const res = await cli("transfer", a, b, amount, "--key", `bad-${amount}`);
      expect(res.code, amount).toBe(EXIT.usage);
    }
    const self = await cli("transfer", a, a, "1", "--key", "self");
    expect(self.code).toBe(EXIT.usage);
    const { rows } = await pool.query("SELECT count(*) AS n FROM transfers");
    expect(rows[0].n).toBe(0);
  });
});

describe("history", () => {
  it("lists entries newest first, with counterparties", async () => {
    const a = await open("100");
    const b = await open("0");
    await cli("transfer", a, b, "25.50", "--key", "t1");
    await cli("transfer", b, a, "0.50", "--key", "t2");

    const res = await cli("history", a);
    expect(res.code).toBe(EXIT.ok);
    const lines = res.out.split("\n");
    expect(lines[0]).toMatch(/^when\s+kind\s+amount\s+balance\s+counterparty$/);
    expect(lines[1]).toMatch(new RegExp(`credit\\s+\\+0\\.50\\s+75\\.00\\s+from ${b}$`));
    expect(lines[2]).toMatch(new RegExp(`debit\\s+-25\\.50\\s+74\\.50\\s+to ${b}$`));
    expect(lines[3]).toMatch(/opening\s+\+100\.00\s+100\.00$/);

    const limited = await cliJson("history", a, "--limit", "1");
    expect(limited.json.entries).toHaveLength(1);
  });

  it("validates --limit", async () => {
    const a = await open("1");
    for (const bad of ["0", "501", "1.5", "x"]) {
      expect((await cli("history", a, "--limit", bad)).code, bad).toBe(EXIT.usage);
    }
  });
});

describe("usage", () => {
  it("prints help", async () => {
    const res = await cli("--help");
    expect(res.code).toBe(EXIT.ok);
    expect(res.out).toMatch(/^move-money:/);
  });

  it("reports an unknown flag in one line, with a pointer to --help", async () => {
    const res = await cli("balance", "x", "--force");
    expect(res.code).toBe(EXIT.usage);
    expect(res.err).toBe(`error: Unknown option '--force'\nRun "move-money --help" for usage.`);
  });

  it("rejects unknown commands, unknown flags and wrong argument counts", async () => {
    expect((await cli()).code).toBe(EXIT.usage);
    expect((await cli("withdraw", "5")).code).toBe(EXIT.usage);
    expect((await cli("balance", "--force")).code).toBe(EXIT.usage);
    expect((await cli("balance")).code).toBe(EXIT.usage);
    expect((await cli("open", "1", "2")).code).toBe(EXIT.usage);
  });
});
