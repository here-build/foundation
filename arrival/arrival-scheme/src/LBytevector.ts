// -------------------------------------------------------------------------
// :: Bytevector wrapper — boxes a raw Uint8Array into the AValue kernel so it
// :: can carry provenance and host Fantasy Land algebra instances.
// -------------------------------------------------------------------------
// Modeled on SchemeString (LString.ts). Bytevectors are MUTABLE
// (bytevector-u8-set!/copy!), so the payload stays writable — unlike a frozen
// string literal. The asBytevector coercion (ArrayBuffer/DataView/Buffer) that
// previously lived in bridge.ts moves into the constructor, so a SchemeBytevector
// always normalizes to a single Uint8Array payload.
//
// Boxing track: docs/plan-2026-06-10-boxing-track.md (S1 — pilot, unused).
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { TO_JS } from "./membrane.js";
import { markAsSandboxBoundary } from "./sandbox-boundary.js";

/**
 * Anything that can seed a bytevector. Coerced to a Uint8Array payload in the
 * constructor (the old `asBytevector` coercion surface, now co-located here).
 */
export type BytevectorSource =
  | Uint8Array
  | ArrayBuffer
  | DataView
  | SchemeBytevector
  | readonly number[];

function toUint8(source: BytevectorSource): Uint8Array {
  switch (true) {
    case source instanceof SchemeBytevector:
      return source.__bytevector__;
    case source instanceof Uint8Array:
      return source;
    case source instanceof ArrayBuffer:
      return new Uint8Array(source);
    case source instanceof DataView:
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    case typeof Buffer !== "undefined" && source instanceof Buffer:
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    case Array.isArray(source):
      return Uint8Array.from(source);
    default:
      throw new TypeError(`SchemeBytevector: cannot coerce ${typeof source} to bytevector`);
  }
}

export class SchemeBytevector extends AValue {
  static __class__ = "bytevector";
  readonly kind = "bytevector" as const;

  /** Mutable raw payload — bytevector-u8-set!/copy! write through this. */
  __bytevector__: Uint8Array;

  constructor(source: BytevectorSource, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.__bytevector__ = toUint8(source);
  }

  static isBytevector(x: unknown): x is SchemeBytevector {
    return x instanceof SchemeBytevector;
  }

  get length(): number {
    return this.__bytevector__.byteLength;
  }

  ref(i: number): number {
    return this.__bytevector__[i];
  }

  set(i: number, byte: number): void {
    this.__bytevector__[i] = byte;
  }

  copy(start = 0, end = this.__bytevector__.byteLength): SchemeBytevector {
    return new SchemeBytevector(this.__bytevector__.slice(start, end));
  }

  // Membrane unwrap (membrane.ts toJS, TO_JS protocol): a boxed bytevector
  // crosses to JS as its raw Uint8Array, never as an opaque Scheme object.
  [TO_JS](): Uint8Array {
    return this.__bytevector__;
  }

  toJs(): Uint8Array {
    return this.__bytevector__;
  }

  valueOf(): Uint8Array {
    return this.__bytevector__;
  }

  withProvenance(p: ReadonlySet<number>): SchemeBytevector {
    return new SchemeBytevector(this.__bytevector__, p);
  }

  // Setoid (Fantasy Land) — byte-wise value equality. structuralEqual consults
  // fantasy-land/equals first, so (equal? (bytevector 1 2) (bytevector 1 2)) → #t.
  // Non-SchemeBytevector → false.
  ["fantasy-land/equals"](other: unknown): boolean {
    if (!(other instanceof SchemeBytevector)) return false;
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Ord (Fantasy Land, extends Setoid) — lexicographic over unsigned bytes.
  // A proper prefix is ≤ its extension; antisymmetry holds against the Setoid
  // above (equal iff same bytes AND same length). Non-SchemeBytevector → false.
  ["fantasy-land/lte"](other: unknown): boolean {
    if (!(other instanceof SchemeBytevector)) return false;
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length <= b.length;
  }

  // Semigroup (Fantasy Land) — byte concatenation. Associative; equality via the
  // Setoid above.
  ["fantasy-land/concat"](other: SchemeBytevector): SchemeBytevector {
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return new SchemeBytevector(result);
  }
}

// NOTE: producer-minted (bytevector/make-bytevector/string->utf8/Parser #u8(...)),
// NOT registered via AValue.registerBoxer — the "object" typeof tag is taken by
// the membrane's list-conser (R6). Boxing is producer-driven.

// ============================================================================
// SANDBOX BOUNDARY
// ============================================================================
// Same rationale as SchemeString (LString.ts): block inherited-method exposure
// when sandbox symbol-to-field resolution walks the prototype chain. Own
// properties (the algebra methods) remain the intended API.
markAsSandboxBoundary(SchemeBytevector);
