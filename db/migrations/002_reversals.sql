-- Reversals. A reversal is an ordinary transfer that undoes an earlier one:
-- same amount, accounts swapped, linked back by reverses_transfer_id. It goes
-- through the same debit/credit path, so every existing rule and invariant
-- covers it too. Only full reversals, at most one per transfer.

ALTER TABLE transfers ADD COLUMN reverses_transfer_id uuid;

-- At most one reversal per transfer. Like the idempotency key, the unique
-- index is what makes this hold under concurrency: a second reversal with a
-- different key blocks here until the first commits, then fails.
ALTER TABLE transfers ADD CONSTRAINT one_reversal_per_transfer UNIQUE (reverses_transfer_id);

-- Only exists as the target of the foreign key below.
ALTER TABLE transfers ADD CONSTRAINT transfers_shape
    UNIQUE (id, from_account_id, to_account_id, amount_cents);

-- A reversal mirrors its original exactly: accounts swapped, same amount.
-- MATCH SIMPLE (the default) skips the check when reverses_transfer_id is
-- NULL, i.e. for ordinary transfers. "Can't reverse a reversal" is checked by
-- the application; enforcing it here would need a trigger.
ALTER TABLE transfers ADD CONSTRAINT reversal_mirrors_original
    FOREIGN KEY (reverses_transfer_id, to_account_id, from_account_id, amount_cents)
    REFERENCES transfers (id, from_account_id, to_account_id, amount_cents);
