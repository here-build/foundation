/**
 * Provenance deep-stamping at the rosetta boundary (Option C).
 *
 * Pre-change: `jsToLips` constructed a Pair-chain whose top-level container
 * received provenance via a separate `withProvenance` walk; the spine cons
 * cells + leaf primitives stayed empty. Spec §5.3 says car/cdr are
 * projections (element-only) — so `(car (infer …))` returned a SchemeString
 * carrying nothing, breaking the v0-gap provenance chain.
 *
 * Post-change: `jsToLips(raw, opts, provenance)` deep-stamps every
 * constructed AValue in a single pass. Plain JS objects wrap as
 * `SchemeJSObject`; their entries box lazily via `.get(key)` carrying the
 * wrapper's provenance, with a per-wrapper cache for identity stability.
 * `(@ obj :x)` and `(:x obj)` route through the same `.get`, so the cached
 * AValue makes `(eq? (@ obj :x) (@ obj :x))` return #t.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_PROVENANCE } from "../AValue";
import { schemeFalse, schemeTrue } from "../SchemeBool";
import { SchemeString } from "../SchemeString";
import { SchemeJSObject } from "../membrane";
import { SchemeExact, SchemeInexact } from "../numbers";
import { Pair } from "../Pair";
import { jsToLips } from "../rosetta";
import { sandboxedEnv } from "../sandbox-env";
import { exec } from "../stdlib";
import { Nil, nil } from "../types";

const PROV = new Set<number>([42]);

describe("jsToLips deep-stamps every constructed AValue", () => {
  it("array → Pair-chain — each cons has provenance, each leaf SchemeString has provenance", () => {
    const result = jsToLips(["a", "b"], {}, PROV);
    expect(result).toBeInstanceOf(Pair);
    const pair = result as Pair;
    expect([...pair.provenance]).toEqual([42]);
    // Leaf strings boxed via boxer registry — SchemeString with provenance.
    expect(pair.car).toBeInstanceOf(SchemeString);
    expect([...(pair.car as SchemeString).provenance]).toEqual([42]);
    const second = pair.cdr as Pair;
    expect(second).toBeInstanceOf(Pair);
    expect([...second.provenance]).toEqual([42]);
    expect(second.car).toBeInstanceOf(SchemeString);
    expect([...(second.car as SchemeString).provenance]).toEqual([42]);
    // Tail Nil also carries provenance.
    expect(second.cdr).toBeInstanceOf(Nil);
    expect([...(second.cdr as Nil).provenance]).toEqual([42]);
  });

  it("nested array deep-stamps recursively", () => {
    const result = jsToLips([[1], [2, 3]], {}, PROV) as Pair;
    expect([...result.provenance]).toEqual([42]);
    const inner = result.car as Pair;
    expect(inner).toBeInstanceOf(Pair);
    expect([...inner.provenance]).toEqual([42]);
    expect(inner.car).toBeInstanceOf(SchemeExact);
    expect([...(inner.car as SchemeExact).provenance]).toEqual([42]);
  });

  it("plain object → SchemeJSObject with provenance; entries lazy-boxed", () => {
    const result = jsToLips({ name: "claude" }, {}, PROV);
    expect(result).toBeInstanceOf(SchemeJSObject);
    expect([...(result as SchemeJSObject).provenance]).toEqual([42]);
    // Entry surfaces through `.get` — boxed lazily with the wrapper's provenance.
    const name = (result as SchemeJSObject).get("name");
    expect(name).toBeInstanceOf(SchemeString);
    expect([...(name as SchemeString).provenance]).toEqual([42]);
  });

  it("primitive string → SchemeString boxed via AValue.fromJs with provenance", () => {
    const result = jsToLips("hello", {}, PROV);
    expect(result).toBeInstanceOf(SchemeString);
    expect([...(result as SchemeString).provenance]).toEqual([42]);
  });

  it("primitive number → SchemeExact (safe int) or SchemeInexact with provenance", () => {
    const intResult = jsToLips(42, {}, PROV);
    expect(intResult).toBeInstanceOf(SchemeExact);
    expect([...(intResult as SchemeExact).provenance]).toEqual([42]);

    const floatResult = jsToLips(3.14, {}, PROV);
    expect(floatResult).toBeInstanceOf(SchemeInexact);
    expect([...(floatResult as SchemeInexact).provenance]).toEqual([42]);
  });

  it("with EMPTY_PROVENANCE preserves backward-compatible no-stamp behavior", () => {
    // Empty-provenance fast path reuses singletons / skips withProvenance —
    // boxer registry decides whether to allocate. SchemeString always
    // allocates (no singleton); SchemeBool reuses schemeTrue/schemeFalse.
    expect(jsToLips(true, {}, EMPTY_PROVENANCE)).toBe(schemeTrue);
    expect(jsToLips(false, {}, EMPTY_PROVENANCE)).toBe(schemeFalse);
    const str = jsToLips("x", {}, EMPTY_PROVENANCE) as SchemeString;
    expect(str).toBeInstanceOf(SchemeString);
    expect(str.provenance.size).toBe(0);
  });

  it("with already-AValue same provenance returns input unchanged (identity fast path)", () => {
    const orig = new SchemeString("x", PROV);
    expect(jsToLips(orig, {}, PROV)).toBe(orig);
    // Empty-provenance argument also short-circuits — input is preserved.
    expect(jsToLips(orig, {}, EMPTY_PROVENANCE)).toBe(orig);
  });
});

describe("jsToLips WeakSet cycle protection", () => {
  it("self-cyclic JS array does not stack-overflow", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    // No assertion on the inner reference shape — only that the call returns
    // without blowing the stack. The Pair-chain for the outer reference is
    // built; the cyclic slot bottoms out at the WeakSet guard.
    expect(() => jsToLips(arr, {}, PROV)).not.toThrow();
  });

  it("mutual-cycle plain objects terminate", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.peer = b;
    b.peer = a;
    expect(() => jsToLips(a, {}, PROV)).not.toThrow();
  });
});

describe("SchemeJSObject.get — cached boundary-validated boxing", () => {
  it("(eq? (@ obj :x) (@ obj :x)) returns #t — cached AValue reused", () => {
    const obj = new SchemeJSObject({ x: 42 }, PROV);
    const a = obj.get("x");
    const b = obj.get("x");
    // Identity: the cache returns the same AValue instance on repeat reads.
    expect(a).toBe(b);
  });

  it("entry carries the wrapper's provenance", () => {
    const obj = new SchemeJSObject({ greeting: "hi" }, PROV);
    const greeting = obj.get("greeting") as SchemeString;
    expect(greeting).toBeInstanceOf(SchemeString);
    expect([...greeting.provenance]).toEqual([42]);
  });

  it("missing key returns nil", () => {
    const obj = new SchemeJSObject({ x: 1 }, PROV);
    expect(obj.get("nope")).toBe(nil);
  });

  it("rejects writes — set is banned (pure-dataflow sandbox), source unchanged", () => {
    const source: { x: unknown } = { x: 1 };
    const obj = new SchemeJSObject(source, PROV);
    const first = obj.get("x") as SchemeExact;
    expect(first.valueOf()).toBe(1);
    // Writing the foreign peer is not dataflow — the membrane is read-only.
    expect(() => obj.set("x", 99)).toThrow(/writes are banned/);
    expect(source.x).toBe(1); // nothing was written
    // The cached read remains the same stable AValue.
    expect(obj.get("x")).toBe(first);
  });

  it("withProvenance returns a wrapper with empty cache", () => {
    const obj = new SchemeJSObject({ x: 1 }, PROV);
    obj.get("x"); // populate cache
    const clone = obj.withProvenance(new Set<number>([99]));
    // Clone holds the same source but boxes entries fresh with the new
    // provenance — identity does NOT cross-talk between provenance variants.
    const xViaClone = clone.get("x") as SchemeExact;
    expect([...xViaClone.provenance]).toEqual([99]);
  });

  it("blocked key (sandboxedAccess NOT_FOUND) returns nil", () => {
    // Object.prototype methods are filtered by the sandbox boundary —
    // `.get("toString")` resolves to NOT_FOUND for plain-object sources.
    const obj = new SchemeJSObject({ x: 1 }, PROV);
    expect(obj.get("toString")).toBe(nil);
  });
});

describe("dict-ref / @ / :key all route through SchemeJSObject.get", () => {
  it("(:x obj) returns the same AValue identity as (@ obj :x)", async () => {
    // Both `@` and `:key` dispatch into `obj.get(...)` for SchemeJSObject
    // targets — the wrapper's cache makes the two surfaces return the same
    // AValue instance, so `(eq? (@ obj :x) (:x obj))` holds.
    const env = sandboxedEnv.inherit("test");
    const wrapper = new SchemeJSObject({ x: "hello" });
    env.set("obj", wrapper);
    const [viaAt] = await exec("(@ obj :x)", { env });
    const [viaColon] = await exec("(:x obj)", { env });
    expect(viaAt).toBe(viaColon);
  });
});
