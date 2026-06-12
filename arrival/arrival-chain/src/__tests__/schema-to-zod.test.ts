import { describe, expect, it } from "vitest";

import { renderSchema, tagToJsonSchema } from "../backends/_shared.js";
import { schemaSlotToZod, schemaToZod } from "../schema-to-zod.js";

/**
 * The schema→zod bridge must NOT drift from the JSON Schema the inference
 * backends emit. It routes the SAME `(s/object …)` tagged list through the SAME
 * `tagToJsonSchema` lowering, then lets zod reconstruct the validator. These
 * tests pin the three facts the bridge guarantees — `.strict()` (reject unknown
 * keys), all-fields-required, and the `s/enum` type-consistency fix — and prove
 * the validator is bound to the very JSON Schema the model sees (no parallel
 * recursion).
 */

const PERSONA = [
  "object",
  ["name", "string", "the persona's full name"],
  ["age", "integer"],
  ["verified", "boolean"],
  ["bucket", ["enum", "A", "B", "C"]],
  ["pains", ["array", "string"]],
] as const;

describe("schemaToZod — strict + all-required (mirrors additionalProperties:false)", () => {
  it("accepts a fully-populated object", () => {
    const zod = schemaToZod(PERSONA);
    const r = zod.safeParse({ name: "Maya", age: 30, verified: true, bucket: "A", pains: ["x"] });
    expect(r.success).toBe(true);
  });

  it("rejects unknown keys (.strict, from additionalProperties:false)", () => {
    const zod = schemaToZod(PERSONA);
    const r = zod.safeParse({ name: "Maya", age: 30, verified: true, bucket: "A", pains: ["x"], EXTRA: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects a partial object (every declared field is required)", () => {
    const zod = schemaToZod(PERSONA);
    expect(schemaToZod(PERSONA).safeParse({ name: "Maya" }).success).toBe(false);
    // each field omitted in turn fails — none is implicitly optional
    expect(zod.safeParse({ age: 30, verified: true, bucket: "A", pains: [] }).success).toBe(false);
    expect(zod.safeParse({ name: "Maya", verified: true, bucket: "A", pains: [] }).success).toBe(false);
  });

  it("enforces leaf types: wrong-typed field fails", () => {
    const zod = schemaToZod(PERSONA);
    expect(zod.safeParse({ name: 5, age: 30, verified: true, bucket: "A", pains: [] }).success).toBe(false);
    expect(zod.safeParse({ name: "Maya", age: 30, verified: true, bucket: "NOPE", pains: [] }).success).toBe(false);
    expect(zod.safeParse({ name: "Maya", age: 30, verified: true, bucket: "A", pains: "not-an-array" }).success).toBe(
      false,
    );
  });

  it("integer field rejects a non-integer number", () => {
    const zod = schemaToZod(["object", ["age", "integer"]]);
    expect(zod.safeParse({ age: 5 }).success).toBe(true);
    expect(zod.safeParse({ age: 5.5 }).success).toBe(false);
  });
});

describe("schemaToZod — single lowering, no second recursion (anti-drift)", () => {
  it("the bridge consumes exactly the JSON Schema the backends emit", () => {
    // renderSchema(slot) is what the OpenAI/Anthropic backends send; the zod
    // validator is built from tagToJsonSchema(tag) — the SAME function renderSchema
    // calls. If the two ever diverged this equality (and the bridge) would break.
    const slot = JSON.stringify(PERSONA);
    expect(tagToJsonSchema(PERSONA)).toEqual(renderSchema(slot));
  });

  it("validates nested array-of-objects (recursion handled once, in the lowering)", () => {
    const tag = ["array", ["object", ["name", "string"], ["bucket", ["enum", "A", "B"]]]];
    const zod = schemaToZod(tag);
    expect(
      zod.safeParse([
        { name: "x", bucket: "A" },
        { name: "y", bucket: "B" },
      ]).success,
    ).toBe(true);
    // nested unknown key still rejected (strict propagates through the lowering)
    expect(zod.safeParse([{ name: "x", bucket: "A", EXTRA: 1 }]).success).toBe(false);
    // nested enum violation rejected
    expect(zod.safeParse([{ name: "x", bucket: "Z" }]).success).toBe(false);
  });

  it("bare primitive tag lowers to the matching zod primitive", () => {
    const zod = schemaToZod("string");
    expect(zod.safeParse("hi").success).toBe(true);
    expect(zod.safeParse(5).success).toBe(false);
  });
});

describe("s/enum type-consistency (the fix)", () => {
  it("all-string enum keeps type:string (unchanged common case)", () => {
    expect(tagToJsonSchema(["enum", "A", "B", "C"])).toEqual({ type: "string", enum: ["A", "B", "C"] });
    const zod = schemaToZod(["enum", "A", "B"]);
    expect(zod.safeParse("A").success).toBe(true);
    expect(zod.safeParse("Z").success).toBe(false);
  });

  it("all-integer enum lowers to type:integer (was a contradictory type:string)", () => {
    expect(tagToJsonSchema(["enum", 1, 2, 3])).toEqual({ type: "integer", enum: [1, 2, 3] });
    const zod = schemaToZod(["object", ["score", ["enum", 1, 2, 3]]]);
    expect(zod.safeParse({ score: 2 }).success).toBe(true);
    expect(zod.safeParse({ score: 9 }).success).toBe(false);
    // a string is NOT a valid member of an integer enum
    expect(zod.safeParse({ score: "2" }).success).toBe(false);
  });

  it("non-integer numeric enum lowers to type:number", () => {
    expect(tagToJsonSchema(["enum", 1.5, 2.5])).toEqual({ type: "number", enum: [1.5, 2.5] });
    const zod = schemaToZod(["object", ["x", ["enum", 1.5, 2.5]]]);
    expect(zod.safeParse({ x: 2.5 }).success).toBe(true);
    expect(zod.safeParse({ x: 3 }).success).toBe(false);
  });

  it("mixed-kind enum drops `type` entirely (no single JSON Schema type fits)", () => {
    // A `type:"string"` here would contradict the numeric member; emit only `enum`.
    expect(tagToJsonSchema(["enum", "A", 1])).toEqual({ enum: ["A", 1] });
    const zod = schemaToZod(["object", ["v", ["enum", "A", 1]]]);
    expect(zod.safeParse({ v: "A" }).success).toBe(true);
    expect(zod.safeParse({ v: 1 }).success).toBe(true);
    expect(zod.safeParse({ v: "B" }).success).toBe(false);
  });
});

describe("schemaSlotToZod — slot-string form, symmetric with renderSchema", () => {
  it("lowers a canonical JSON-stringified tagged list", () => {
    const zod = schemaSlotToZod(JSON.stringify(["object", ["name", "string"]]));
    expect(zod).not.toBeNull();
    expect(zod!.safeParse({ name: "x" }).success).toBe(true);
    expect(zod!.safeParse({ name: "x", y: 1 }).success).toBe(false);
  });

  it("returns null for null and for a legacy non-JSON string marker", () => {
    // same null contract renderSchema uses, so callers branch once.
    expect(schemaSlotToZod(null)).toBeNull();
    expect(renderSchema("ProfileLegacy")).toBeNull();
    expect(schemaSlotToZod("ProfileLegacy")).toBeNull();
  });
});

describe("schemaToZod — :meta validates by the same path as input/output", () => {
  // `:meta` lowers the identical s/ → JSON-Schema → zod path. A low-cardinality
  // enum-tier meta tag validates exactly like any other object schema.
  const META = ["object", ["tier", ["enum", "free", "pro"]]] as const;

  it("accepts a valid meta record, rejects out-of-enum and unknown keys", () => {
    const zod = schemaToZod(META);
    expect(zod.safeParse({ tier: "free" }).success).toBe(true);
    expect(zod.safeParse({ tier: "enterprise" }).success).toBe(false);
    expect(zod.safeParse({ tier: "pro", extra: 1 }).success).toBe(false);
  });
});
