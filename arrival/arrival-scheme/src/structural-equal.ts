import { SchemeBool } from "./LBool.js";
import { SchemeSymbol } from "./LSymbol.js";
import { SchemeVector } from "./LVector.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { Nil, SchemeCharacter } from "./types.js";
import type { SchemeValue } from "./types.js";

/**
 * Cycle-safe structural deep-equality for Scheme values — the ONE `equal?`
 * implementation. Routed to by every surface: bridge.ts's `equal?`/`member`/
 * `assoc`, sandbox-env.ts's `equal?`, and ramda-functions.ts's `equals`.
 *
 * War story (2026-05-30 sandbox-escape audit): the old `JSON.stringify(a) ===
 * JSON.stringify(b)` fallback in `equal?` threw a NATIVE `TypeError: Converting
 * circular structure to JSON` on cyclic input — a host-implementation leak that
 * sandbox code couldn't `guard`. bridge.ts had a SEPARATE `deepEqual` that had
 * NO cycle guard at all (`(equal? l l)` on a cyclic `l` infinite-looped) and no
 * SchemeCharacter case (`(equal? #\a #\a)` → #f). ramda-functions bound `equals`
 * to `R.equals`, which knows nothing about Scheme numeric/provenance types.
 * Unifying onto this single walker fixes all three.
 *
 * This walks the two values in lock-step and tracks visited `(a, b)` reference
 * pairs so cycles terminate co-inductively (a node already being compared
 * against its partner is assumed equal — the standard R7RS-style occurs-check).
 * Returns a boolean for every input pair; never throws a native serialization
 * error.
 *
 * `seen` maps each visited `a`-reference to the SET of `b`-partners it has been
 * compared against on the current path. Two structures are equal iff the walk
 * never finds a mismatch; a re-encountered `(a, b)` pair short-circuits to true.
 */
