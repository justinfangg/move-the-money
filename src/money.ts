import { ValidationError } from "./errors.js";

/*
 * All money is an integer number of cents (CAD minor units). There is no
 * Money class and no decimal library on purpose: integers in the safe range
 * are exact in JS, Postgres BIGINT is exact, and the only arithmetic we do is
 * add/subtract/compare, which stays exact as long as we stay in range.
 *
 * The danger is at the edges, where values come in and go out as text.
 * parseAmount and formatCents convert without ever going through a float.
 */

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
    // Say it in dollars as well as cents: CLI users type dollars, and "must be
    // at least 1" after typing "0" reads as "at least one dollar".
    throw new ValidationError(
      min === 0
        ? `${field} can't be negative`
        : `${field} must be at least ${formatCents(min)} (${min} cent${min === 1 ? "" : "s"})`,
    );
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
