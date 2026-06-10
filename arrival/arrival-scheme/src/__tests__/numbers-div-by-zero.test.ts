// Caveat-sweep finding (2026-06-11, confirmed env-independent): inexact arithmetic
// over REAL operands ran the COMPLEX formula, so inf/0 in a cross-term (inf*0,
// 0/0) produced a spurious NaN imaginary part, and the complex toString branch
// (numbers.ts:407-413) is NaN/Infinity-blind → prints garbage "NaNNaNi" instead
// of the R7RS +inf.0 / -inf.0 / +nan.0.
import { describe, expect, it } from "vitest";
import { SchemeInexact } from "../numbers.js";

const inx = (real: number, imag = 0) => new SchemeInexact(real, imag);

describe("SchemeInexact real div/mul by zero — R7RS infinities (was 'NaNNaNi')", () => {
  it("1.0 / 0.0 → +inf.0", () => {
    expect(inx(1).div(inx(0)).toString()).toBe("+inf.0");
  });
  it("-1.0 / 0.0 → -inf.0", () => {
    expect(inx(-1).div(inx(0)).toString()).toBe("-inf.0");
  });
  it("0.0 / 0.0 → +nan.0", () => {
    expect(inx(0).div(inx(0)).toString()).toBe("+nan.0");
  });
  it("+inf.0 * 0.0 → +nan.0 (cross-term inf*0 must not leak into imag)", () => {
    expect(inx(Infinity).mul(inx(0)).toString()).toBe("+nan.0");
  });
  it("real div stays real (2.0 / 4.0 → 0.5)", () => {
    expect(inx(2).div(inx(4)).toString()).toBe("0.5");
  });

  // The toString complex branch must also survive a GENUINE complex with a
  // NaN/Infinity component (not collapse to "NaN...").
  it("complex with +inf.0 imaginary prints inf, not garbage", () => {
    expect(inx(1, Infinity).toString()).toContain("inf.0");
  });
  it("complex with +nan.0 imaginary prints nan, not 'NaN'", () => {
    expect(inx(1, NaN).toString()).toContain("nan.0");
  });
});
