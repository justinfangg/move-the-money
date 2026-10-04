import type pg from "pg";
import { expect } from "vitest";
import { createPool } from "../src/db/pool.js";
import { TEST_DATABASE_URL } from "./config.js";

export function makeTestPool(max = 20): pg.Pool {
  return createPool(TEST_DATABASE_URL, max);
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE ledger_entries, transfers, accounts RESTART IDENTITY CASCADE");
}

/**
 * The invariants that must hold after *any* sequence of operations. Run after
 * every test, so every test is also a test of these.
 */
export async function assertInvariants(pool: pg.Pool): Promise<void> {
  // Rule 1: no negative balances.
  const negative = await pool.query("SELECT id, balance_cents FROM accounts WHERE balance_cents < 0");
  expect(negative.rows, "accounts with a negative balance").toEqual([]);

  // Every balance is fully explained by its ledger history.
  const unexplained = await pool.query(`
    SELECT a.id, a.balance_cents, COALESCE(l.total, 0)::bigint AS ledger_total
      FROM accounts a
      LEFT JOIN (SELECT account_id, SUM(amount_cents) AS total
                   FROM ledger_entries GROUP BY account_id) l ON l.account_id = a.id
     WHERE a.balance_cents <> COALESCE(l.total, 0)`);
  expect(unexplained.rows, "balances that don't match their ledger").toEqual([]);

  // The most recent ledger entry's running balance matches the account.
  const staleRunning = await pool.query(`
    SELECT a.id, a.balance_cents, last.balance_after_cents
      FROM accounts a
      JOIN LATERAL (SELECT balance_after_cents FROM ledger_entries
                     WHERE account_id = a.id ORDER BY id DESC LIMIT 1) last ON true
     WHERE last.balance_after_cents <> a.balance_cents`);
  expect(staleRunning.rows, "running balances out of step").toEqual([]);

  // Rule 2: every transfer is exactly one debit and one credit that cancel out.
  const lopsided = await pool.query(`
    SELECT t.id,
           COUNT(l.id)                                  AS entries,
           COALESCE(SUM(l.amount_cents), 0)::bigint     AS net,
           COUNT(*) FILTER (WHERE l.kind = 'debit'  AND l.account_id = t.from_account_id
                                                    AND l.amount_cents = -t.amount_cents) AS debits,
           COUNT(*) FILTER (WHERE l.kind = 'credit' AND l.account_id = t.to_account_id
                                                    AND l.amount_cents =  t.amount_cents) AS credits
      FROM transfers t
      LEFT JOIN ledger_entries l ON l.transfer_id = t.id
     GROUP BY t.id
    HAVING COUNT(l.id) <> 2
        OR COALESCE(SUM(l.amount_cents), 0) <> 0
        OR COUNT(*) FILTER (WHERE l.kind = 'debit'  AND l.account_id = t.from_account_id
                                                    AND l.amount_cents = -t.amount_cents) <> 1
        OR COUNT(*) FILTER (WHERE l.kind = 'credit' AND l.account_id = t.to_account_id
                                                    AND l.amount_cents =  t.amount_cents) <> 1`);
  expect(lopsided.rows, "transfers that aren't a matched debit/credit pair").toEqual([]);

  // Rule 4: no money created or destroyed. Total held == total ever deposited.
  // Each balance fits in a JS number, but the sum across accounts needn't, so
  // fetch the totals as text and compare as BigInt. (Fetching them as int8
  // here makes the pool's type parser throw, which is the parser doing its
  // job.)
  const totals = await pool.query<{ held: string; opened: string }>(`
    SELECT (SELECT COALESCE(SUM(balance_cents), 0)::text FROM accounts) AS held,
           (SELECT COALESCE(SUM(amount_cents), 0)::text
              FROM ledger_entries WHERE kind = 'opening')             AS opened`);
  expect(BigInt(totals.rows[0]!.held), "total money held vs. total money opened").toBe(
    BigInt(totals.rows[0]!.opened),
  );
}
