#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type pg from "pg";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { AppError, ValidationError } from "./errors.js";
import { getAccount, listTransactions, openAccount } from "./ledger/accounts.js";
import { transfer } from "./ledger/transfer.js";
import { CURRENCY } from "./ledger/types.js";
import { formatCents, parseAmount } from "./money.js";

export const USAGE = `move-money: open accounts and move money between them, exactly.

Usage:
  move-money open <amount> [--key <key>]
  move-money balance <account-id>
  move-money transfer <from-account-id> <to-account-id> <amount> --key <key>
  move-money history <account-id> [--limit <n>]
  move-money migrate

Amounts are dollars with at most two decimal places, e.g. 25 or 25.50.
Anything finer than a cent is refused, not rounded.

Options:
  --key <key>    Idempotency key. Running a command again with the same key
                 applies it only once. Required for transfer: use a fresh key
                 for each transfer you intend, e.g. --key "$(uuidgen)", and
                 reuse it if you retry.
  --limit <n>    Number of history entries to show (default 20, max 500).
  --json         Print machine-readable JSON.
  -h, --help     Show this help.

Environment:
  DATABASE_URL   Postgres connection string
                 (default postgres://localhost:5432/move_money)

Exit codes:
  0 success   1 refused (insufficient funds, not found, key conflict)
  2 bad usage   3 unexpected error
`;

export const EXIT = { ok: 0, refused: 1, usage: 2, error: 3 } as const;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function run(argv: string[], pool: pg.Pool, io: Io): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (err) {
    io.err(`error: ${(err as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { positionals, values } = args;
  const [command, ...rest] = positionals;
  const json = values.json === true;

  if (values.help || command === undefined || command === "help") {
    io.out(USAGE);
    return command === undefined && !values.help ? EXIT.usage : EXIT.ok;
  }

  const print = (data: unknown, human: string) => io.out(json ? JSON.stringify(data, null, 2) : human);

  try {
    switch (command) {
      case "open": {
        const [amount] = expectArgs(rest, ["amount"]);
        const { value, replayed } = await openAccount(pool, {
          initialBalanceCents: parseAmount(amount, "amount"),
          idempotencyKey: values.key,
        });
        print(
          { account: value, replayed },
          replayed
            ? `Account ${value.id} was already opened with this key (balance ${money(value.balance_cents)}). Nothing new was created.`
            : `Opened account ${value.id} with ${money(value.balance_cents)}.`,
        );
        return EXIT.ok;
      }

      case "balance": {
        const [id] = expectArgs(rest, ["account-id"]);
        const account = await getAccount(pool, id);
        print(account, `${account.id}  ${money(account.balance_cents)}`);
        return EXIT.ok;
      }

      case "transfer": {
        const [from, to, amount] = expectArgs(rest, ["from-account-id", "to-account-id", "amount"]);
        if (values.key === undefined) {
          throw new ValidationError(
            'transfer needs --key, so that running it twice can\'t move the money twice. Use a fresh key per transfer, e.g. --key "$(uuidgen)", and reuse it to retry.',
          );
        }
        const { value, replayed } = await transfer(pool, {
          fromAccountId: from,
          toAccountId: to,
          amountCents: parseAmount(amount, "amount"),
          idempotencyKey: values.key,
        });
        print(
          { transfer: value, replayed },
          replayed
            ? `Already applied: transfer ${value.id} (${money(value.amount_cents)} from ${value.from_account_id} to ${value.to_account_id}). No money moved this time.`
            : `Transferred ${money(value.amount_cents)} from ${value.from_account_id} to ${value.to_account_id} (transfer ${value.id}).`,
        );
        return EXIT.ok;
      }

      case "history": {
        const [id] = expectArgs(rest, ["account-id"]);
        const limit = parseLimit(values.limit);
        const entries = await listTransactions(pool, id, limit);
        print({ entries }, formatHistory(entries));
        return EXIT.ok;
      }

      case "migrate": {
        expectArgs(rest, []);
        const applied = await migrate(pool);
        print({ applied }, applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
        return EXIT.ok;
      }

      default:
        throw new ValidationError(`unknown command "${command}"`);
    }
  } catch (err) {
    return report(err, io, json);
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      key: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function expectArgs<const N extends readonly string[]>(rest: string[], names: N): { [K in keyof N]: string } {
  if (rest.length !== names.length) {
    const want = names.length ? names.map((n) => `<${n}>`).join(" ") : "no arguments";
    throw new ValidationError(`expected ${want}, got ${rest.length} argument(s)`);
  }
  return rest as { [K in keyof N]: string };
}

function parseLimit(text: string | undefined): number {
  if (text === undefined) return 20;
  const n = Number(text);
  if (!/^[0-9]+$/.test(text) || n < 1 || n > 500) {
    throw new ValidationError("--limit must be a whole number from 1 to 500");
  }
  return n;
}

function money(cents: number): string {
  return `${formatCents(cents)} ${CURRENCY}`;
}

function formatHistory(entries: Awaited<ReturnType<typeof listTransactions>>): string {
  if (entries.length === 0) return "No transactions.";
  const rows = entries.map((e) => [
    e.created_at,
    e.kind,
    (e.amount_cents > 0 ? "+" : "") + formatCents(e.amount_cents),
    formatCents(e.balance_after_cents),
    e.kind === "debit" ? `to ${e.counterparty_account_id}` : e.kind === "credit" ? `from ${e.counterparty_account_id}` : "",
  ]);
  const header = ["when", "kind", "amount", "balance", "counterparty"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 2 || i === 3 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

function report(err: unknown, io: Io, json: boolean): number {
  if (err instanceof AppError) {
    io.err(json ? JSON.stringify({ error: err.code, message: err.message }) : `error: ${err.message}`);
    return err instanceof ValidationError ? EXIT.usage : EXIT.refused;
  }
  io.err(json ? JSON.stringify({ error: "internal_error", message: String(err) }) : `unexpected error: ${String(err)}`);
  return EXIT.error;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    // realpath, because `npm link` runs us through a symlink.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const pool = createPool(undefined, 2);
  const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
  run(process.argv.slice(2), pool, io)
    .then((code) => {
      process.exitCode = code;
    })
    .finally(() => pool.end());
}
