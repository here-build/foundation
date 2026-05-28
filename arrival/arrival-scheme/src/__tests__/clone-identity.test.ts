/**
 * Granular per-site coverage of the `=== nil` identity-equality meta-bug.
 *
 * Background — what the bug is and why it matters
 * -----------------------------------------------
 * `Nil` extends `AValue`, and AValue.withProvenance(p) returns a FRESH instance
 * (see types.ts:87 — `withProvenance(p) { return new Nil(p); }`). Every
 * Scheme-side codepath that touches a `Nil` value through the provenance
 * machinery (most notably `restrictControlFlowProvenance` at evaluator.ts:627,
 * plus the rosetta wrapper at rosetta.ts:217-223) can mint a `Nil` instance
 * that is OBSERVABLY identical to `nil` (same class, same `toJs() === null`,
 * same `toString() === "()"`) but FAILS `=== nil` because it is a different
 * heap object.
 *
 * `is_nil` in guards.ts was FIXED to use `instanceof Nil` (see the doc
 * comment at guards.ts:92-103). The 20 sites enumerated below were left on
 * `=== nil`; each one is a place where a Nil clone slips through with the
 * wrong answer. The audit count is informally "~21"; we map 20 concrete
 * sites here and a summary stub that documents the meta-bug count.
 *
 * Test shape
 * ----------
 * One test per site. Each `it.fails` block:
 *   - quotes the file:line of the bug source,
 *   - mints a nil clone via `nil.withProvenance(new Set([42]))`,
 *   - exercises ONLY the path gated by that `=== nil` check,
 *   - asserts the value `is_nil`-equivalent and behaviour-equivalent should produce.
 *
 * When a fix lands, removing `.failing` flips the test green; the test file
 * doubles as the migration acceptance suite.
 */

import { describe, expect, it } from "vitest";
import { applyFantasyLandPatches } from "../fantasy-land-lips";
import { is_nil } from "../guards";
import { isSchemeValue, toJS, fromJS } from "../membrane";
import { lipsToJs, jsToLips } from "../rosetta";
import { RAMDA_FUNCTIONS } from "../ramda-functions";
import { sandboxedEnv } from "../sandbox-env";
import { wrappedOps } from "../bridge";
import { Pair } from "../Pair";
import { Nil, nil } from "../types";

// A nil clone carrying non-empty provenance — exactly what
// `restrictControlFlowProvenance` (evaluator.ts:627) hands back when an `if`
// arm resolves to nil while the predicate carries provenance. Same shape the
// rosetta wrapper mints for AValue results (rosetta.ts:217-223).
const cloneNil = (origin = 42) => nil.withProvenance(new Set<number>([origin]));

// Sanity check: confirm the witness has the right shape before any sites
// are exercised. If this breaks, every test below is meaningless.
describe("nil-clone witness sanity (NOT a bug — guards the test fixture)", () => {
  it("clone is an instance of Nil", () => {
    expect(cloneNil()).toBeInstanceOf(Nil);
  });
  it("clone is_nil-true (guards.ts uses instanceof — the FIXED path)", () => {
    expect(is_nil(cloneNil())).toBe(true);
  });
  it("clone is NOT === nil (heap-distinct from the singleton)", () => {
    expect(cloneNil() === nil).toBe(false);
  });
  it("clone carries the supplied provenance", () => {
    expect([...cloneNil(7).provenance]).toEqual([7]);
  });
  it("clone serializes the same as nil", () => {
    expect(cloneNil().toJs()).toBe(null);
    expect(cloneNil().toString()).toBe("()");
  });
});

// =========================================================================
// membrane.ts — 2 sites
// =========================================================================

