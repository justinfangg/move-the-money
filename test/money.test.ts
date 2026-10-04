import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { formatCents, parseAmount, requireCents } from "../src/money.js";

describe("requireCents", () => {
  it("returns valid amounts unchanged", () => {
    expect(requireCents(1, "amount_cents", 1)).toBe(1);
    expect(requireCents(0, "initial_balance_cents", 0)).toBe(0);
    expect(Object.is(requireCents(-0, "initial_balance_cents", 0), 0)).toBe(true);
  });

  it.each([
    ["a float", 10.5],
    ["a numeric string", "10"],
    ["a decimal string", "10.00"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    ["a boolean", true],
  ])("rejects %s", (_label, value) => {
    expect(() => requireCents(value, "amount_cents", 1)).toThrow(ValidationError);
  });

  it("enforces the minimum", () => {
    expect(() => requireCents(0, "amount_cents", 1)).toThrow(/at least 1/);
    expect(() => requireCents(-5, "amount_cents", 1)).toThrow(/at least 1/);
    expect(() => requireCents(-1, "initial_balance_cents", 0)).toThrow(/at least 0/);
  });
});

describe("parseAmount (dollars typed by a human -> integer cents)", () => {
  it.each([
    ["0", 0],
    ["25", 2500],
    ["25.5", 2550],
    ["25.50", 2550],
    ["0.01", 1],
    // Number("0.29") * 100 === 28.999999999999996. The parser must not go
    // through floats at all.
    ["0.29", 29],
    ["1.15", 115],
    ["90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("%s => %i cents", (text, cents) => {
    expect(parseAmount(text)).toBe(cents);
  });

  it.each([
    ["more than two decimals", "25.555"],
    ["a sub-cent fraction", "0.001"],
    ["an exponent", "1e3"],
    ["a sign", "-5"],
    ["a plus sign", "+5"],
    ["a currency symbol", "$5"],
    ["thousands separators", "1,000"],
    ["a bare decimal point", "5."],
    ["no whole part", ".5"],
    ["leading zeros", "007"],
    ["whitespace", " 5"],
    ["empty", ""],
    ["too large to be exact", "90071992547409.92"],
  ])("rejects %s (%s)", (_label, text) => {
    expect(() => parseAmount(text)).toThrow(ValidationError);
  });
});

describe("formatCents", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [29, "0.29"],
    [2550, "25.50"],
    [-2550, "-25.50"],
    [Number.MAX_SAFE_INTEGER, "90071992547409.91"],
  ])("%i => %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it("round-trips with parseAmount", () => {
    for (const cents of [0, 1, 9, 10, 99, 100, 101, 12345, 987654321]) {
      expect(parseAmount(formatCents(cents))).toBe(cents);
    }
  });
});
