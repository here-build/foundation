// Caveat-sweep finding (2026-06-11): is_lambda (guards.ts:210) is DEAD for every
// real lambda — it gates on `typeof obj === "object"` but lambdas are FUNCTIONS,
// and it reads the SYMBOL __lambda__ while the evaluator sets the STRING
// "__lambda__" (evaluator.ts:415). Same symbol-vs-string class as the is_data_marked
// bug. The correct sibling is membrane.ts:115. Always-false self-masks (happy-path
// dispatch works), but anonymous membrane-crossing callbacks skip arg-unboxing.
import { describe, expect, it } from "vitest";
import { is_lambda } from "../guards.js";

describe("is_lambda recognizes a real lambda (was dead)", () => {
  it("a function with a string __lambda__ marker → true", () => {
    const fn = Object.assign(() => 0, { __lambda__: true });
    expect(is_lambda(fn)).toBe(true);
  });
  it("a function with the symbol __lambda__ marker → true", () => {
    const fn = Object.assign(() => 0, { [Symbol.for("__lambda__")]: true });
    expect(is_lambda(fn)).toBe(true);
  });
  it("a plain function (no marker) → false", () => {
    expect(is_lambda(() => 0)).toBe(false);
  });
  it("a non-function with a __lambda__ field → false (must be a function)", () => {
    expect(is_lambda({ __lambda__: true })).toBe(false);
  });
  it("null/undefined → false", () => {
    expect(is_lambda(null)).toBe(false);
    expect(is_lambda(undefined)).toBe(false);
  });
});
