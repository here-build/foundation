/**
 * Two-API membrane symmetry tests.
 *
 * The codebase has two parallel JS↔Scheme conversion surfaces:
 *
 *   - rosetta.ts:  lipsToJs / jsToLips — used by rosetta wrappers + sandbox env.
 *   - membrane.ts: AValue.fromJs + boxer dispatch / membrane.toJS — used by
 *                  FFI codecs (Operator/Codec) and the AValue subtype boxers.
 *
 * They should compose: jsToLips → lipsToJs round-trips, fromJs → toJs round-trips,
 * and the two APIs agree on the SHAPE of converted values.
 *
 * They don't, today, in several places. These tests document the divergence:
 *  - rosetta `jsToLips` does NOT box `string`/`number`/`boolean`/`bigint`
 *    primitives (returns them raw). lipsToJs unwraps the same primitives by
 *    type-checking specific AValue subtypes — so a primitive in/primitive out
 *    looks "round-trip correct" by accident even though the cross-membrane
 *    SHAPE is different from what `AValue.fromJs` would produce.
 *  - membrane `isSchemeValue` lists AValue subtypes by explicit
 *    `instanceof` checks. Any AValue subtype that isn't listed will mis-route.
 *    Nil is technically listed by `=== nil`, but clones miss (see
 *    clone-identity.test.ts for the meta-bug).
 *
 * Tests intended to pass are GREEN; documented divergences are it.fails.
 */

import { describe, expect, it } from "vitest";
import { AValue } from "../AValue";
import { is_nil } from "../guards";
import { fromJS, isSchemeValue, SchemeJSFunction, SchemeJSObject, toJS } from "../membrane";
import { jsToLips, lipsToJs } from "../rosetta";
import { SchemeBool, schemeFalse, schemeTrue } from "../SchemeBool";
import { SchemeString } from "../SchemeString";
import { SchemeSymbol } from "../SchemeSymbol";
import { SchemeExact, SchemeInexact } from "../numbers";
import { Pair } from "../Pair";
import { Nil, nil, SchemeCharacter } from "../types";
import { QuotedPromise } from "../QuotedPromise";

// =========================================================================
// AValue.fromJs boxer dispatch — coverage of every registered tag
// =========================================================================

describe("AValue.fromJs — boxer dispatch produces the expected subtype per typeof tag", () => {
  // Boxer registry resolution: typeof string → "string" boxer (SchemeString.ts:139)
  it("string → SchemeString", () => {
    const result = AValue.fromJs("hello");
    expect(result).toBeInstanceOf(SchemeString);
    expect((result as SchemeString).valueOf()).toBe("hello");
  });

  // typeof 42 === "number" — registered in operators/index.ts (via the
  // numbers module). Safe integer path → SchemeExact with bigint num.
  it("number (safe integer) → SchemeExact", () => {
    const result = AValue.fromJs(42);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(42n);
  });

  // Non-integer float → SchemeInexact (real part).
  it("number (float) → SchemeInexact", () => {
    const result = AValue.fromJs(3.14);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(3.14);
  });

  // typeof 1n === "bigint" → SchemeExact regardless of size.
  it("bigint → SchemeExact", () => {
    const result = AValue.fromJs(123n);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(123n);
  });

  // SchemeBool.ts:32-34 — empty-provenance fast path REUSES the schemeTrue/schemeFalse
  // singletons. Non-empty provenance mints a fresh SchemeBool.
  it("boolean (empty provenance) → singleton SchemeBool", () => {
    expect(AValue.fromJs(true)).toBe(schemeTrue);
    expect(AValue.fromJs(false)).toBe(schemeFalse);
  });

  it("boolean (non-empty provenance) → fresh SchemeBool with provenance", () => {
    const prov = new Set<number>([99]);
    const result = AValue.fromJs(true, prov);
    expect(result).toBeInstanceOf(SchemeBool);
    expect(result).not.toBe(schemeTrue);
    expect((result as SchemeBool).value).toBe(true);
    expect([...result.provenance]).toEqual([99]);
  });

  // types.ts:212-213 — null and undefined both → Nil (boxed).
  // Empty provenance: returns a fresh Nil (NOT the singleton — see types.ts:87
  // — withProvenance always allocates). This is exactly the clone-leak shape.
  it("null → Nil instance", () => {
    const result = AValue.fromJs(null);
    expect(result).toBeInstanceOf(Nil);
    expect(is_nil(result)).toBe(true);
  });

  it("undefined → Nil instance", () => {
    const result = AValue.fromJs(undefined);
    expect(result).toBeInstanceOf(Nil);
    expect(is_nil(result)).toBe(true);
  });

  // membrane.ts:647-656 — "object" boxer. Arrays cons up into a Pair chain;
  // plain objects wrap as SchemeJSObject.
  it("array → Pair chain", () => {
    const result = AValue.fromJs([1, 2, 3]);
    expect(result).toBeInstanceOf(Pair);
    const p = result as Pair;
    expect((p.car as SchemeExact).num).toBe(1n);
  });

  it("plain object → SchemeJSObject wrapper", () => {
    const obj = { foo: 1 };
    const result = AValue.fromJs(obj);
    expect(result).toBeInstanceOf(SchemeJSObject);
    expect((result as SchemeJSObject).source).toBe(obj);
  });

  it("function → SchemeJSFunction wrapper", () => {
    const fn = () => 42;
    const result = AValue.fromJs(fn);
    expect(result).toBeInstanceOf(SchemeJSFunction);
    expect((result as SchemeJSFunction).source).toBe(fn);
  });

  // AValue input is returned as-is on the empty-provenance fast path.
  it("AValue input (empty provenance) is returned by identity", () => {
    const orig = new SchemeString("x");
    expect(AValue.fromJs(orig)).toBe(orig);
  });

  it("AValue input (with non-empty provenance) is cloned via withProvenance", () => {
    const orig = new SchemeString("x");
    const prov = new Set<number>([7]);
    const result = AValue.fromJs(orig, prov);
    expect(result).not.toBe(orig);
    expect(result).toBeInstanceOf(SchemeString);
    expect([...result.provenance]).toEqual([7]);
  });
});