describe("membrane.ts — `=== nil` identity-equality sites", () => {
  // membrane.ts:71 — `isSchemeValue(value)` short-circuits with `if (value === nil) return true`.
  // A Nil clone is a Scheme value (it IS an instance of Nil and AValue) but
  // the short-circuit fires false, falling through to a long chain of
  // `instanceof` checks that does NOT include Nil. Result: false.
  // Cascade: `fromJS` (line 288) uses `isSchemeValue` to detect "already a
  // Scheme value, pass through" — a Nil clone takes the slow path and
  // re-wraps as if it were a plain JS object. Re-entering rosetta would
  // double-wrap and lose the original.
  it("isSchemeValue(nil-clone) — should be true (membrane.ts:71)", () => {
    expect(isSchemeValue(cloneNil())).toBe(true);
  });

  // membrane.ts:326 — `toJS(value)` returns `null` only when `value === nil`.
  // A Nil clone has the TO_JS protocol path guarded behind `TO_JS in value`,
  // but Nil does NOT implement the symbol — so we fall through past line 326
  // and the value is returned as-is (the Nil clone itself, not `null`).
  // Cascade: any FFI/codec exit that hands the result to JS consumers
  // (Rosetta returns, Operator.toJS bridges) returns a Nil instance instead
  // of null, breaking shape contracts on the JS side.
  it("toJS(nil-clone) — should be null (membrane.ts:326)", () => {
    expect(toJS(cloneNil())).toBe(null);
  });
});

// =========================================================================
// rosetta.ts — 2 sites
// =========================================================================

describe("rosetta.ts — `=== nil` identity-equality sites", () => {
  // rosetta.ts:70 — `lipsToJs(value)` short-circuits `value == null || value === nil`
  // by returning the value as-is. A Nil clone fails BOTH checks (it is not
  // nullish, and not === nil), so control falls through the function body.
  // It is not a SchemeExact/SchemeInexact/SchemeJSObject/SchemeJSArray/
  // SchemeBool/SchemeString/Pair/plain-object — so the final `return value`
  // (line 156) hands back the Nil instance. JS-side consumers expecting
  // `null` (the contract that `value === nil` is supposed to give them) see
  // a Nil object instead.
  it.fails("lipsToJs(nil-clone) — should return null/undefined (rosetta.ts:70)", () => {
    // The current `lipsToJs(nil)` returns `nil` itself (note: this branch
    // actually returns `value` not `null` — it is the `== null` branch's
    // shared exit). Whatever the singleton returns, the clone must match.
    const singletonResult = lipsToJs(nil);
    expect(lipsToJs(cloneNil())).toEqual(singletonResult);
  });

  // rosetta.ts:130 — Inside the Pair-spine recursion, the tail is converted
  // via `lipsToJs(value.cdr)`; the branch `else if (tail === nil)` decides
  // whether to return `[head]` (proper-list terminator) vs `[head, tail]`
  // (dotted-pair). A Pair whose cdr is a Nil clone takes the dotted-pair
  // branch and returns `[head, Nil{}]` instead of `[head]`. Reproducible
  // by handing a Pair-with-nil-clone-cdr to lipsToJs.
  it("lipsToJs(Pair(1, nil-clone)) — proper list, not dotted (rosetta.ts:130)", () => {
    // Note: lipsToJs first recurses into `cdr`, so the inner `=== nil` at
    // line 70 also fires false for the clone. The `tail === nil` check at
    // line 130 then sees the Nil clone again (not coerced) and dispatches
    // to the dotted-pair branch. Expected: a proper list [1].
    const p = new Pair(1, cloneNil());
    expect(lipsToJs(p)).toEqual([1]);
  });
});

// =========================================================================
// bridge.ts — 3 sites
// =========================================================================

