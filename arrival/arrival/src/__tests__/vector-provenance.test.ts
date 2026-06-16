// Caveat-sweep finding (2026-06-11): every container-producing vector/bytevector
// builtin DROPS input provenance — omitting the withInputProvenance call its
// string/list sibling makes. Boxing's goal (b) is to give the container a place
// to carry lineage; its own producers were throwing it away. utf8->string /
// vector->string even returned RAW JS strings (provenance-blind escapees).
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { BYTEVECTOR_OPS } from "../env/bytevectors.js";
import { VECTOR_OPS } from "../env/vectors.js";
import { SchemeBytevector } from "../values/SchemeBytevector.js";
import { SchemeString } from "../values/SchemeString.js";
import { SchemeVector } from "../values/SchemeVector.js";

await initBridge();
// The vector/bytevector primitives now live in their value-domain cluster packs
// (carved out of the old `wrappedOps` monolith); these are the exact fns assembled
// onto global_env.
const ops = { ...VECTOR_OPS, ...BYTEVECTOR_OPS } as Record<string, (...a: any[]) => any>;
const PROV = new Set<number>([42]);
const provVec = (xs: any[]) => new SchemeVector(xs, PROV);
const provBv = (xs: number[]) => new SchemeBytevector(Uint8Array.from(xs), PROV);
const prov = (r: unknown) => [...((r as { provenance: ReadonlySet<number> }).provenance ?? [])];

describe("vector/bytevector builtins propagate input provenance (goal b)", () => {
  it("vector-copy carries the source's provenance", () => {
    expect(prov(ops["vector-copy"](provVec([1, 2, 3])))).toEqual([42]);
  });
  it("vector-map carries provenance", () => {
    expect(prov(ops["vector-map"]((x: number) => x, provVec([1, 2])))).toEqual([42]);
  });
  it("vector-append carries provenance", () => {
    expect(prov(ops["vector-append"](provVec([1]), provVec([2])))).toEqual([42]);
  });
  it("list->vector via vector(...) elements carries union provenance", () => {
    // `vector` unions its element provenance onto the container.
    const el = new SchemeString("x", PROV);
    expect(prov(ops["vector"](el))).toEqual([42]);
  });
  it("bytevector-copy carries provenance", () => {
    expect(prov(ops["bytevector-copy"](provBv([1, 2, 3])))).toEqual([42]);
  });
  it("bytevector-append carries provenance", () => {
    expect(prov(ops["bytevector-append"](provBv([1]), provBv([2])))).toEqual([42]);
  });

  it("utf8->string returns a SchemeString (not a raw JS string) and carries provenance", () => {
    const r = ops["utf8->string"](provBv([104, 105]));
    expect(r).toBeInstanceOf(SchemeString);
    expect(r.valueOf()).toBe("hi");
    expect(prov(r)).toEqual([42]);
  });
  it("vector->string returns a SchemeString and carries provenance", () => {
    const r = ops["vector->string"](provVec([new (SchemeString as any)("a")]));
    expect(r).toBeInstanceOf(SchemeString);
  });
});
