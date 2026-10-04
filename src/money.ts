import { ValidationError } from "./errors.js";

/*
 * All money is an integer number of cents (CAD minor units). There is no
 * Money class and no decimal library on purpose: integers in the safe range
 * are exact in JS, Postgres BIGINT is exact, and the only arithmetic we do is
 * add/subtract/compare, which stays exact as long as we stay in range.
 *
 * The danger is at the edges, where values come in:
 *   - JSON numbers are IEEE-754 doubles. JSON.parse("100.000000000000001")
 *     is exactly 100, and JSON.parse("9007199254740993") is ...992. By the
 *     time you have a JS number, the fraction or the last digit is already
 *     gone, so validation *after* parsing can't see it.
 *   - So request bodies are parsed with parseJsonStrict, which looks at each
 *     number's source text and rejects anything that isn't a plain integer
 *     literal.
 */

const INTEGER_LITERAL = /^-?(0|[1-9][0-9]*)$/;

type ReviverContext = { source?: string } | undefined;

/**
 * JSON.parse, except that every number in the document must be written as a
 * plain integer literal (no fraction, no exponent), and must fit exactly in a
 * JS number. Relies on JSON.parse source text access (Node 22+).
 */
export function parseJsonStrict(text: string): unknown {
  return JSON.parse(text, function (this: unknown, key: string, value: unknown, ctx?: ReviverContext) {
    if (typeof value === "number") {
      const source = ctx?.source;
      const where = key === "" ? "body" : `"${key}"`;
      if (source !== undefined && !INTEGER_LITERAL.test(source)) {
        throw new ValidationError(`${where} must be an integer number of cents, got ${source}`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new ValidationError(`${where} is too large to represent exactly, got ${source ?? value}`);
      }
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

/**
 * Validate an amount in cents that has already been parsed. Accepts only safe
 * integers >= `min`. Strings are rejected rather than coerced: "10" and "10.00"
 * mean different things to different clients and we'd rather they tell us.
 */
export function requireCents(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer number of cents`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} is too large`);
  }
  if (value < min) {
    throw new ValidationError(`${field} must be at least ${min}`);
  }
  return value === 0 ? 0 : value; // normalise -0
}

const DOLLAR_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/**
 * Parse a human-typed dollar amount ("25", "25.5", "25.50") into integer
 * cents, using string and BigInt arithmetic only: Number("0.29") * 100 is
 * 28.999999999999996, so the obvious one-liner is wrong.
 *
 * Anything that can't be represented exactly in cents is refused, never
 * rounded: "25.555", "1e3", "-5", "$5", "1,000", ".5".
 */
export function parseAmount(text: string, field = "amount"): number {
  const match = DOLLAR_AMOUNT.exec(text);
  if (!match) {
    throw new ValidationError(
      `${field} must be a dollar amount with at most two decimal places, like 25 or 25.50 (got "${text}")`,
    );
  }
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(`${field} is too large`);
  }
  return Number(cents);
}

/** Format integer cents as dollars, e.g. -2550 => "-25.50". Exact. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
