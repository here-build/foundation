import { Pair } from "./Pair.js";

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
