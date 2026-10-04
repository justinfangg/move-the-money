-- Money is stored as BIGINT minor units (cents). Never floats, never NUMERIC
-- converted through a JS number. The upper bound on balances is
-- Number.MAX_SAFE_INTEGER so every value the database can hold is one the
-- application can represent exactly.

CREATE TABLE accounts (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    balance_cents    bigint      NOT NULL,
    idempotency_key  text        UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now(),

    -- Rule 1, enforced by the database as a backstop. The application checks
    -- funds under a row lock before debiting; this constraint means that even
    -- a bug in that logic can't commit a negative balance.
    CONSTRAINT balance_non_negative CHECK (balance_cents >= 0),
    CONSTRAINT balance_js_safe      CHECK (balance_cents <= 9007199254740991)
);

CREATE TABLE transfers (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Rule 3. The unique index is what makes "apply once" hold under
    -- concurrent retries: a second INSERT with the same key blocks until the
    -- first transaction commits or rolls back.
    idempotency_key  text        NOT NULL UNIQUE,
    from_account_id  uuid        NOT NULL REFERENCES accounts (id),
    to_account_id    uuid        NOT NULL REFERENCES accounts (id),
    amount_cents     bigint      NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT amount_positive   CHECK (amount_cents > 0),
    CONSTRAINT distinct_accounts CHECK (from_account_id <> to_account_id)
);

-- Append-only history. Every change to accounts.balance_cents has exactly one
-- row here, including the opening balance, so for every account
--   balance_cents = SUM(ledger_entries.amount_cents)
-- The tests check that invariant after every test.
CREATE TABLE ledger_entries (
    id                   bigserial   PRIMARY KEY,
    account_id           uuid        NOT NULL REFERENCES accounts (id),
    transfer_id          uuid        REFERENCES transfers (id),
    kind                 text        NOT NULL,
    amount_cents         bigint      NOT NULL,
    balance_after_cents  bigint      NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT kind_valid CHECK (kind IN ('opening', 'debit', 'credit')),
    CONSTRAINT sign_matches_kind CHECK (
        (kind = 'opening' AND amount_cents >= 0) OR
        (kind = 'debit'   AND amount_cents <  0) OR
        (kind = 'credit'  AND amount_cents >  0)
    ),
    CONSTRAINT transfer_iff_not_opening CHECK ((kind = 'opening') = (transfer_id IS NULL)),
    CONSTRAINT balance_after_non_negative CHECK (balance_after_cents >= 0)
);

CREATE INDEX ledger_entries_account_history ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_transfer ON ledger_entries (transfer_id);
