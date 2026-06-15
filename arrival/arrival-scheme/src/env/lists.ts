/**
 * List ops — the R7RS § 6.4 pairs-and-lists cluster (the list constructors,
 * accessors, mutators, copy, and the search functions: memq/memv/assq/assv/
 * member/assoc), carved
 * VERBATIM out of `wrappedOps` in `../bridge.ts`. These are behavior-preserving
 * copies of the interpreter's hot-path list builtins; the implementations —
 * including their inline comments — are otherwise identical to the source. The
 * only change from the bridge originals is that cross-cutting helpers
 * (`withInputProvenance`, `eqv`) come from `../op-helpers.js`, the value-type
 * classes (`Pair`/`isCircularList`, `Nil`/`nil`) from their own leaf modules,
 * `structuralEqual` from `../structural-equal.js`, and `is_false` from
 * `../guards.js`, rather than being referenced as bridge locals. `TypeError`
 * carries its `.invariant` assertion via the side-effect import below. The
 * c[ad]+r accessor family is intentionally NOT declared here — those are served
 * by a resolver, not by `wrappedOps`.
 */

// Installs the global `TypeError.invariant` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";

import { eqv, withInputProvenance } from "../values/op-helpers.js";
import { isCircularList, Pair } from "../values/Pair.js";
import { structuralEqual } from "../values/structural-equal.js";
import { Nil, nil } from "../values/types.js";
import { is_false } from "../eval/guards.js";
import { EnvCapability } from "./capability.js";

export const LIST_OPS = {
  // R7RS 6.4 Pairs and lists
  "make-list"(k: unknown, fill?: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    const value = fill === undefined ? false : fill;
    let result: unknown = nil;
    for (let i = 0; i < count; i++) {
      result = new Pair(value, result);
    }
    // Stamp the head Pair only — internal cons cells share the same lineage
    // by definition; downstream traversal reads provenance off whichever pair
    // is bound. Parallel to lips.ts `cons` which only stamps the produced cell.
    return withInputProvenance(fill === undefined ? [k] : [k, fill], result);
  },

  "list-tail"(list: unknown, k: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-tail: list too short`);
      current = current.cdr;
    }
    return current;
  },

  "list-ref"(list: unknown, k: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-ref: list too short`);
      current = current.cdr;
    }
    TypeError.invariant(current instanceof Pair, `list-ref: index out of bounds`);
    return current.car;
  },

  "list-set!"(list: unknown, k: unknown, obj: unknown): void {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-set!: list too short`);
      current = current.cdr;
    }
    TypeError.invariant(current instanceof Pair, `list-set!: index out of bounds`);
    current.car = obj;
  },

  "list-copy"(list: unknown): unknown {
    // `=== nil` would miss Nil clones (singletons minted via withProvenance by
    // the evaluator's control-flow provenance pass). A clone bypassed the
    // guard, fell to the `!(instanceof Pair)` improper-list branch on the next
    // line, and aliased the input by reference — violating R7RS list-copy's
    // fresh-allocation contract. `instanceof Nil` keeps the freshness story
    // intact for both the singleton and any clones.
    if (list instanceof Nil) return nil;
    if (!(list instanceof Pair)) return list;
    if (isCircularList(list)) TypeError.invariant(false, "list-copy: circular list");
    // Deep copy the spine of the list
    const copy = (lst: unknown): unknown => {
      // Same clone-aware check at the recursion base: a Nil clone in the cdr
      // would otherwise be preserved as an improper-list tail.
      if (lst instanceof Nil) return nil;
      if (!(lst instanceof Pair)) return lst; // improper list tail
      return new Pair(lst.car, copy(lst.cdr));
    };
    // Copy is a fresh allocation but semantically the same lineage as `list`.
    return withInputProvenance([list], copy(list));
  },

  // R7RS 6.4 List searching functions
  memq(obj: unknown, list: unknown): unknown {
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "memq: circular list");
    while (current instanceof Pair) {
      // eq? comparison (object identity)
      if (current.car === obj) return current;
      current = current.cdr;
    }
    return false;
  },

  memv(obj: unknown, list: unknown): unknown {
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "memv: circular list");
    while (current instanceof Pair) {
      if (eqv(current.car, obj)) return current;
      current = current.cdr;
    }
    return false;
  },

  assq(obj: unknown, alist: unknown): unknown {
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assq: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && pair.car === obj) return pair;
      current = current.cdr;
    }
    return false;
  },

  assv(obj: unknown, alist: unknown): unknown {
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assv: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && eqv(pair.car, obj)) return pair;
      current = current.cdr;
    }
    return false;
  },

  // member uses equal? (deep structural equality)
  member(obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "member: circular list");
    while (current instanceof Pair) {
      // `cmp` may be a user-supplied Scheme predicate whose result is a boxed
      // SchemeBool post-L1 (a truthy JS object); route through is_false.
      if (!is_false(cmp(obj, current.car))) return current;
      current = current.cdr;
    }
    return false;
  },

  // assoc uses equal? (deep structural equality)
  assoc(obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assoc: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      // `cmp` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
      if (pair instanceof Pair && !is_false(cmp(obj, pair.car))) return pair;
      current = current.cdr;
    }
    return false;
  },
};

export default new EnvCapability("scheme/lists", {
  symbols: Object.fromEntries(Object.entries(LIST_OPS).map(([k, v]) => [k, { value: v }])),
});
