// Algebras-in-entities cell: Setoid + Ord on SchemeString. The arbitrary biases
// toward the hard cases — empty string, unicode, and a small domain so
// collisions make symmetry/transitivity/antisymmetry bite. equalClone forges a
// fresh distinct-but-equal instance, exercising the value-equality (string-copy)
// contract a bare `===` would miss.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SchemeString } from "../LString.js";
import { ordLaws, setoidLaws } from "./algebra-laws.js";

const FL = "fantasy-land/equals";
const LTE = "fantasy-land/lte";

// Small domain + edge cases: "" (empty), astral unicode, ASCII collisions.
const arb = fc
  .oneof(
    fc.constantFrom("", "a", "b", "ab", "🦄", "🦄a", "naïve", "Z"),
    fc.string({ maxLength: 4 }),
  )
  .map((s) => new SchemeString(s));

const equalClone = (s: SchemeString) => new SchemeString(s.valueOf());

setoidLaws("SchemeString", { arb, equalClone });
ordLaws("SchemeString", arb);

describe("SchemeString Setoid/Ord — totality boundaries", () => {
  it("value equality over distinct heap instances", () => {
    const a = new SchemeString("🦄");
    const b = new SchemeString("🦄");
    expect((a as never)[FL](b)).toBe(true);
  });

  it("non-SchemeString other → false for both equals and lte", () => {
    const a = new SchemeString("a");
    expect((a as never)[FL]("a")).toBe(false);
    expect((a as never)[FL](42)).toBe(false);
    expect((a as never)[LTE]("a")).toBe(false);
    expect((a as never)[LTE](null)).toBe(false);
  });

  it("lexicographic lte agrees with JS string order", () => {
    const a = new SchemeString("ab");
    const b = new SchemeString("b");
    expect((a as never)[LTE](b)).toBe(true);
    expect((b as never)[LTE](a)).toBe(false);
  });
});