export function structuralEqual(a: any, b: any, seen: Map<object, Set<object>> = new Map()): boolean {
  // Fast paths: identity, then valueOf-equality (covers SchemeExact/Inexact,
  // boxed primitives, SchemeCharacter's __char__ via valueOf) and SchemeString's
  // `__string__`.
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // SchemeVector: handle HERE (before the fantasy-land/equals hook below), inside
  // the `seen` occurs-check, so cyclic vectors terminate co-inductively instead of
  // recursing forever. The class's own `fantasy-land/equals` recurses with a FRESH
  // seen-map per call, so a mutually-cyclic pair would blow the JS stack if we let
  // the line-43 hook take it — breaking this walker's never-throws cycle-safety
  // contract (the war story above). Element recursion threads the shared `seen`.
  if (a instanceof SchemeVector || b instanceof SchemeVector) {
    if (!(a instanceof SchemeVector) || !(b instanceof SchemeVector)) return false;
    const av = a.__vector__;
    const bv = b.__vector__;
    if (av.length !== bv.length) return false;
    const partners = seen.get(a);
    if (partners?.has(b)) return true;
    if (partners) partners.add(b);
    else seen.set(a, new Set([b]));
    for (let i = 0; i < av.length; i++) {
      if (!structuralEqual(av[i], bv[i], seen)) return false;
    }
    return true;
  }

  // Setoid (Fantasy Land): a value that defines its own equality OWNS the comparison
  // — opaque entities (IP/hash/SID) whose canonical match differs from structural key
  // comparison (and whose sealed #fields make structural comparison meaningless). An
  // entity compared to a non-entity (a bare literal) returns false. Symmetric.
  if (typeof a?.["fantasy-land/equals"] === "function") return Boolean(a["fantasy-land/equals"](b));
  if (typeof b?.["fantasy-land/equals"] === "function") return Boolean(b["fantasy-land/equals"](a));

  const av = a?.valueOf?.();
  const bv = b?.valueOf?.();
  if (av === bv && (typeof av !== "object" || av === null)) return true;
  if (a.__string__ != null && b.__string__ != null) return a.__string__ === b.__string__;

  // Both must be objects to recurse; otherwise they're unequal primitives.
  if (typeof a !== "object" || typeof b !== "object") return false;

  // Occurs-check: if we're already comparing this exact (a, b) pair higher up
  // the stack, the structures are cyclic in the same shape → treat as equal.
  const partners = seen.get(a);
  if (partners?.has(b)) return true;
  if (partners) partners.add(b);
  else seen.set(a, new Set([b]));

  // LIPS Pairs: compare car/cdr structurally (handles cyclic lists).
  if (a instanceof Pair && b instanceof Pair) {
    return (
      structuralEqual(a.car, b.car, seen) &&
      structuralEqual(a.cdr, b.cdr, seen)
    );
  }
  if (a instanceof Pair || b instanceof Pair) return false;

  // Arrays (incl. SchemeJSArray sources are raw arrays by this point).
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Plain objects: same own-enumerable key set, structurally-equal values.
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!structuralEqual(a[k], b[k], seen)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// R7RS § 6.1 — the lower two tiers of the equivalence hierarchy (`eq?`/`eqv?`).
// `equal?` (structuralEqual, above) is the third. Co-located here so the three
// grades live in one equality leaf — and so the future Setoid (fantasy-land/
// equals) consolidation has a single home (see plan-2026-06-10-algebras-in-entities.md).
//
// War story: `eq?` and `eqv?` were both aliased to a single structural-ish
// `equal` helper whose string branch (`x.valueOf() === y.valueOf()`) collapsed
// distinct heap SchemeString instances to #t — flattening the three-tier R7RS
// hierarchy and breaking `memq`/`assv`/`case` dispatch and the atom-grade
// contract that `(eqv? (string-copy "a") (string-copy "a"))` MUST be #f.
//
// Why three functions, not two-plus-an-alias:
//   - `eq?` — pointer-grade. R7RS lets implementations make immediates (numbers,
//     chars, interned symbols, nil, booleans) answer #t across distinct heap
//     copies; we lean inclusive because the provenance clone machinery
//     (AValue.withProvenance) routinely mints copies of canonically-identifying
//     values that should still compare eq? — else `(eq? (if #t #f #t) (if #f #t #f))`
//     would surprise readers (both arms produce a SchemeBool(false) clone with a
//     different provenance heap-id, but the canonical answer is #t).
//   - `eqv?` — eq? plus explicit number/char value equality. eq? above already
//     covers SchemeExact/SchemeInexact (via .equals) and chars (__char__), so
//     eqv? reduces to eq? today. Kept distinct so any future divergence (NaN/±0,
//     exact/inexact crossing) lands in one named place.
//   - `equal?` — structural recursion (structuralEqual).
//
// Provenance-clone trap: `x === y` is NOT sufficient for symbols/nil/booleans —
// every withProvenance() call mints a fresh heap object. Use instance-aware
// checks so clones still compare eq? (else an `if`-induced clone of nil/#f fails
// eq? against the singleton, breaking `(eq? x '())`).
// ----------------------------------------------------------------------
export function eq(x: SchemeValue, y: SchemeValue): boolean {
  if (x === y) return true;
  if (x instanceof SchemeSymbol && y instanceof SchemeSymbol) return x.__name__ === y.__name__;
  if (x instanceof Nil && y instanceof Nil) return true;
  if (x instanceof SchemeBool && y instanceof SchemeBool) return x.value === y.value;
  if (x instanceof SchemeCharacter && y instanceof SchemeCharacter) return x.__char__ === y.__char__;
  if (x instanceof SchemeExact && y instanceof SchemeExact) return x.equals(y);
  if (x instanceof SchemeInexact && y instanceof SchemeInexact) return x.equals(y);
  // Everything else (Pair, vector/Array, SchemeString, plain objects) keeps
  // strict pointer-grade — distinct heap instances answer #f.
  return false;
}

export function eqv(x: SchemeValue, y: SchemeValue): boolean {
  // eqv? = eq? + explicit number/char equality, both already in eq() above.
  return eq(x, y);
}
