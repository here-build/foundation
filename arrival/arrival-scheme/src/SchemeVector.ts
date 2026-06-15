/**
 * Boxes a raw JS array into the AValue kernel so it carries provenance and
 * hosts Fantasy Land algebra instances. Modeled on SchemeString / SchemeBytevector.
 * Vectors are MUTABLE (vector-set!/fill!/copy!) — the payload stays writable.
 *
 * THE DISAMBIGUATION (boxing plan §1): a raw JS `Array` is heavily overloaded
 * here — the evaluateArgs args carrier, Values, HalfBaked, syntax-rules ellipsis
 * machinery, and JS-array-as-list at the membrane are ALL raw arrays and are NOT
 * vectors. Only vector literals / make-vector / vector builtins mint SchemeVector.
 * Being its own class leaves the `Array.isArray` sites unaffected — NEVER widen
 * them to accept it.
 *
 * Boxing track: docs/plan-2026-06-10-boxing-track.md (S5).
 */
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "./interop-access.js";
import { structuralEqual } from "./structural-equal.js";
import type { SchemeValue } from "./types.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as SchemeBytevector.ts — avoids a membrane→SchemeVector class-def-time
// cycle since [TO_JS]() is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

export class SchemeVector extends AValue {
  static __class__ = "vector";
  readonly kind = "vector" as const;

  /** Mutable raw payload — vector-set!/fill!/copy! write through this. */
  __vector__: SchemeValue[];

  /** R7RS: a #(...) literal is immutable. The Parser freezes literals; the
   *  vector mutators reject a frozen target. Constructed vectors stay mutable. */
  frozen = false;

  constructor(items: SchemeValue[], provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.__vector__ = items;
  }

  /** Mark immutable (a literal). Idempotent. */
  freeze(): void {
    this.frozen = true;
  }

  static isVector(x: unknown): x is SchemeVector {
    return x instanceof SchemeVector;
  }

  get length(): number {
    return this.__vector__.length;
  }

  ref(i: number): SchemeValue {
    return this.__vector__[i];
  }

  set(i: number, v: SchemeValue): void {
    this.__vector__[i] = v;
  }

  fill(v: SchemeValue, start = 0, end = this.__vector__.length): void {
    for (let i = start; i < end; i++) this.__vector__[i] = v;
  }

  copy(start = 0, end = this.__vector__.length): SchemeVector {
    return new SchemeVector(this.__vector__.slice(start, end));
  }

  // Membrane unwrap (TO_JS protocol): a boxed vector crosses to JS as its raw
  // array (elements convert lazily, as with SchemeJSArray).
  [TO_JS](): SchemeValue[] {
    return this.__vector__;
  }

  toJs(): SchemeValue[] {
    return this.__vector__;
  }

  valueOf(): SchemeValue[] {
    return this.__vector__;
  }

  withProvenance(p: ReadonlySet<number>): SchemeVector {
    const v = new SchemeVector(this.__vector__, p);
    // The copy shares the payload by reference, so a frozen literal stays frozen
    // (else re-stamping a literal's provenance would yield a mutable alias of it).
    if (this.frozen) v.freeze();
    return v;
  }

  // Setoid (Fantasy Land) — structural element-wise equality. structuralEqual
  // consults fantasy-land/equals first, so (equal? (vector 1 2) (vector 1 2)) → #t;
  // elements recurse through structuralEqual (handles nested AValues/Pairs/vectors),
  // mirroring the raw-array branch in structural-equal.ts. Non-SchemeVector → false.
  ["fantasy-land/equals"](other: unknown): boolean {
    if (!(other instanceof SchemeVector)) return false;
    const a = this.__vector__;
    const b = other.__vector__;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Semigroup (Fantasy Land) — element concatenation. Associative; equality via
  // the Setoid above.
  ["fantasy-land/concat"](other: SchemeVector): SchemeVector {
    return new SchemeVector([...this.__vector__, ...other.__vector__]);
  }

  // Functor (Fantasy Land) — map over elements into a fresh vector. (The N-ary
  // vector-map builtin is a separate, non-Functor observation — like
  // C-Semigroup's append, it carries arity the bare Functor underfits.)
  ["fantasy-land/map"](f: (x: SchemeValue) => SchemeValue): SchemeVector {
    return new SchemeVector(this.__vector__.map(f));
  }
}

// NOTE: producer-minted (#(...) literal / make-vector / vector / vector-copy /
// list->vector / ...), NOT registered via AValue.registerBoxer — the "object"
// typeof tag is taken by the membrane's list-conser (boxing plan R6). Boxing is
// producer-driven.

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// Same rationale as SchemeString/SchemeBytevector: block inherited-method
// exposure when interop symbol-to-field resolution walks the prototype chain.
markInteropBoundary(SchemeVector);
