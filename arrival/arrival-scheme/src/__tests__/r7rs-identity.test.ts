/**
 * R7RS identity-predicate conformance — bug ledger.
 *
 * Why this file exists
 * --------------------
 * R7RS § 6.1 defines a three-level hierarchy: `eq?` (pointer-grade), `eqv?`
 * (atom-grade, including same-numeric-value with same-exactness), and `equal?`
 * (structural, recurses into pairs/vectors/strings). The three are NOT
 * interchangeable — collapsing them breaks `memq`/`assv`/`hash-table-ref/eqv`/
 * `case` dispatch.
 *
 * Our current `eq?` and `eqv?` are both aliased to a single `equal` helper at
 * `lips.ts:3634-3635`. That helper takes a partial-deep stance:
 *   - For Pair / Array / unknown objects it falls through to `else x === y`
 *     (lips.ts:674) — happens to match the R7RS pointer-grade answer.
 *   - For strings (lips.ts:670-672) it value-compares via `valueOf()` — wrong:
 *     two distinct heap SchemeString instances compare equal, collapsing
 *     eq?/eqv? into a string-equal? shape.
 *
 * The string path is the load-bearing identity bug. Symbol interning and the
 * accidental-correct Pair/Array path are guarded as passing invariants so any
 * future patch that "unifies" `equal` won't silently regress the right answers.
 *
 * Style — each `it.fails` describes EXPECTED R7RS behavior. `it.fails` is
 * vitest 4's "this should fail; passing = regression" — perfect for bug
 * ledgers (when the bug gets fixed, removing `.fails` flips the test green).
 */

import { describe, expect, it } from "vitest";
import { env, exec } from "../lips";
import { initBridge } from "../bridge";

await initBridge();

/** Coerce a Scheme result to a JS primitive — handles SchemeBool wrapper and raw JS booleans. */
const truthy = (r: unknown): boolean => {
  if (typeof r === "boolean") return r;
  if (r && typeof r === "object" && "value" in (r as { value?: unknown })) {
    return Boolean((r as { value: unknown }).value);
  }
  if (r && typeof (r as { valueOf?: unknown }).valueOf === "function") {
    return Boolean((r as { valueOf: () => unknown }).valueOf());
  }
  return Boolean(r);
};

async function evalScheme(src: string): Promise<unknown> {
  const [r] = await exec(src, { env });
  return r;
}

describe("r7rs identity — passing invariants (regression guards)", () => {
  it("eq? on interned symbols is #t (R7RS § 6.1)", async () => {
    // Symbols are interned by the parser — both occurrences of 'foo resolve
    // to the same heap SchemeSymbol, so eq? must be #t.
    const r = await evalScheme("(eq? 'foo 'foo)");
    expect(truthy(r)).toBe(true);
  });

  it("eq? on two distinct (list 1) calls is #f (R7RS § 6.1)", async () => {
    // Each `list` call mints a fresh Pair → in `equal` (lips.ts:633) Pair has
    // no special-case branch → falls through to `else x === y` (lips.ts:674)
    // → returns false. Correct by accident — guard against a future "let's
    // deepEqual into pairs" rewrite that would silently flip this to #t.
    const r = await evalScheme("(eq? (list 1) (list 1))");
    expect(truthy(r)).toBe(false);
  });

  it("eqv? on two distinct vector copies is #f (R7RS § 6.1)", async () => {
    // Vectors are JS Arrays; `equal` falls through to `else x === y` →
    // reference identity → #f. R7RS-correct by accident; regression guard.
    const r = await evalScheme(`(eqv? (vector 1 2) (vector 1 2))`);
    expect(truthy(r)).toBe(false);
  });

  it("string-length counts code points, not UTF-16 code units (R7RS § 6.7)", async () => {
    // The public `string-length` binding lives at `bridge.ts:680` and uses
    // `[...str].length` (code-point iteration). The internal LString getter
    // at `LString.ts:45` uses `.__string__.length` (code units, would be 2
    // for "😀"); that getter is NOT exposed to Scheme. Guard that the public
    // binding is the one Scheme code sees.
    const r = await evalScheme(`(string-length "😀")`);
    expect(Number((r as { valueOf: () => unknown }).valueOf())).toBe(1);
  });
});

describe("r7rs identity — known bugs (it.fails — flipping to green = regression of the bug)", () => {
  it.fails(
    "eq? on two distinct string-copy results SHOULD be #f (R7RS § 6.1)",
    async () => {
      // R7RS § 6.1: `(eq? "x" "x")` on literals is implementation-defined,
      // BUT distinct heap instances (`string-copy` minted fresh objects)
      // should not compare eq? — the predicate is meant to be at most a
      // pointer-grade check. Current bug: `lips.ts:670-672` compares strings
      // via `.valueOf()`, returning #t for two unrelated heap instances.
      // This collapses eq?/eqv? into string-equal? shape, breaking the
      // R7RS three-tier hierarchy.
      //
      // Predicted failure value: result === #t (truthy) instead of #f.
      const r = await evalScheme(`(eq? (string-copy "abc") (string-copy "abc"))`);
      expect(truthy(r)).toBe(false);
    },
  );

  it.fails(
    "eqv? on two distinct string-copy results SHOULD be #f (R7RS § 6.1)",
    async () => {
      // Same root cause: `lips.ts:3634-3635` aliases both eq? and eqv? to
      // the same `equal` helper. R7RS § 6.1 leaves eqv? on string literals
      // unspecified, but the same-instance-vs-fresh-instance distinction
      // must be respected — value-comparing-via-valueOf makes eqv?
      // indistinguishable from equal? for strings.
      //
      // Predicted failure value: result === #t (truthy) instead of #f.
      const r = await evalScheme(`(eqv? (string-copy "abc") (string-copy "abc"))`);
      expect(truthy(r)).toBe(false);
    },
  );

  it.fails(
    "eqv? on two distinct make-string results SHOULD be #f (R7RS § 6.1)",
    async () => {
      // Same alias chain exercised through a different constructor. Every
      // `make-string` call mints a fresh SchemeString; eqv? on two distinct
      // heap instances should answer #f under atom-grade semantics, but the
      // `equal`-via-valueOf path collapses them to #t.
      //
      // Predicted failure value: result === #t (truthy) instead of #f.
      const r = await evalScheme(`(eqv? (make-string 1 #\\a) (make-string 1 #\\a))`);
      expect(truthy(r)).toBe(false);
    },
  );
});