// =========================================================================
// jsToLips → lipsToJs round-trip
// =========================================================================

describe("jsToLips → lipsToJs round-trip", () => {
  // Option C (2026-05-28): jsToLips deep-stamps every constructed AValue —
  // primitives now route through `AValue.fromJs` (boxer registry) so a JS
  // string in produces a `SchemeString` carrying the supplied provenance.
  // Closes the shape divergence the membrane symmetry audit flagged.
  it("string is wrapped through jsToLips into SchemeString", () => {
    const lipsified = jsToLips("hello");
    expect(lipsified).toBeInstanceOf(SchemeString);
  });

  // String pass-through round trips by accident — raw in, raw out.
  // This IS expected behavior today and is the green guard for the
  // primitive-passthrough contract.
  it("string round-trips by passthrough (raw → raw)", () => {
    expect(lipsToJs(jsToLips("hello"))).toBe("hello");
  });

  it("number round-trips by passthrough", () => {
    expect(lipsToJs(jsToLips(42))).toBe(42);
  });

  it("boolean round-trips by passthrough", () => {
    expect(lipsToJs(jsToLips(true))).toBe(true);
  });

  // Arrays are properly cons'd to Pair, then lipsToJs walks the spine
  // back into an array. The element-level cons'ing also wraps the leaves
  // through jsToLips (so primitives stay primitives), and lipsToJs
  // recurses through the Pair spine.
  it("array round-trips through a Pair chain", () => {
    const result = lipsToJs(jsToLips([1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  it("nested array round-trips", () => {
    const result = lipsToJs(jsToLips([[1, 2], [3, 4]]));
    expect(result).toEqual([[1, 2], [3, 4]]);
  });

  // Plain objects are recursed: jsToLips builds { k: jsToLips(v) }, lipsToJs
  // mirrors via Object.entries → lipsToJs(value). Round-trip is correct.
  it("plain object round-trips", () => {
    const result = lipsToJs(jsToLips({ a: 1, b: "two" }));
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("nested object round-trips", () => {
    const result = lipsToJs(jsToLips({ outer: { inner: 42 } }));
    expect(result).toEqual({ outer: { inner: 42 } });
  });

  // null → nil (rosetta.ts:160). The reverse direction is lipsToJs(nil) which
  // is the `value === nil` early return (rosetta.ts:70) — returns the nil
  // SINGLETON, not `null`. Documented divergence: rosetta does not invert
  // the null⇄nil contract symmetrically.
  it.fails("null round-trips to null (currently jsToLips(null) → nil, lipsToJs(nil) → nil singleton)", () => {
    expect(lipsToJs(jsToLips(null))).toBeNull();
  });
});

// =========================================================================
// isSchemeValue completeness — every native AValue subtype
// =========================================================================

describe("isSchemeValue completeness — every native AValue subtype is recognised", () => {
  // Membrane's isSchemeValue (membrane.ts:70-99) is a long `instanceof`
  // chain. Each test asserts the chain has a branch for the subtype.

  it("SchemeString → true", () => {
    expect(isSchemeValue(new SchemeString("x"))).toBe(true);
  });

  it("SchemeSymbol → true", () => {
    expect(isSchemeValue(new SchemeSymbol("foo"))).toBe(true);
  });

  it("SchemeCharacter → true", () => {
    expect(isSchemeValue(new SchemeCharacter("a"))).toBe(true);
  });

  it("SchemeExact → true", () => {
    expect(isSchemeValue(new SchemeExact(42n))).toBe(true);
  });

  it("SchemeInexact → true", () => {
    expect(isSchemeValue(new SchemeInexact(3.14))).toBe(true);
  });

  it("SchemeBool (singletons) → true", () => {
    expect(isSchemeValue(schemeTrue)).toBe(true);
    expect(isSchemeValue(schemeFalse)).toBe(true);
  });

  it("Pair → true", () => {
    expect(isSchemeValue(new Pair(1, nil))).toBe(true);
  });

  it("nil singleton → true (via the `=== nil` short-circuit)", () => {
    expect(isSchemeValue(nil)).toBe(true);
  });

  it("SchemeJSObject → true", () => {
    expect(isSchemeValue(new SchemeJSObject({}))).toBe(true);
  });

  it("SchemeJSFunction → true", () => {
    expect(isSchemeValue(new SchemeJSFunction(() => 1))).toBe(true);
  });

  it("QuotedPromise → true", () => {
    expect(isSchemeValue(new QuotedPromise(Promise.resolve(1)))).toBe(true);
  });

  // Nil clones — should be recognized but aren't. See clone-identity.test.ts
  // for the full enumeration of `=== nil` sites. This is a duplicate of the
  // membrane.ts:71 site, deliberately kept here for the completeness map.
  it("Nil clone → true (see membrane.ts:71 + clone-identity.test.ts; fixed via `instanceof Nil`)", () => {
    const clone = nil.withProvenance(new Set<number>([1]));
    expect(isSchemeValue(clone)).toBe(true);
  });

  // Plain JS values should NOT be Scheme values. Negative cases keep the
  // boundary's other direction honest.
  it("plain string → false", () => {
    expect(isSchemeValue("hello")).toBe(false);
  });

  it("plain number → false", () => {
    expect(isSchemeValue(42)).toBe(false);
  });

  it("plain object → false", () => {
    expect(isSchemeValue({})).toBe(false);
  });

  it("plain array → false (arrays cons up via boxer, but a raw array is not Scheme)", () => {
    expect(isSchemeValue([1, 2, 3])).toBe(false);
  });

  it("null → false", () => {
    expect(isSchemeValue(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isSchemeValue(undefined)).toBe(false);
  });
});

// =========================================================================
// fromJS / toJS — membrane.ts cross-boundary symmetry
// =========================================================================

describe("membrane fromJS / toJS — round-trip + wrapper-cache identity", () => {
  it("primitive round-trips: string", () => {
    expect(toJS(fromJS("hello"))).toBe("hello");
  });

  it("primitive round-trips: number", () => {
    expect(toJS(fromJS(42))).toBe(42);
  });

  it("primitive round-trips: bigint", () => {
    expect(toJS(fromJS(10n))).toBe(10n);
  });

  it("null round-trips through nil", () => {
    // fromJS(null) → nil (the singleton). toJS(nil) → null via `value === nil`.
    expect(toJS(fromJS(null))).toBe(null);
  });

  it("object round-trips through SchemeJSObject (same source reference)", () => {
    const obj = { a: 1 };
    const wrapped = fromJS(obj);
    expect(wrapped).toBeInstanceOf(SchemeJSObject);
    expect(toJS(wrapped)).toBe(obj);
  });

  it("function round-trips through SchemeJSFunction (same source reference)", () => {
    const fn = () => 42;
    const wrapped = fromJS(fn);
    expect(wrapped).toBeInstanceOf(SchemeJSFunction);
    expect(toJS(wrapped)).toBe(fn);
  });

  it("wrapper cache: same JS object → same wrapper instance", () => {
    const obj = { x: 1 };
    const a = fromJS(obj);
    const b = fromJS(obj);
    expect(a).toBe(b);
  });
});
