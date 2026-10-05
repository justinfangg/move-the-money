export const CURRENCY = "CAD";

export interface Account {
  id: string;
  balance_cents: number;
  currency: typeof CURRENCY;
  created_at: string;
}

export interface LedgerEntry {
  id: number;
  kind: "opening" | "debit" | "credit";
  amount_cents: number;
  balance_after_cents: number;
  transfer_id: string | null;
  /** Set when this entry belongs to a reversal: the transfer it undid. */
  reverses_transfer_id: string | null;
  counterparty_account_id: string | null;
  created_at: string;
}

export interface Transfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  currency: typeof CURRENCY;
  /** Set when this transfer is a reversal: the transfer it undoes. */
  reverses_transfer_id: string | null;
  created_at: string;
}

/** A transfer as looked up by id, with the reversal that undid it, if any. */
export interface TransferDetail extends Transfer {
  reversed_by_transfer_id: string | null;
}

/** Result of an idempotent create: `replayed` is true if nothing new happened. */
export interface Created<T> {
  value: T;
  replayed: boolean;
}
