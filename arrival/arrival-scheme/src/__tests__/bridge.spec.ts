/**
 * Bridge Tests - Verify LIPS ↔ New Types conversion
 */

import { describe, expect, it } from "vitest";
import { SchemeExact, SchemeInexact } from "../numbers";
import { coerceNumeric, wrapOperator, wrappedOps } from "../bridge";
import { add, mul, sqrt, sub } from "../operators";

describe("coerceNumeric", () => {
  describe("primitive types", () => {
    it("converts bigint to ExactNumber", () => {
      const result = coerceNumeric(42n);
      expect(result).toBeInstanceOf(SchemeExact);
      expect((result as SchemeExact).num).toBe(42n);
    });

    it("converts safe integer to ExactNumber", () => {
      const result = coerceNumeric(42);
      expect(result).toBeInstanceOf(SchemeExact);
      expect((result as SchemeExact).num).toBe(42n);
    });

    it("converts float to InexactNumber", () => {
      const result = coerceNumeric(3.14);
      expect(result).toBeInstanceOf(SchemeInexact);
      expect((result as SchemeInexact).real).toBe(3.14);
    });
  });

  describe("passthrough", () => {
    it("passes through ExactNumber", () => {
      const exact = new SchemeExact(42n);
      expect(coerceNumeric(exact)).toBe(exact);
    });

    it("passes through InexactNumber", () => {
      const inexact = new SchemeInexact(3.14);
      expect(coerceNumeric(inexact)).toBe(inexact);
    });
  });

  describe("objects with valueOf", () => {
    it("converts object with bigint valueOf", () => {
      const obj = { valueOf: () => 12345678901234567890n };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(SchemeExact);
      expect((result as SchemeExact).num).toBe(12345678901234567890n);
    });

    it("converts object with number valueOf to exact for safe integers", () => {
      const obj = { valueOf: () => 42 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(SchemeExact);
      expect((result as SchemeExact).num).toBe(42n);
    });

    it("converts object with number valueOf to inexact for floats", () => {
      const obj = { valueOf: () => 3.14 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(SchemeInexact);
      expect((result as SchemeInexact).real).toBe(3.14);
    });
  });

  it("throws on unconvertible value", () => {
    expect(() => coerceNumeric("not a number")).toThrow("Cannot convert");
    expect(() => coerceNumeric(null)).toThrow("Cannot convert");
    expect(() => coerceNumeric(undefined)).toThrow("Cannot convert");
  });
});

describe("wrapOperator", () => {
  it("wraps add operator", () => {
    const wrappedAdd = wrapOperator(add);

    // Should work with primitive numbers
    const result = wrappedAdd(1, 2, 3);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(6n);
  });

  it("wraps sub operator", () => {
    const wrappedSub = wrapOperator(sub);

    // Unary negation
    const neg = wrappedSub(5);
    expect(neg).toBeInstanceOf(SchemeExact);
    expect((neg as SchemeExact).num).toBe(-5n);

    // Binary subtraction
    const diff = wrappedSub(10, 3);
    expect(diff).toBeInstanceOf(SchemeExact);
    expect((diff as SchemeExact).num).toBe(7n);
  });

  it("wraps mul operator", () => {
    const wrappedMul = wrapOperator(mul);

    const result = wrappedMul(2, 3, 4);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(24n);
  });

  it("wraps sqrt operator", () => {
    const wrappedSqrt = wrapOperator(sqrt);

    const result = wrappedSqrt(4);
    // sqrt(4) = 2, which is a safe integer, so ExactNumber
    expect((result as SchemeExact).num).toBe(2n);
  });

  it("handles mixed exact/inexact", () => {
    const wrappedAdd = wrapOperator(add);

    const result = wrappedAdd(1, 2.5);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(3.5);
  });

  it("handles objects with valueOf", () => {
    const wrappedAdd = wrapOperator(add);

    // Object that returns 0.333... via valueOf
    const third = { valueOf: () => 1 / 3 };

    // 1/3 + 0.5 = 0.833... (inexact)
    const result = wrappedAdd(third, 0.5);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBeCloseTo(0.833, 2);
  });
});

describe("wrappedOps", () => {
  it("has + operator", () => {
    const result = (wrappedOps["+"] as Function)(1, 2, 3);
    expect((result as SchemeExact).num).toBe(6n);
  });

  it("has - operator", () => {
    const result = (wrappedOps["-"] as Function)(10, 3, 2);
    expect((result as SchemeExact).num).toBe(5n);
  });

  it("has * operator", () => {
    const result = (wrappedOps["*"] as Function)(2, 3);
    expect((result as SchemeExact).num).toBe(6n);
  });

  it("has / operator", () => {
    // R7RS: exact / exact = exact (rational 1/2)
    const result = (wrappedOps["/"] as Function)(1, 2);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(1n);
    expect((result as SchemeExact).denom).toBe(2n);
  });

  it("has zero? predicate", () => {
    expect((wrappedOps["zero?"] as Function)(0)).toBe(true);
    expect((wrappedOps["zero?"] as Function)(1)).toBe(false);
  });

  it("has comparison operators", () => {
    expect((wrappedOps["<"] as Function)(1, 2, 3)).toBe(true);
    expect((wrappedOps["<"] as Function)(1, 3, 2)).toBe(false);
    expect((wrappedOps["="] as Function)(2, 2, 2)).toBe(true);
    expect((wrappedOps[">"] as Function)(3, 2, 1)).toBe(true);
  });

  it("has bitwise operators", () => {
    const result = (wrappedOps["bitwise-and"] as Function)(0b1100, 0b1010);
    expect((result as SchemeExact).num).toBe(BigInt(0b1000));
  });

  it("has transcendentals", () => {
    const result = (wrappedOps["sqrt"] as Function)(4);
    expect(result.valueOf()).toBe(2);
  });

  it("has rounding functions", () => {
    expect((wrappedOps["floor"] as Function)(3.7).valueOf()).toBe(3);
    expect((wrappedOps["ceiling"] as Function)(3.2).valueOf()).toBe(4);
    expect((wrappedOps["round"] as Function)(2.5).valueOf()).toBe(2); // ties to even
  });

  // __doc__ support has been removed
});

describe("R7RS type predicates", () => {
  it("number?", () => {
    expect((wrappedOps["number?"] as Function)(42)).toBe(true);
    expect((wrappedOps["number?"] as Function)(3.14)).toBe(true);
    expect((wrappedOps["number?"] as Function)("42")).toBe(false);
  });

  it("complex?", () => {
    expect((wrappedOps["complex?"] as Function)(42)).toBe(true);
    expect((wrappedOps["complex?"] as Function)(3.14)).toBe(true);
    // All numbers are complex in Scheme
  });

  it("real?", () => {
    expect((wrappedOps["real?"] as Function)(42)).toBe(true);
    expect((wrappedOps["real?"] as Function)(3.14)).toBe(true);
    // Complex numbers with non-zero imaginary part would be false
  });

  it("rational?", () => {
    // Exact numbers are rational
    expect((wrappedOps["rational?"] as Function)(42)).toBe(true);
    // R7RS: finite reals are rational (can be represented as ratio)
    expect((wrappedOps["rational?"] as Function)(3.14)).toBe(true);
    // Infinity and NaN are not rational
    expect((wrappedOps["rational?"] as Function)(Infinity)).toBe(false);
    expect((wrappedOps["rational?"] as Function)(NaN)).toBe(false);
  });

  it("integer?", () => {
    expect((wrappedOps["integer?"] as Function)(42)).toBe(true);
    expect((wrappedOps["integer?"] as Function)(3.14)).toBe(false);
    // 3.0 is an integer value even though inexact
    expect((wrappedOps["integer?"] as Function)(3.0)).toBe(true);
  });

  it("exact?", () => {
    expect((wrappedOps["exact?"] as Function)(42)).toBe(true);
    expect((wrappedOps["exact?"] as Function)(3.14)).toBe(false);
  });

  it("inexact?", () => {
    expect((wrappedOps["inexact?"] as Function)(42)).toBe(false);
    expect((wrappedOps["inexact?"] as Function)(3.14)).toBe(true);
  });

  it("exact-integer?", () => {
    expect((wrappedOps["exact-integer?"] as Function)(42)).toBe(true);
    expect((wrappedOps["exact-integer?"] as Function)(3.14)).toBe(false);
    // Note: In JS, 3.0 === 3 so we can't distinguish them
    // To test inexact integers, use InexactNumber directly
    expect((wrappedOps["exact-integer?"] as Function)(new SchemeInexact(3))).toBe(false);
  });

  it("finite?", () => {
    expect((wrappedOps["finite?"] as Function)(42)).toBe(true);
    expect((wrappedOps["finite?"] as Function)(Infinity)).toBe(false);
  });

  it("infinite?", () => {
    expect((wrappedOps["infinite?"] as Function)(Infinity)).toBe(true);
    expect((wrappedOps["infinite?"] as Function)(-Infinity)).toBe(true);
    expect((wrappedOps["infinite?"] as Function)(42)).toBe(false);
  });

  it("nan?", () => {
    expect((wrappedOps["nan?"] as Function)(NaN)).toBe(true);
    expect((wrappedOps["nan?"] as Function)(42)).toBe(false);
  });
});

describe("integration scenarios", () => {
  it("handles chain of operations", () => {
    const add = wrappedOps["+"] as Function;
    const mul = wrappedOps["*"] as Function;
    const sub = wrappedOps["-"] as Function;

    // (+ (* 2 3) (- 10 5)) = 6 + 5 = 11
    const a = mul(2, 3);
    const b = sub(10, 5);
    const result = add(a, b);

    expect((result as SchemeExact).num).toBe(11n);
  });

  it("preserves exactness through operations", () => {
    const add = wrappedOps["+"] as Function;
    const mul = wrappedOps["*"] as Function;

    // All exact: 1 + 2 * 3 (exact)
    const result = add(1, mul(2, 3));
    expect(result).toBeInstanceOf(SchemeExact);
  });

  it("promotes to inexact when needed", () => {
    const add = wrappedOps["+"] as Function;

    // With R7RS: exact + exact = exact, so 1 + 1/3 = 4/3 (exact)
    // To test inexact promotion, we need an actual inexact operand
    const result = add(1, new SchemeInexact(0.5));
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(1.5);
  });
});