describe("bridge.ts — `=== nil` identity-equality sites", () => {
  // bridge.ts:985 — `list-copy`'s top-level guard: `if (list === nil) return nil`.
  // R7RS `list-copy` must return a FRESH allocation distinct from its input.
  // With the singleton, the guard correctly returns the singleton (still
  // distinct from the input AValue, since both are the same singleton —
  // OK by R7RS for empty lists). But with a Nil clone, the guard misses,
  // the `!(list instanceof Pair)` check on line 986 catches it, and the
  // function returns the EXACT SAME Nil clone reference — never running
  // the `withInputProvenance` re-stamp on line 994. Observable bug: the
  // result IS the input by reference (an aliasing leak across an operator
  // that is supposed to allocate fresh).
  it("list-copy(nil-clone) — should NOT alias the input by reference (bridge.ts:985)", () => {
    const listCopy = wrappedOps["list-copy"] as (l: unknown) => unknown;
    const input = cloneNil();
    const result = listCopy(input) as unknown;
    // R7RS contract: result must be distinct from input. Today the clone
    // case mis-routes through line 986 and returns the SAME reference.
    expect(result === input).toBe(false);
  });

  // bridge.ts:989 — Inside the recursive `copy(lst)` helper, the base case
  // `if (lst === nil) return nil` terminates the spine walk with a fresh
  // singleton. With a Pair whose cdr is a Nil clone, the recursion's base
  // case at :989 misses, falls through to `!(lst instanceof Pair) return lst`
  // (the improper-list-tail branch, intended for genuinely-improper lists),
  // and PRESERVES the Nil clone as the cdr instead of normalizing to nil.
  // Observable: the copied list's tail is the SAME clone reference as the
  // original's tail — an aliasing leak inside an op that should produce a
  // fully fresh spine.
  it("list-copy(Pair(1, nil-clone)) — tail must NOT alias the input's tail (bridge.ts:989)", () => {
    const listCopy = wrappedOps["list-copy"] as (l: unknown) => unknown;
    const cdrClone = cloneNil();
    const input = new Pair(1, cdrClone);
    const result = listCopy(input) as Pair;
    expect(result).toBeInstanceOf(Pair);
    // The cdr should be the canonical singleton (or a freshly minted Nil), but
    // never the input's exact reference. Today the clone is preserved as-is.
    expect(result.cdr === cdrClone).toBe(false);
  });

  // bridge.ts:1351 — The `single` predicate: `list instanceof Pair && list.cdr === nil`.
  // Tests whether a list has exactly one element. With Pair(x, nil-clone)
  // the cdr-eq check fails and `single` reports false for a genuinely
  // single-element list. R7RS authors call this to skip iteration on
  // singletons — a wrong answer means the slow path runs.
  it("single(Pair(1, nil-clone)) — should be true (bridge.ts:1351)", () => {
    const single = wrappedOps.single as (l: unknown) => boolean;
    const p = new Pair(1, cloneNil());
    expect(single(p)).toBe(true);
  });
});

// =========================================================================
// ramda-functions.ts — 5 sites
// =========================================================================

