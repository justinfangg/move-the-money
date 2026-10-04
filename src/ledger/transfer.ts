import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import {
  AppError,
  IdempotencyConflictError,
  InsufficientFundsError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { type Created, CURRENCY, type Transfer } from "./types.js";

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  idempotencyKey: string;
}

/**
 * Seams for tests to force interleavings and failures at precise points
 * inside the transaction. Never set in production code paths.
 */
export interface TransferHooks {
  /** Both account rows are locked; funds have not been checked yet. */
  afterLock?: (client: pg.PoolClient) => Promise<void>;
  /** The debit has been written; the credit has not. */
  afterDebit?: (client: pg.PoolClient) => Promise<void>;
}

interface TransferRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  created_at: Date;
}

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    amount_cents: row.amount_cents,
    currency: CURRENCY,
    created_at: row.created_at.toISOString(),
  };
}

export class BalanceLimitError extends AppError {
  constructor() {
    super(422, "balance_limit_exceeded", "transfer would exceed the maximum account balance");
  }
}

/**
 * Move money between two accounts. All of it happens in one transaction:
 *
 *   1. Claim the idempotency key by inserting the transfer row. If the key is
 *      taken, this is a retry: return the original result (or 409 if the
 *      request differs). A concurrent request with the same key blocks on the
 *      unique index here until the first one commits or rolls back.
 *   2. Lock both account rows, always in id order so A->B and B->A can't
 *      deadlock each other.
 *   3. With the locks held, check funds. Nobody else can change either
 *      balance until we commit, so the check can't go stale.
 *   4. Debit, credit, and write both ledger entries.
 *
 * Any failure rolls back everything, including the transfer row, so a failed
 * attempt leaves no trace and the same key can be retried.
 */
export async function transfer(
  pool: pg.Pool,
  input: TransferInput,
  hooks: TransferHooks = {},
): Promise<Created<Transfer>> {
  const { fromAccountId, toAccountId, amountCents, idempotencyKey } = input;
  if (fromAccountId === toAccountId) {
    throw new ValidationError("cannot transfer to the same account");
  }

  try {
    return await withTransaction(pool, async (client) => {
      const claimed = await client.query<TransferRow>(
        `INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, from_account_id, to_account_id, amount_cents, created_at`,
        [idempotencyKey, fromAccountId, toAccountId, amountCents],
      );
      const row = claimed.rows[0];
      if (!row) return replay(client, input);

      const locked = await client.query<{ id: string; balance_cents: number }>(
        `SELECT id, balance_cents FROM accounts
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [[fromAccountId, toAccountId]],
      );
      const from = locked.rows.find((r) => r.id === fromAccountId);
      if (!from || locked.rows.length !== 2) throw new NotFoundError("account not found");

      await hooks.afterLock?.(client);

      if (from.balance_cents < amountCents) throw new InsufficientFundsError();

      await move(client, row.id, fromAccountId, -amountCents, "debit");
      await hooks.afterDebit?.(client);
      await move(client, row.id, toAccountId, amountCents, "credit");

      return { value: toTransfer(row), replayed: false };
    });
  } catch (err) {
    throw translatePgError(err);
  }
}

async function move(
  client: pg.PoolClient,
  transferId: string,
  accountId: string,
  deltaCents: number,
  kind: "debit" | "credit",
): Promise<void> {
  // Relative update (balance + delta), never "SET balance = <value computed in
  // JS>": if the lock were ever missing, a relative update still can't lose
  // a concurrent write, and the CHECK constraint still catches an overdraft.
  const updated = await client.query<{ balance_cents: number }>(
    "UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2 RETURNING balance_cents",
    [deltaCents, accountId],
  );
  await client.query(
    `INSERT INTO ledger_entries (account_id, transfer_id, kind, amount_cents, balance_after_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, transferId, kind, deltaCents, updated.rows[0]!.balance_cents],
  );
}

async function replay(client: pg.PoolClient, input: TransferInput): Promise<Created<Transfer>> {
  const { rows } = await client.query<TransferRow>(
    `SELECT id, from_account_id, to_account_id, amount_cents, created_at
       FROM transfers WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const prior = rows[0]!;
  const same =
    prior.from_account_id === input.fromAccountId &&
    prior.to_account_id === input.toAccountId &&
    prior.amount_cents === input.amountCents;
  if (!same) throw new IdempotencyConflictError();
  return { value: toTransfer(prior), replayed: true };
}

export async function getTransfer(pool: pg.Pool, id: string): Promise<Transfer> {
  const { rows } = await pool.query<TransferRow>(
    "SELECT id, from_account_id, to_account_id, amount_cents, created_at FROM transfers WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`transfer ${id} not found`);
  return toTransfer(rows[0]);
}

function translatePgError(err: unknown): unknown {
  const pgErr = err as { code?: string; constraint?: string };
  // FK violation on the transfers insert: one of the accounts doesn't exist.
  if (pgErr.code === "23503") return new NotFoundError("account not found");
  if (pgErr.code === "23514" && pgErr.constraint === "balance_js_safe") return new BalanceLimitError();
  // balance_non_negative should be unreachable (funds are checked under the
  // lock). If it ever fires, it's a bug: let it surface as a 500, the
  // transaction has already rolled back.
  return err;
}
