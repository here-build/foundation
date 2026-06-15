/**
 * Bytevector value-domain ops (R7RS Section 6.9) extracted from the `wrappedOps`
 * bridge object. These are the non-mutating bytevector primitives plus the two
 * bridges to/from strings (`utf8->string` / `string->utf8`). They are polymorphic
 * by design — `bytevector?` and the `asBytevector` coercion accept boxed
 * `SchemeBytevector` as well as raw binary (`Uint8Array`/`ArrayBuffer`/`DataView`/
 * Node `Buffer`) that legitimately flows unboxed through the membrane from FFI.
 * The mutating ops (`bytevector-u8-set!` / `bytevector-copy!`) are intentionally
 * omitted under the purity invariant and doored in bootstrap. Bodies are
 * reproduced verbatim from `bridge.ts`; the only change is sourcing shared
 * helpers via `../op-helpers.js`.
 */

import "../errors.js";

import { SchemeBytevector } from "../SchemeBytevector.js";
import { SchemeString } from "../SchemeString.js";
import {
  asBytevector,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../op-helpers.js";
import { EnvCapability } from "./capability.js";

export const BYTEVECTOR_OPS = {
  "bytevector?"(obj: unknown): boolean {
    // Polymorphic by design (NOT a transition shim): scheme producers mint
    // SchemeBytevector, but raw binary legitimately flows from FFI through the
    // membrane unboxed (membrane preserves Uint8Array identity), and a raw
    // Uint8Array/ArrayBuffer/DataView/Buffer genuinely IS bytevector-like. So the
    // predicate accepts boxed OR raw — mirroring asBytevector's coercion. (Vectors
    // differ: a raw JS array is an R7RS list, not a vector, so vector? is
    // instanceof-only — see the boxing plan's (a)/(b) disambiguation.)
    return (
      obj instanceof SchemeBytevector ||
      obj instanceof Uint8Array ||
      obj instanceof ArrayBuffer ||
      obj instanceof DataView ||
      (typeof Buffer !== "undefined" && obj instanceof Buffer)
    );
  },

  "make-bytevector"(k: unknown, byte?: unknown): SchemeBytevector {
    const arr = new Uint8Array(toIndex(k));
    if (byte !== undefined) {
      arr.fill(toIndex(byte));
    }
    return withInputProvenance([byte], new SchemeBytevector(arr));
  },

  bytevector(...bytes: unknown[]): SchemeBytevector {
    const result = new Uint8Array(bytes.length);
    for (const [i, b] of bytes.entries()) {
      result[i] = toIndex(b);
    }
    return withInputProvenance(bytes, new SchemeBytevector(result));
  },

  "bytevector-length"(bv: unknown): number {
    const view = asBytevector(bv, "bytevector-length");
    return view.byteLength;
  },

  "bytevector-u8-ref"(bv: unknown, k: unknown): number {
    const view = asBytevector(bv, "bytevector-u8-ref");
    return view[toIndex(k)];
  },

  // bytevector-u8-set! / bytevector-copy! — OMITTED by the purity invariant
  // (frozen entities); doored in core.ts. Non-mutating bytevector-copy stays.

  "bytevector-copy"(bv: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const view = asBytevector(bv, "bytevector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return withInputProvenance([bv], new SchemeBytevector(view.slice(s, e)));
  },

  "bytevector-append"(...bvs: unknown[]): SchemeBytevector {
    const views = bvs.map((bv) => asBytevector(bv, "bytevector-append"));
    const totalLen = views.reduce((sum, v) => sum + v.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const view of views) {
      result.set(view, offset);
      offset += view.byteLength;
    }
    return withInputProvenance(bvs, new SchemeBytevector(result));
  },

  "utf8->string"(bv: unknown, start?: unknown, end?: unknown): SchemeString {
    const view = asBytevector(bv, "utf8->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return withInputProvenance([bv], new SchemeString(new TextDecoder("utf-8").decode(view.subarray(s, e))));
  },

  "string->utf8"(str: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    return withInputProvenance([str], new SchemeBytevector(new TextEncoder().encode(s_str.slice(s, e))));
  },
};

export default new EnvCapability("scheme/bytevectors", {
  symbols: Object.fromEntries(Object.entries(BYTEVECTOR_OPS).map(([k, v]) => [k, { value: v }])),
});