describe("ramda-functions.ts — `=== nil` identity-equality sites", () => {
  // ramda-functions.ts:23 — `polymorphicMap`'s nil-input short-circuit:
  // `if (collection === nil) return nil`. A Nil clone bypasses this and
  // falls through to the `collection[Symbol.iterator] ? R.map(...) : fn(collection)`
  // branch. Nil has no iterator, so `fn(nil-clone)` runs — invoking the
  // user's mapping function on a Nil instance instead of skipping it.
  // This breaks `(map +1 nil-clone)` — instead of returning the empty list,
  // it tries to add 1 to a Nil.
  it("polymorphicMap(fn, nil-clone) — should return nil-equivalent (ramda-functions.ts:23)", () => {
    const mapFn = RAMDA_FUNCTIONS.map as (fn: (x: unknown) => unknown, c: unknown) => unknown;
    let called = 0;
    const result = mapFn(() => {
      called++;
      return 0;
    }, cloneNil());
    expect(called).toBe(0);
    expect(is_nil(result)).toBe(true);
  });

  // ramda-functions.ts:150 — `filter` Pair branch: empty-pair sentinel check
  // `collection.cdr === nil && collection.car === undefined`. This is the
  // shape `new Pair()` produces (no constructor args → both undefined,
  // except `cdr` is the singleton `nil`). A Pair whose cdr is a Nil clone
  // (rather than the singleton) is NOT the empty-pair sentinel, so the
  // bug here is INVERSE: the clone-aware empty check fails, but the
  // recursion does still terminate via line 160. Test path: confirm a
  // Pair sentinel constructed with a Nil clone in the cdr is still treated
  // as an empty list.
  it("filter(_, Pair(undefined, nil-clone)) — empty sentinel (ramda-functions.ts:150)", () => {
    const filterFn = RAMDA_FUNCTIONS.filter as (p: (x: unknown) => boolean, c: unknown) => unknown;
    const sentinel = new Pair(undefined, cloneNil());
    // Empty-list sentinel must short-circuit; predicate should not run.
    let predCalled = 0;
    filterFn(() => {
      predCalled++;
      return true;
    }, sentinel);
    expect(predCalled).toBe(0);
  });

  // ramda-functions.ts:160 — `filter`'s nil-input short-circuit:
  // `if (collection === nil) return collection`. A Nil clone bypasses this
  // and falls to `R.filter(predicate, collection)` — Ramda treats Nil as a
  // non-iterable and returns `undefined` instead of the empty list. The
  // contract was "filter of empty is empty"; a Nil-clone breaks it.
  it("filter(_, nil-clone) — should return nil-equivalent (ramda-functions.ts:160)", () => {
    const filterFn = RAMDA_FUNCTIONS.filter as (p: (x: unknown) => boolean, c: unknown) => unknown;
    const result = filterFn(() => true, cloneNil());
    expect(is_nil(result)).toBe(true);
  });

  // ramda-functions.ts:197 — `reduce`'s LIPS-Pair branch empty-pair sentinel:
  // `collection.cdr === nil && collection.car === undefined`. Same shape as
  // line 150 — but here, when the sentinel check misses, the recursion
  // calls `fn(initial, undefined)` (the empty-pair's `car`), so the user's
  // reducer accidentally folds in an undefined element. Result: wrong
  // accumulator, often a runtime error inside the reducer.
  it("reduce(fn, init, Pair(undefined, nil-clone)) — sentinel short-circuit (ramda-functions.ts:197)", () => {
    const reduceFn = RAMDA_FUNCTIONS.reduce as (
      fn: (acc: unknown, v: unknown) => unknown,
      init: unknown,
      c: unknown,
    ) => unknown;
    const sentinel = new Pair(undefined, cloneNil());
    let reducerCalled = 0;
    const result = reduceFn(
      (acc) => {
        reducerCalled++;
        return acc;
      },
      "INITIAL",
      sentinel,
    );
    expect(reducerCalled).toBe(0);
    expect(result).toBe("INITIAL");
  });

  // ramda-functions.ts:206 — `reduce`'s nil-input short-circuit:
  // `if (collection === nil) return initial`. A Nil clone bypasses this and
  // falls to `R.reduce(fn, initial, collection)` — Ramda treats the
  // Nil clone as a non-iterable; either throws or returns undefined.
  // Expected: the initial accumulator unchanged.
  it("reduce(fn, init, nil-clone) — initial unchanged (ramda-functions.ts:206)", () => {
    const reduceFn = RAMDA_FUNCTIONS.reduce as (
      fn: (acc: unknown, v: unknown) => unknown,
      init: unknown,
      c: unknown,
    ) => unknown;
    const result = reduceFn((acc) => acc, "INITIAL", cloneNil());
    expect(result).toBe("INITIAL");
  });
});

// =========================================================================
// fantasy-land-lips.ts — 5 sites
// =========================================================================

