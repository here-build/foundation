/**
 * Vector value-domain primitives (R7RS Section 6.8) — extracted verbatim from
 * the interpreter's `wrappedOps` hot path. A vector is exactly a boxed
 * `SchemeVector` so the container carries provenance and hosts algebra
 * instances. The mutating members of the family (`vector-set!`,
 * `vector-fill!`, `vector-copy!`) are OMITTED by the purity invariant (frozen
 * entities, doored in core.ts); only the non-mutating constructors,
 * accessors, and the higher-order `vector-map` / `vector-for-each` (which await
 * async membrane callbacks before settling) live here.
 */

import { SchemeVector } from "../values/SchemeVector.js";
import { SchemeString } from "../values/SchemeString.js";
import { SchemeCharacter, type SchemeValue } from "../values/types.js";
import type { SchemeExact } from "../values/numbers.js";
import { Pair } from "../values/Pair.js";
import { is_promise } from "../eval/guards.js";
import { promise_all } from "../utils/promises.js";
import invariant from "tiny-invariant";
import {
  assertAllocatable,
  asVector,
  charValue,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../values/op-helpers.js";

import { EnvCapability } from "./capability.js";

export const VECTOR_OPS = {
  "make-vector"(k: unknown, fill?: unknown): SchemeVector {
    const len = Number(typeof k === "number" ? k : (k as SchemeExact).valueOf());
    // O(1) cap check BEFORE Array.from materializes `len` slots — see
    // assertAllocatable. `Array.from({length})` on an oversized count is the
    // >10s hang the audit caught.
    assertAllocatable(len, "make-vector");
    const arr = Array.from({ length: len }) as SchemeValue[];
    if (fill !== undefined) {
      arr.fill(fill);
    }
    // Boxed into SchemeVector so the container carries provenance and hosts
    // algebra instances. Elements (if AValues) still carry their own provenance.
    return withInputProvenance([fill], new SchemeVector(arr));
  },

  vector(...objs: unknown[]): SchemeVector {
    return withInputProvenance(objs, new SchemeVector([...objs] as SchemeValue[]));
  },

  "vector-append"(...vectors: unknown[]): SchemeVector {
    const arrays = vectors.map((v) => asVector(v, "vector-append"));
    return withInputProvenance(vectors, new SchemeVector(([] as SchemeValue[]).concat(...arrays)));
  },

  "vector?"(obj: unknown): boolean {
    // instanceof-only (S10): a vector is exactly a boxed SchemeVector. Unlike a
    // raw Uint8Array (which genuinely IS bytevector-like, so bytevector? stays
    // polymorphic), a raw JS array is an R7RS *list* / FFI array at the membrane,
    // NOT a vector — so it correctly answers #f here. asVector still coerces a
    // raw array defensively for any value that bypasses producers.
    return obj instanceof SchemeVector;
  },

  "vector-length"(vec: unknown): number {
    return asVector(vec, "vector-length").length;
  },

  "vector-ref"(vec: unknown, k: unknown): unknown {
    const arr = asVector(vec, "vector-ref");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    return arr[idx as number];
  },

  // vector-set! / vector-fill! / vector-copy! — OMITTED by the purity invariant
  // (frozen entities); doored in core.ts. Non-mutating vector-copy stays.

  "vector->list"(vec: unknown, start?: unknown, end?: unknown): unknown {
    const arr = asVector(vec, "vector->list");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return Pair.fromArray(arr.slice(s, e));
  },

  "list->vector"(list: unknown): SchemeVector {
    const result: SchemeValue[] = [];
    let current = list;
    while (current instanceof Pair) {
      result.push(current.car);
      current = current.cdr;
    }
    return withInputProvenance([list], new SchemeVector(result));
  },


  "vector->string"(vec: unknown, start?: unknown, end?: unknown): SchemeString {
    const arr = asVector(vec, "vector->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    let result = "";
    for (let i = s; i < e; i++) {
      const ch = arr[i];
      result += ch instanceof SchemeCharacter ? charValue(ch) : String(ch);
    }
    return withInputProvenance([vec], new SchemeString(result));
  },

  "string->vector"(str: unknown, start?: unknown, end?: unknown): SchemeVector {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    const result: SchemeValue[] = [];
    for (let i = s; i < e; i++) {
      result.push(new SchemeCharacter(s_str[i]));
    }
    return withInputProvenance([str], new SchemeVector(result));
  },

  "vector-copy"(vec: unknown, start?: unknown, end?: unknown): SchemeVector {
    const arr = asVector(vec, "vector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return withInputProvenance([vec], new SchemeVector(arr.slice(s, e)));
  },

  // vector-copy! — OMITTED by the purity invariant (mutates its destination);
  // doored in core.ts. The non-mutating `vector-copy` (above) stays.

  "vector-map"(proc: Function, ...vectors: unknown[]): SchemeVector | Promise<SchemeVector> {
    invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
    const arrays = vectors.map((v) => asVector(v, "vector-map"));
    const minLen = Math.min(...arrays.map((a) => a.length));
    const result: SchemeValue[] = [];
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      result.push(proc(...elements));
    }
    // proc may be an async membrane callback → its results are JS Promises. Mirror
    // the list `map` (stdlib.ts): if any slot is a promise, await them all so the
    // returned vector holds SETTLED values (not "[object Promise]") and provenance
    // is preserved. (errors-as-doors note: silent leak defeats boxing goal-b.)
    if (result.some(is_promise)) {
      return (promise_all(result) as Promise<SchemeValue[]>).then(
        (resolved) => withInputProvenance(vectors, new SchemeVector(resolved)),
      );
    }
    return withInputProvenance(vectors, new SchemeVector(result));
  },

  "vector-for-each"(proc: Function, ...vectors: unknown[]): void | Promise<void> {
    invariant(vectors.length > 0, "vector-for-each: expected at least one vector argument");
    const arrays = vectors.map((v) => asVector(v, "vector-for-each"));
    const minLen = Math.min(...arrays.map((a) => a.length));
    const pending: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      const ret = proc(...elements);
      if (is_promise(ret)) pending.push(ret);
    }
    // Await any async side effects before returning, so for-each does not complete
    // while promises are still outstanding.
    if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
  },
};

export default new EnvCapability("scheme/vectors", {
  symbols: Object.fromEntries(Object.entries(VECTOR_OPS).map(([k, v]) => [k, { value: v }])),
});
