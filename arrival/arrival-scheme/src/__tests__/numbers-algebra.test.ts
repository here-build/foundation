// Reference cell for the algebras-in-entities migration: Setoid on the number
// types. Proves the A2 law-checker end-to-end AND fixes the live
// `(equal? 1 1.0) → #t` bug (structuralEqual consults fantasy-land/equals first,
// so the exact/inexact instances now answer correctly).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SchemeExact, SchemeInexact } from "../numbers.js";
import { structuralEqual } from "../structural-equal.js";
import { setoidLaws } from "./algebra-laws.js";

const FL = "fantasy-land/equals";

// Exact rationals over a small domain (collisions exercise symmetry/transitivity).
const exactArb = fc
  .tuple(fc.bigInt({ min: -50n, max: 50n }), fc.bigInt({ min: 1n, max: 50n }))
  .map(([num, denom]) => new SchemeExact(num, denom));

// Inexact reals incl. NaN / ±0 / ±Infinity — the cases that bite reflexivity.
const inexactArb = fc
  .double({ noDefaultInfinity: false, noNaN: false })
  .map((real) => new SchemeInexact(real));

setoidLaws("SchemeExact", { arb: exactArb, equalClone: (a) => new SchemeExact(a.num, a.denom) });
setoidLaws("SchemeInexact", { arb: inexactArb, equalClone: (a) => new SchemeInexact(a.real, a.imag) });

describe("number Setoid — exactness boundary (the (equal? 1 1.0) fix)", () => {
  it("exact 1 is NOT fantasy-land/equals inexact 1.0 (both directions)", () => {
    const one = new SchemeExact(1n);
    const oneFloat = new SchemeInexact(1);
    expect((one as never)[FL](oneFloat)).toBe(false);
    expect((oneFloat as never)[FL](one)).toBe(false);
  });

  it("structuralEqual honors the exactness boundary (the bug)", () => {
    // Before: structuralEqual collapsed via valueOf → #t. Now its FL/equals
    // consult-hook catches the number instances first → correct #f.
    expect(structuralEqual(new SchemeExact(1n), new SchemeInexact(1))).toBe(false);
    expect(structuralEqual(new SchemeExact(1n), new SchemeExact(1n))).toBe(true);
    expect(structuralEqual(new SchemeInexact(1), new SchemeInexact(1))).toBe(true);
  });

  it("NaN reflexivity holds (Object.is, not ===)", () => {
    const nan = new SchemeInexact(NaN);
    expect((nan as never)[FL](new SchemeInexact(NaN))).toBe(true);
  });
});
