import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { IdempotencyConflictError, NotFoundError } from "../errors.js";
import { requireCents } from "../money.js";
import { requireIdempotencyKey, requireUuid } from "../validate.js";
import { type Account, type Created, CURRENCY, type LedgerEntry } from "./types.js";

type Queryable = pg.Pool | pg.PoolClient;

interface AccountRow {
  id: string;
  balance_cents: number;
  created_at: Date;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    balance_cents: row.balance_cents,
    currency: CURRENCY,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Open an account with an opening balance. The opening balance is recorded as
 * a ledger entry like any other movement, so balance == SUM(ledger) from the
 * first moment the account exists.
 *
 * If `idempotencyKey` is given and was used before with the same opening
 * balance, the existing account is returned instead of creating a second one.
 */
export async function openAccount(
  pool: pg.Pool,
  input: { initialBalanceCents: number; idempotencyKey?: string },
): Promise<Created<Account>> {
  // Validate here, not only at the edge: this module is the boundary every
  // caller (CLI, tests, anything later) goes through.
  const initialBalanceCents = requireCents(input.initialBalanceCents, "initial balance", 0);
  const idempotencyKey =
    input.idempotencyKey === undefined ? null : requireIdempotencyKey(input.idempotencyKey);
  return withTransaction(pool, async (client) => {
    const inserted = await client.query<AccountRow>(
      `INSERT INTO accounts (balance_cents, idempotency_key)
       VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, balance_cents, created_at`,
      [initialBalanceCents, idempotencyKey],
    );

    const row = inserted.rows[0];
    if (row) {
      await client.query(
        `INSERT INTO ledger_entries (account_id, kind, amount_cents, balance_after_cents)
         VALUES ($1, 'opening', $2, $2)`,
        [row.id, initialBalanceCents],
      );
      return { value: toAccount(row), replayed: false };
    }

    // Key already used. Compare against what it was *opened* with, not the
    // current balance, which may have moved since.
    const existing = await client.query<AccountRow & { opening_cents: number }>(
      `SELECT a.id, a.balance_cents, a.created_at, l.amount_cents AS opening_cents
         FROM accounts a
         JOIN ledger_entries l ON l.account_id = a.id AND l.kind = 'opening'
        WHERE a.idempotency_key = $1`,
      [idempotencyKey],
    );
    const prior = existing.rows[0]!;
    if (prior.opening_cents !== initialBalanceCents) {
      throw new IdempotencyConflictError();
    }
    return { value: toAccount(prior), replayed: true };
  });
}

export async function getAccount(db: Queryable, id: string): Promise<Account> {
  id = requireUuid(id, "account id");
  const { rows } = await db.query<AccountRow>(
    "SELECT id, balance_cents, created_at FROM accounts WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`account ${id} not found`);
  return toAccount(row);
}

/** Ledger history for one account, newest first. */
export async function listTransactions(
  pool: pg.Pool,
  accountId: string,
  limit: number,
): Promise<LedgerEntry[]> {
  await getAccount(pool, accountId);
  const { rows } = await pool.query<{
    id: number;
    kind: LedgerEntry["kind"];
    amount_cents: number;
    balance_after_cents: number;
    transfer_id: string | null;
    counterparty_account_id: string | null;
    created_at: Date;
  }>(
    `SELECT l.id, l.kind, l.amount_cents, l.balance_after_cents, l.transfer_id, l.created_at,
            CASE l.kind WHEN 'debit'  THEN t.to_account_id
                        WHEN 'credit' THEN t.from_account_id END AS counterparty_account_id
       FROM ledger_entries l
       LEFT JOIN transfers t ON t.id = l.transfer_id
      WHERE l.account_id = $1
      ORDER BY l.id DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}
