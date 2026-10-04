import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/cli.js";
import { getAccount, openAccount } from "../src/ledger/accounts.js";
import { TEST_DATABASE_URL } from "./config.js";
import { assertInvariants, makeTestPool, resetDb } from "./helpers.js";

/*
 * The CLI as people actually run it: separate OS processes, each with its
 * own connection pool, all hitting the same database at the same moment.
 * Nothing is shared between them except Postgres, which is exactly the
 * situation the locks and the unique key index exist for.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pool = makeTestPool(2);

beforeEach(() => resetDb(pool));
afterEach(() => assertInvariants(pool));
afterAll(() => pool.end());

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function moveMoney(...args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function newAccount(balanceCents: number): Promise<string> {
  return (await openAccount(pool, { initialBalanceCents: balanceCents })).value.id;
}

async function balanceOf(id: string): Promise<number> {
  return (await getAccount(pool, id)).balance_cents;
}

describe("separate CLI processes at the same time", () => {
  it("rule 1: 12 processes racing to spend 3.00 in 1.00 pieces: exactly 3 succeed", async () => {
    const a = await newAccount(300);
    const sinks = await Promise.all(Array.from({ length: 4 }, () => newAccount(0)));

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => moveMoney("transfer", a, sinks[i % 4]!, "1.00", "--key", `race-${i}`)),
    );

    const codes = results.map((r) => r.code);
    expect(codes.filter((c) => c === EXIT.ok)).toHaveLength(3);
    expect(codes.filter((c) => c === EXIT.refused)).toHaveLength(9);
    for (const r of results.filter((r) => r.code === EXIT.refused)) {
      expect(r.stderr).toMatch(/insufficient funds/);
    }
    expect(await balanceOf(a)).toBe(0);
  });

  it("rule 3: the same command run by 10 processes at once moves the money once", async () => {
    const a = await newAccount(1_000);
    const b = await newAccount(0);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => moveMoney("transfer", a, b, "2.50", "--key", "same-click")),
    );

    expect(results.map((r) => r.code)).toEqual(Array(10).fill(EXIT.ok));
    expect(results.filter((r) => r.stdout.startsWith("Transferred"))).toHaveLength(1);
    expect(results.filter((r) => r.stdout.startsWith("Already applied"))).toHaveLength(9);
    expect(await balanceOf(a)).toBe(750);
    expect(await balanceOf(b)).toBe(250);
  });

  it("works end to end through its JSON output", async () => {
    const opened = await moveMoney("open", "10.29", "--json");
    expect(opened.code).toBe(EXIT.ok);
    const id = JSON.parse(opened.stdout).account.id as string;
    const balance = await moveMoney("balance", id, "--json");
    expect(JSON.parse(balance.stdout).balance_cents).toBe(1029);
  });
});
