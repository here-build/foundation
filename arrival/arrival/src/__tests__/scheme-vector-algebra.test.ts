// Algebras-in-entities cell: Setoid + Semigroup + Functor on SchemeVector.
// Elements are plain JS numbers from a small domain so collisions make the
// Setoid laws (symmetry/transitivity) bite; the Functor transforms are
// number→number. equalClone forges a fresh distinct-but-equal payload.
// (Boxing track S5 — docs/plan-2026-06-10-boxing-track.md.)
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SchemeVector } from "../values/SchemeVector.js";
import { functorLaws, semigroupLaws, setoidLaws } from "./algebra-laws.js";

const FL = "fantasy-land/equals";
const CONCAT = "fantasy-land/concat";
const MAP = "fantasy-land/map";

// Small element domain + edge cases: empty, singletons, collisions.
const arb = fc
  .oneof(
    fc.constantFrom<number[]>([], [0], [1], [1, 2], [1, 2, 3], [2, 1]),
    fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 4 }),
  )
  .map((xs) => new SchemeVector(xs));

const equalClone = (v: SchemeVector) => new SchemeVector(v.__vector__.slice());

setoidLaws("SchemeVector", { arb, equalClone });
semigroupLaws("SchemeVector", arb);
functorLaws("SchemeVector", {
  arb,
  f: (x: number) => x + 1,
  g: (x: number) => x * 2,
});

describe("SchemeVector Setoid/Semigroup/Functor — boundaries", () => {
  it("structural value equality over distinct heap payloads", () => {
    const a = new SchemeVector([1, 2, 3]);
    const b = new SchemeVector([1, 2, 3]);
    expect((a as never)[FL](b)).toBe(true);
  });

  it("nested-vector equality recurses through structuralEqual", () => {
    const a = new SchemeVector([new SchemeVector([1, 2]), 3]);
    const b = new SchemeVector([new SchemeVector([1, 2]), 3]);
    expect((a as never)[FL](b)).toBe(true);
    const c = new SchemeVector([new SchemeVector([1, 9]), 3]);
    expect((a as never)[FL](c)).toBe(false);
  });

  it("non-SchemeVector other → false (a raw array is NOT a SchemeVector)", () => {
    const a = new SchemeVector([1, 2]);
    expect((a as never)[FL]([1, 2])).toBe(false);
    expect((a as never)[FL](42)).toBe(false);
  });

  it("concat appends elements, length-additive", () => {
    const a = new SchemeVector([1, 2]);
    const b = new SchemeVector([3]);
    const c = (a as never)[CONCAT](b) as SchemeVector;
    expect(c.__vector__).toEqual([1, 2, 3]);
  });

  it("map produces a fresh vector, leaves the source untouched", () => {
    const a = new SchemeVector([1, 2, 3]);
    const mapped = (a as never)[MAP]((x: number) => x * 10) as SchemeVector;
    expect(mapped.__vector__).toEqual([10, 20, 30]);
    expect(a.__vector__).toEqual([1, 2, 3]);
  });

  it("toJs / TO_JS unwrap to the raw array", () => {
    const a = new SchemeVector([1, 2, 3]);
    expect(a.toJs()).toEqual([1, 2, 3]);
    expect(Array.isArray(a.toJs())).toBe(true);
  });
});
