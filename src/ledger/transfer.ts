import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import {
  AppError,
  IdempotencyConflictError,
  InsufficientFundsError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { requireCents } from "../money.js";
import { requireIdempotencyKey, requireUuid } from "../validate.js";
import { type Created, CURRENCY, type Transfer, type TransferDetail } from "./types.js";

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

export interface ReverseInput {
  transferId: string;
  idempotencyKey: string;
}

interface TransferRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  reverses_transfer_id: string | null;
  created_at: Date;
}

const TRANSFER_COLUMNS = "id, from_account_id, to_account_id, amount_cents, reverses_transfer_id, created_at";

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    amount_cents: row.amount_cents,
    currency: CURRENCY,
    reverses_transfer_id: row.reverses_transfer_id,
    created_at: row.created_at.toISOString(),
  };
}

export class BalanceLimitError extends AppError {
  constructor() {
    super("balance_limit_exceeded", "transfer would exceed the maximum account balance");
  }
}

export class AlreadyReversedError extends AppError {
  constructor(message = "transfer has already been reversed") {
    super("already_reversed", message);
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
  input = {
    fromAccountId: requireUuid(input.fromAccountId, "from account id"),
    toAccountId: requireUuid(input.toAccountId, "to account id"),
    amountCents: requireCents(input.amountCents, "amount", 1),
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
  };
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
         RETURNING ${TRANSFER_COLUMNS}`,
        [idempotencyKey, fromAccountId, toAccountId, amountCents],
      );
      const row = claimed.rows[0];
      if (!row) return replay(client, input);

      await settle(client, row, hooks, () => new InsufficientFundsError());
      return { value: toTransfer(row), replayed: false };
    });
  } catch (err) {
    throw translatePgError(err);
  }
}

/**
 * Undo an earlier transfer in full: move the same amount back from its
 * recipient to its sender, recorded as a new transfer that points at the
 * original. Same transaction shape and guarantees as `transfer`:
 *
 *   - The idempotency key makes retries safe; reusing it for anything other
 *     than reversing this same transfer is a conflict.
 *   - A transfer can be reversed at most once. A second attempt with a
 *     different key, even a concurrent one, is refused (the unique index on
 *     reverses_transfer_id decides the race).
 *   - If the recipient no longer has the money, the reversal is refused
 *     rather than driving their balance negative.
 */
export async function reverseTransfer(
  pool: pg.Pool,
  input: ReverseInput,
  hooks: TransferHooks = {},
): Promise<Created<Transfer>> {
  const transferId = requireUuid(input.transferId, "transfer id");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

  try {
    return await withTransaction(pool, async (client) => {
      // Transfers are never updated, so no lock is needed to read this one.
      const found = await client.query<TransferRow>(
        `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE id = $1`,
        [transferId],
      );
      const original = found.rows[0];
      if (!original) throw new NotFoundError(`transfer ${transferId} not found`);
      if (original.reverses_transfer_id !== null) {
        throw new ValidationError("cannot reverse a reversal");
      }

      const claimed = await client.query<TransferRow>(
        `INSERT INTO transfers (idempotency_key, from_account_id, to_account_id, amount_cents, reverses_transfer_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${TRANSFER_COLUMNS}`,
        [idempotencyKey, original.to_account_id, original.from_account_id, original.amount_cents, original.id],
      );
      const row = claimed.rows[0];
      if (!row) {
        const prior = await findByKey(client, idempotencyKey);
        if (prior.reverses_transfer_id !== transferId) throw new IdempotencyConflictError();
        return { value: toTransfer(prior), replayed: true };
      }

      await settle(
        client,
        row,
        hooks,
        () => new InsufficientFundsError("insufficient funds: the recipient no longer has the money to return"),
      );
      return { value: toTransfer(row), replayed: false };
    });
  } catch (err) {
    throw translatePgError(err);
  }
}

/**
 * Apply a transfer row that this transaction has just claimed: lock both
 * accounts, check funds, then debit and credit.
 */
async function settle(
  client: pg.PoolClient,
  row: TransferRow,
  hooks: TransferHooks,
  insufficientFunds: () => Error,
): Promise<void> {
  const { id, from_account_id: fromAccountId, to_account_id: toAccountId, amount_cents: amountCents } = row;

  // FOR NO KEY UPDATE, not FOR UPDATE. The caller's INSERT into transfers
  // already took FOR KEY SHARE on both accounts (that's how Postgres enforces the
  // foreign keys). FOR UPDATE conflicts with KEY SHARE, so two transfers
  // touching the same account would each hold KEY SHARE and wait for the
  // other to release it: a deadlock. That happened in the load tests.
  // FOR NO KEY UPDATE is compatible with KEY SHARE but still conflicts
  // with itself, so transfers on the same account still serialize here.
  // It's also the lock the UPDATE below would take anyway.
  const locked = await client.query<{ id: string; balance_cents: number }>(
    `SELECT id, balance_cents FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR NO KEY UPDATE`,
    [[fromAccountId, toAccountId]],
  );
  const from = locked.rows.find((r) => r.id === fromAccountId);
  if (!from || locked.rows.length !== 2) throw new NotFoundError("account not found");

  await hooks.afterLock?.(client);

  if (from.balance_cents < amountCents) throw insufficientFunds();

  await move(client, id, fromAccountId, -amountCents, "debit");
  await hooks.afterDebit?.(client);
  await move(client, id, toAccountId, amountCents, "credit");
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

async function findByKey(client: pg.PoolClient, idempotencyKey: string): Promise<TransferRow> {
  const { rows } = await client.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0]!;
}

async function replay(client: pg.PoolClient, input: TransferInput): Promise<Created<Transfer>> {
  const prior = await findByKey(client, input.idempotencyKey);
  // A reversal between the same accounts for the same amount is still a
  // different request: the key was used to undo something, not to send money.
  const same =
    prior.reverses_transfer_id === null &&
    prior.from_account_id === input.fromAccountId &&
    prior.to_account_id === input.toAccountId &&
    prior.amount_cents === input.amountCents;
  if (!same) throw new IdempotencyConflictError();
  return { value: toTransfer(prior), replayed: true };
}

export async function getTransfer(pool: pg.Pool, id: string): Promise<TransferDetail> {
  id = requireUuid(id, "transfer id");
  const { rows } = await pool.query<TransferRow & { reversed_by_transfer_id: string | null }>(
    `SELECT t.id, t.from_account_id, t.to_account_id, t.amount_cents, t.reverses_transfer_id, t.created_at,
            r.id AS reversed_by_transfer_id
       FROM transfers t
       LEFT JOIN transfers r ON r.reverses_transfer_id = t.id
      WHERE t.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`transfer ${id} not found`);
  return { ...toTransfer(row), reversed_by_transfer_id: row.reversed_by_transfer_id };
}

function translatePgError(err: unknown): unknown {
  const pgErr = err as { code?: string; constraint?: string };
  // FK violation on the transfers insert: one of the accounts doesn't exist.
  if (pgErr.code === "23503") return new NotFoundError("account not found");
  if (pgErr.code === "23514" && pgErr.constraint === "balance_js_safe") return new BalanceLimitError();
  // Lost the race to reverse this transfer to a request with a different key.
  if (pgErr.code === "23505" && pgErr.constraint === "one_reversal_per_transfer") return new AlreadyReversedError();
  // balance_non_negative should be unreachable (funds are checked under the
  // lock). If it ever fires, it's a bug: let it surface as a 500, the
  // transaction has already rolled back.
  return err;
}