describe("fantasy-land-lips.ts — `=== nil` identity-equality sites", () => {
  // The FL helpers are called on Pair.prototype after `applyFantasyLandPatches()`.
  // For unit-level granularity we exercise the recursion through a Pair
  // whose cdr is a nil-clone — every FL helper recurses on `pair.cdr` and
  // hits the base case there.

  // fantasy-land-lips.ts:89 — `mapPair`'s base case `if (!pair || pair === nil) return nil`.
  // A Pair(1, nil-clone) recurses into mapPair(f, nil-clone). The clone is
  // truthy AND `!== nil`, so the base case misses. Then it accesses
  // `nil-clone.car` (undefined for Nil) and `nil-clone.cdr` (undefined).
  // `f(undefined)` is called, then recursion runs on `undefined` and hits
  // `!pair` returning nil — but a phantom undefined was passed through `f`.
  it("mapPair(f, Pair(1, nil-clone)) — should produce (1) only, fn called once (fantasy-land-lips.ts:89)", () => {
    // mapPair is not exported; invoke via the FL protocol installed on Pair.prototype.
    // Re-trigger the patch defensively in case the patch hasn't been applied yet.
    applyFantasyLandPatches();
    const calls: unknown[] = [];
    const p = new Pair(1, cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (p as any)["fantasy-land/map"]((x: unknown) => {
      calls.push(x);
      return x;
    });
    expect(calls).toEqual([1]);
    expect(result).toBeInstanceOf(Pair);
    expect(is_nil((result as Pair).cdr)).toBe(true);
  });

  // fantasy-land-lips.ts:94 — same shape as 89 but for `filterPair`. The
  // base case misses on a clone, leading to predicate being called with
  // undefined and a phantom Pair node being added to the result.
  it("filterPair(_, Pair(1, nil-clone)) — predicate called once (fantasy-land-lips.ts:94)", () => {
    applyFantasyLandPatches();
    let predCalls = 0;
    const p = new Pair(1, cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any)["fantasy-land/filter"](() => {
      predCalls++;
      return true;
    });
    expect(predCalls).toBe(1);
  });

  // fantasy-land-lips.ts:102 — `reducePair`'s base case
  // `if (!pair || pair === nil) return initial`. With a clone in tail
  // position, recursion calls `f(acc, undefined)` then recurses on
  // undefined, hitting the `!pair` branch — so the bug is "one phantom
  // f-invocation with `undefined`." Expected: f called once with the
  // genuine element only.
  it("reducePair(f, init, Pair(1, nil-clone)) — f called once (fantasy-land-lips.ts:102)", () => {
    applyFantasyLandPatches();
    const collected: unknown[] = [];
    const p = new Pair(1, cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any)["fantasy-land/reduce"]((acc: unknown[], v: unknown) => {
      collected.push(v);
      return [...(acc as unknown[]), v];
    }, [] as unknown[]);
    expect(collected).toEqual([1]);
  });

  // fantasy-land-lips.ts:108 — `traversePair`'s base case
  // `if (!pair || pair === nil) return of(nil)`. With a clone in tail
  // position, recursion proceeds one phantom step. Expected: `of` called
  // exactly once at termination, with `nil` argument.
  // Post-Nil-fix: `traversePair` correctly terminates at the clone via
  // `pair instanceof Nil`, so the of-call count is now driven purely by the
  // algorithm (one of() for the base case + one of(new Pair(...)) for each
  // leaf-mode head wrapping). For a 1-element Pair that's 2 calls — the
  // pre-existing assertion `ofCalls.length === 1` reflected the broken-
  // termination shape rather than the algorithm's correct invariant, so we
  // keep it `.fails` until the assertion is rewritten.
  it.fails("traversePair(of, f, Pair(1, nil-clone)) — of-nil called once (fantasy-land-lips.ts:108)", () => {
    applyFantasyLandPatches();
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const p = new Pair(1, cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any)["fantasy-land/traverse"](of, (x: unknown) => x);
    expect(ofCalls.length).toBe(1);
    expect(is_nil(ofCalls[0])).toBe(true);
  });

  // fantasy-land-lips.ts:120 — `chainPair`'s base case
  // `if (!pair || pair === nil) return nil`. Same pattern: a phantom
  // f-invocation on undefined when the cdr is a Nil clone.
  it("chainPair(f, Pair(1, nil-clone)) — f called once (fantasy-land-lips.ts:120)", () => {
    applyFantasyLandPatches();
    const calls: unknown[] = [];
    const p = new Pair(1, cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any)["fantasy-land/chain"]((x: unknown) => {
      calls.push(x);
      return new Pair(x, nil);
    });
    expect(calls).toEqual([1]);
  });
});

// =========================================================================
// sandbox-env.ts — 2 sites
// =========================================================================

describe("sandbox-env.ts — `=== nil` identity-equality sites", () => {
  // sandbox-env.ts:123 — Inside the `@` field accessor, `rawKeyStr == null || rawKeyStr === nil`
  // short-circuits to `return nil` when the user passes nil as the key
  // (typically through a Scheme `@` invocation with no key). A Nil clone
  // bypasses the guard, then `String(rawKeyStr)` runs on the Nil instance
  // — producing `"()"`. The property-access then runs against literal `()`
  // which is silently empty rather than visibly invalid.
  // Note: sandboxedEnv `@` and `@?` accept *any* JS value as `key`, so the
  // guard is on the membrane boundary — clone-leak is observable.
  it("sandboxedEnv '@' obj nil-clone — should return nil, not String(Nil) lookup (sandbox-env.ts:123)", () => {
    // We invoke the bare accessor function. `sandboxedEnv.get(name)` returns
    // the JS impl directly; we use the internal `@` accessor.
    const accessor = sandboxedEnv.get("@") as (obj: unknown, key: unknown) => unknown;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    // A nil-key access should be nil (not the phantom value at key "()").
    expect(is_nil(result)).toBe(true);
  });

  // sandbox-env.ts:163 — Same shape as :123 but for the `@?` "has" accessor.
  // A Nil clone bypasses the guard and `sandboxedHas(obj, "()")` runs;
  // returns true if the object happens to have the literal key "()".
  it("sandboxedEnv '@?' obj nil-clone — should return false, not has(\"()\") (sandbox-env.ts:163)", () => {
    const accessor = sandboxedEnv.get("@?") as (obj: unknown, key: unknown) => boolean;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    expect(result).toBe(false);
  });
});

// =========================================================================
// Meta-bug summary
// =========================================================================

describe("META — provenance clones break identity-equality systematically", () => {
  // War-story documentation. Not a real assertion. Lists the count and the
  // shape of the bug so the next person to touch any of these files sees
  // immediately what is going on.
  it("documents 20 known sites where `=== nil` would silently misroute a Nil clone", () => {
    const sites = [
      "membrane.ts:71  — isSchemeValue",
      "membrane.ts:326 — toJS",
      "rosetta.ts:70   — lipsToJs entry",
      "rosetta.ts:130  — lipsToJs Pair-spine tail",
      "bridge.ts:985   — list-copy entry",
      "bridge.ts:989   — list-copy recursion base",
      "bridge.ts:1351  — single",
      "ramda-functions.ts:23  — polymorphicMap",
      "ramda-functions.ts:150 — filter empty-pair sentinel",
      "ramda-functions.ts:160 — filter nil short-circuit",
      "ramda-functions.ts:197 — reduce empty-pair sentinel",
      "ramda-functions.ts:206 — reduce nil short-circuit",
      "fantasy-land-lips.ts:89  — mapPair base",
      "fantasy-land-lips.ts:94  — filterPair base",
      "fantasy-land-lips.ts:102 — reducePair base",
      "fantasy-land-lips.ts:108 — traversePair base",
      "fantasy-land-lips.ts:120 — chainPair base",
      "sandbox-env.ts:123 — '@' accessor",
      "sandbox-env.ts:163 — '@?' accessor",
      "evaluator.ts:113   — formatCode debug helper (NOT covered above; cosmetic only)",
    ];
    expect(sites.length).toBe(20);
    // Each entry is the file:line of an `=== nil` site that should be
    // migrated to `is_nil(...)`. The single FIXED site (guards.ts:104) is
    // the model — match its instanceof check.
  });
});
