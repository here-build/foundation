import { describe, expect, it } from "vitest";

import { SchemeBool } from "../values/SchemeBool.js";
import { SchemeString } from "../values/SchemeString.js";
import { SchemeSymbol } from "../values/SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "../values/numbers.js";
import { structuralEqual } from "../values/structural-equal.js";
import { SchemeCharacter } from "../values/types.js";

// THE EQUALITY CONTRACT — representation-blindness (R7RS §6.1).
//
// `equal?` compares VALUES, not REPRESENTATIONS. A value that is BOXED (a SchemeString carrying
// provenance, minted by a chain-plane op) must compare equal to the SAME value UNBOXED (a plain JS
// string, e.g. a literal or a rosetta-unwrapped result) — `(equal? boxed unboxed)` is the SAME
// question as `(equal? unboxed unboxed)`. The chain plane boxes inconsistently (provenance-carrying
// inputs → boxed result; literals → plain), so any program that deduplicates / `member?`s / set-ops
// over derived values compares ACROSS the boxed↔unboxed boundary. If equal? is representation-strict
// there, dedup silently fails — the sift/closure.scm browser hang (unbounded doubling).
//
// Root cause: each primitive box's `fantasy-land/equals` is `other instanceof X && content`, and
// structuralEqual consults the Setoid BEFORE its valueOf content-check — so boxed-vs-unboxed short-
// circuits to false. This pack asserts the contract per type so the regression can't reappear.

const eq = (a: unknown, b: unknown): boolean => structuralEqual(a, b);

describe("equality contract — boxed ≡ unboxed (representation-blind)", () => {
  // STRINGS — the confirmed closure.scm bug. A boxed SchemeString MUST equal a content-identical
  // plain JS string, in both argument orders, while differing content stays unequal.
  it("string: boxed ≡ unboxed, symmetric, content-discriminating", () => {
    expect(eq(new SchemeString("f|b"), "f|b")).toBe(true); // boxed vs plain  ← the bug
    expect(eq("f|b", new SchemeString("f|b"))).toBe(true); // plain vs boxed (symmetry)
    expect(eq(new SchemeString("f|b"), new SchemeString("f|b"))).toBe(true); // boxed vs boxed
    expect(eq(new SchemeString("f|b"), "f|c")).toBe(false); // different content
    expect(eq(new SchemeString("f|b"), 5)).toBe(false); // string vs non-string
  });

  // BOOLEANS — same class (plain JS booleans appear via rosetta unwrapping).
  it("boolean: boxed ≡ unboxed, content-discriminating", () => {
    expect(eq(new SchemeBool(true), true)).toBe(true);
    expect(eq(true, new SchemeBool(true))).toBe(true);
    expect(eq(new SchemeBool(true), false)).toBe(false);
  });

  // NUMBERS — boxed ≡ boxed, and the exact/inexact GRADE must survive (R7RS: (equal? 1 1.0) ⇒ #f).
  // NOTE: plain-JS-number ↔ boxed-number is INTENTIONALLY NOT asserted representation-blind — a plain
  // JS number carries no exact/inexact grade, so equating it to a boxed exact would make
  // SchemeExact(1) ≡ plain-1 ≡ SchemeInexact(1.0) by transitivity, collapsing the grade. That's a
  // deferred design question (V). Strings/booleans have no grade, so they ARE representation-blind.
  it("number: boxed ≡ boxed, exact ≠ inexact (grade survives)", () => {
    expect(eq(new SchemeExact(1n, 1n), new SchemeExact(1n, 1n))).toBe(true);
    expect(eq(new SchemeExact(1n, 1n), new SchemeExact(2n, 1n))).toBe(false);
    expect(eq(new SchemeExact(1n, 1n), new SchemeInexact(1))).toBe(false); // 1 ≠ 1.0 (grade-strict)
  });

  // CHARACTERS & SYMBOLS — always boxed in practice (no plain-JS counterpart), so boxed-vs-boxed
  // is the live case; assert it stays correct (regression guard for the Setoid change).
  it("character & symbol: boxed ≡ boxed, content-discriminating", () => {
    expect(eq(new SchemeCharacter("a"), new SchemeCharacter("a"))).toBe(true);
    expect(eq(new SchemeCharacter("a"), new SchemeCharacter("b"))).toBe(false);
    expect(eq(SchemeSymbol.is ? new SchemeSymbol("x") : new SchemeSymbol("x"), new SchemeSymbol("x"))).toBe(true);
    expect(eq(new SchemeSymbol("x"), new SchemeSymbol("y"))).toBe(false);
  });
});
