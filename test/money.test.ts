import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { parseJsonStrict, requireCents } from "../src/money.js";

describe("parseJsonStrict", () => {
  it("accepts plain integer literals", () => {
    expect(parseJsonStrict('{"amount_cents": 12345}')).toEqual({ amount_cents: 12345 });
    expect(parseJsonStrict('{"amount_cents": 0}')).toEqual({ amount_cents: 0 });
    expect(parseJsonStrict(`{"amount_cents": ${Number.MAX_SAFE_INTEGER}}`)).toEqual({
      amount_cents: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ["a fraction", "10.5"],
    ["a trailing .0", "10.0"],
    // The dangerous one: JSON.parse turns this into exactly 100, so no check
    // on the parsed value could ever tell it apart from a legitimate 100.
    ["a fraction below double precision", "100.000000000000001"],
    ["an exponent", "1e2"],
    ["a negative exponent", "10000e-2"],
  ])("rejects %s (%s)", (_label, literal) => {
    expect(() => parseJsonStrict(`{"amount_cents": ${literal}}`)).toThrow(ValidationError);
  });

  it("rejects integers that would be rounded by the double conversion", () => {
    // 2^53 + 1 parses to 2^53: a cent silently disappears.
    expect(() => parseJsonStrict('{"amount_cents": 9007199254740993}')).toThrow(ValidationError);
  });

  it("checks nested numbers too", () => {
    expect(() => parseJsonStrict('{"a": [1, {"b": 2.5}]}')).toThrow(ValidationError);
  });
});

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
