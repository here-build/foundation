import { describe, expect, it } from "vitest";
import * as z from "zod";

import {
  bool,
  defineRef,
  fieldIsOptional,
  fieldJsonSchema,
  fieldParse,
  instanceShape,
  nameShape,
  num,
  objectShape,
  oneOf,
  primitiveJsonSchema,
  primitiveParse,
  str,
  uuidShape,
  type Primitive,
  type Ref,
} from "../../kernel/refs";

// ─── Local test fixtures ────────────────────────────────────────────────────

interface Ctx {
  uuidIndex: Map<string, { id: string; label: string }>;
  nameIndex: Map<string, { id: string; label: string }>;
}

class LocalItem {
  constructor(public id: string, public label: string) {}
}

function makeCtx(): Ctx {
  return {
    uuidIndex: new Map([["u-1", { id: "u-1", label: "one" }]]),
    nameIndex: new Map([["alpha", { id: "a-1", label: "alpha-label" }]]),
  };
}

function buildPolymorphicRef(): Ref<{ id: string; label: string } | LocalItem, Ctx> {
  return defineRef<{ id: string; label: string } | LocalItem, Ctx>({
    typeName: "Item",
    desc: "An item reference",
    shapes: [
      uuidShape<Ctx>((id, ctx) => ctx.uuidIndex.get(id) ?? null, { describe: "Item UUID" }),
      nameShape<Ctx>((name, ctx) => ctx.nameIndex.get(name) ?? null, { describe: "Item name" }),
      objectShape(
        z.object({ kind: z.literal("item"), id: z.string() }),
        (parsed, ctx) => ctx.uuidIndex.get(parsed.id) ?? { id: parsed.id, label: "synth" },
        { describe: "Item object" },
      ),
      instanceShape<Ctx>(LocalItem, { describe: "LocalItem instance" }),
    ],
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("primitives", () => {
  it("str/num/bool/oneOf produce Primitive descriptors", () => {
    expect(str("hello")).toEqual({ kind: "string", desc: "hello" });
    expect(num()).toEqual({ kind: "number", desc: undefined });
    expect(bool("a flag")).toEqual({ kind: "boolean", desc: "a flag" });
    expect(oneOf(["a", "b"], "pick one")).toEqual({ kind: "enum", values: ["a", "b"], desc: "pick one" });
  });

  describe("primitiveJsonSchema", () => {
    it("emits type for string/number/boolean", () => {
      expect(primitiveJsonSchema(str())).toEqual({ type: "string" });
      expect(primitiveJsonSchema(num())).toEqual({ type: "number" });
      expect(primitiveJsonSchema(bool())).toEqual({ type: "boolean" });
    });

    it("includes description when present", () => {
      expect(primitiveJsonSchema(str("an id"))).toEqual({ type: "string", description: "an id" });
    });

    it("emits enum with values for oneOf", () => {
      expect(primitiveJsonSchema(oneOf(["x", "y"]))).toEqual({ type: "string", enum: ["x", "y"] });
    });
  });

  describe("primitiveParse", () => {
    it("accepts matching values", () => {
      expect(primitiveParse(str(), "hi")).toEqual({ ok: true, value: "hi" });
      expect(primitiveParse(num(), 3.14)).toEqual({ ok: true, value: 3.14 });
      expect(primitiveParse(bool(), true)).toEqual({ ok: true, value: true });
      expect(primitiveParse(oneOf(["a", "b"]), "a")).toEqual({ ok: true, value: "a" });
    });

    it("rejects mismatched types with informative errors", () => {
      const r = primitiveParse(str(), 42);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].message).toContain("expected string");
    });

    it("rejects enum values not in list", () => {
      const r = primitiveParse(oneOf(["a", "b"]), "c");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].message).toContain("expected one of a|b");
    });

    it("required = undefined fails with `required`", () => {
      const r = primitiveParse(str(), undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].message).toBe("required");
    });

    it("optional = undefined passes with undefined value", () => {
      const opt: Primitive = { kind: "string", optional: true };
      expect(primitiveParse(opt, undefined)).toEqual({ ok: true, value: undefined });
    });
  });
});

describe("fieldJsonSchema / fieldParse / fieldIsOptional", () => {
  it("fieldJsonSchema dispatches on Primitive vs Ref", () => {
    const ref = buildPolymorphicRef();
    expect(fieldJsonSchema(str("x"))).toEqual({ type: "string", description: "x" });
    const refSchema = fieldJsonSchema(ref);
    expect(refSchema).toHaveProperty("oneOf");
  });

  it("fieldParse for primitives", () => {
    expect(fieldParse(num(), 5, {})).toEqual({ ok: true, value: 5 });
  });

  it("fieldParse for refs", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    const r = fieldParse(ref, "u-1", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: "u-1", label: "one" });
  });

  it("fieldIsOptional is true for optional primitives", () => {
    expect(fieldIsOptional({ kind: "string", optional: true })).toBe(true);
    expect(fieldIsOptional(str())).toBe(false);
  });

  it("fieldIsOptional detects optional-wrapped refs", () => {
    const ref = buildPolymorphicRef().optional();
    expect(fieldIsOptional(ref as Ref<unknown, unknown>)).toBe(true);
  });
});

describe("defineRef — multi-branch fallthrough", () => {
  it("resolves via uuid shape on first hit", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    const r = ref.parse("u-1", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("u-1");
  });

  it("falls through from uuid-miss to name-hit", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    const r = ref.parse("alpha", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBe("alpha-label");
  });

  it("passes instance through instanceShape", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    const instance = new LocalItem("inst", "instance-one");
    const r = ref.parse(instance, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(instance);
  });

  it("accumulates per-shape errors when all branches fail", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    // A string that is not a known UUID and not a known name — it will attempt both.
    const r = ref.parse("unknown-token", ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Both uuid and name shapes match the string (match returns true), and
      // both fail to resolve, so we should have at least two errors.
      const shapes = r.errors.map((e) => e.shape);
      expect(shapes).toContain("uuid");
      expect(shapes).toContain("name");
      for (const e of r.errors) {
        expect(typeof e.message).toBe("string");
      }
    }
  });

  it("returns a single 'no shape matched' error when no shape matches at all", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    // A number matches none of uuid/name/object/instance.
    const r = ref.parse(12345, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].shape).toBe("ref");
      expect(r.errors[0].message).toContain("no shape matched");
    }
  });

  it("parse never throws, even for pathological inputs", () => {
    const ref = buildPolymorphicRef();
    const ctx = makeCtx();
    // Circular reference — JSON.stringify throws; shortDescribe must catch it.
    const obj: any = { kind: "item", id: "x" };
    obj.self = obj;
    expect(() => ref.parse(obj, ctx)).not.toThrow();
    // Also test with a Symbol, a BigInt, a function.
    expect(() => ref.parse(Symbol("foo"), ctx)).not.toThrow();
    expect(() => ref.parse(42n, ctx)).not.toThrow();
    expect(() => ref.parse(() => 1, ctx)).not.toThrow();
  });

  it("toJsonSchema wraps shapes in oneOf", () => {
    const ref = buildPolymorphicRef();
    const schema = ref.toJsonSchema() as { oneOf?: unknown[]; type?: string };
    expect(schema.oneOf).toHaveLength(4);
  });

  it("describeForLLM joins shape descriptions with |", () => {
    const ref = buildPolymorphicRef();
    const desc = ref.describeForLLM();
    expect(desc).toContain("Item —");
    expect(desc).toContain("|");
  });
});

describe(".optional()", () => {
  it("accepts undefined and returns undefined value", () => {
    const ref = buildPolymorphicRef().optional();
    const r = ref.parse(undefined, makeCtx());
    expect(r).toEqual({ ok: true, value: undefined });
  });

  it("accepts null and returns undefined value", () => {
    const ref = buildPolymorphicRef().optional();
    const r = ref.parse(null, makeCtx());
    expect(r).toEqual({ ok: true, value: undefined });
  });

  it("delegates to inner parse otherwise", () => {
    const ref = buildPolymorphicRef().optional();
    const r = ref.parse("u-1", makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value!.id).toBe("u-1");
  });

  it("surfaces inner errors for invalid non-undefined input", () => {
    const ref = buildPolymorphicRef().optional();
    const r = ref.parse(12345, makeCtx());
    expect(r.ok).toBe(false);
  });

  it("typeName has ? suffix and describeForLLM mentions (optional)", () => {
    const ref = buildPolymorphicRef().optional();
    expect(ref.typeName).toBe("Item?");
    expect(ref.describeForLLM()).toContain("(optional)");
  });

  it("calling .optional() on an already-optional ref is idempotent (same shape)", () => {
    const ref = buildPolymorphicRef().optional();
    const again = ref.optional();
    // Parse should still behave correctly.
    expect(again.parse(undefined, makeCtx())).toEqual({ ok: true, value: undefined });
  });

  it("calling .list() on an optional ref throws", () => {
    const ref = buildPolymorphicRef().optional();
    expect(() => ref.list()).toThrow(/cannot \.list\(\)/);
  });
});

describe(".list()", () => {
  it("parses an array of valid inputs", () => {
    const ref = buildPolymorphicRef().list();
    const ctx = makeCtx();
    const r = ref.parse(["u-1", "alpha"], ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0]!.id).toBe("u-1");
      expect(r.value[1]!.label).toBe("alpha-label");
    }
  });

  it("rejects non-array input with a descriptive error", () => {
    const ref = buildPolymorphicRef().list();
    const r = ref.parse("not-an-array", makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].shape).toBe("list");
      expect(r.errors[0].message).toContain("expected array");
    }
  });

  it("accumulates per-index error paths", () => {
    const ref = buildPolymorphicRef().list();
    const ctx = makeCtx();
    const r = ref.parse(["u-1", 999, "alpha"], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // All errors for index 1.
      for (const e of r.errors) {
        expect(e.path?.[0]).toBe("1");
      }
    }
  });

  it("empty array is valid", () => {
    const ref = buildPolymorphicRef().list();
    const r = ref.parse([], makeCtx());
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("typeName has [] suffix", () => {
    const ref = buildPolymorphicRef().list();
    expect(ref.typeName).toBe("Item[]");
  });

  it("toJsonSchema emits array with items", () => {
    const ref = buildPolymorphicRef().list();
    const schema = ref.toJsonSchema() as { oneOf?: unknown[]; type?: string; items?: unknown };
    expect(schema.type).toBe("array");
    expect(schema.items).toBeDefined();
  });

  it("nested lists throw", () => {
    const ref = buildPolymorphicRef().list();
    expect(() => ref.list()).toThrow(/nested lists/);
  });

  it("can be wrapped in optional via .optional()", () => {
    const ref = buildPolymorphicRef().list().optional();
    expect(ref.parse(undefined, makeCtx())).toEqual({ ok: true, value: undefined });
    const r = ref.parse(["u-1"], makeCtx());
    expect(r.ok).toBe(true);
  });
});

describe("objectShape", () => {
  it("detects discriminator literal and uses it as tag", () => {
    const ref = defineRef<{ tag: string }, Ctx>({
      typeName: "Tagged",
      desc: "",
      shapes: [
        objectShape(
          z.object({ kind: z.literal("first"), label: z.string() }),
          (p) => ({ tag: `first:${p.label}` }),
        ),
        objectShape(
          z.object({ kind: z.literal("second"), value: z.number() }),
          (p) => ({ tag: `second:${p.value}` }),
        ),
      ],
    });

    const r1 = ref.parse({ kind: "first", label: "x" }, makeCtx());
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.tag).toBe("first:x");

    const r2 = ref.parse({ kind: "second", value: 7 }, makeCtx());
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.tag).toBe("second:7");
  });

  it("filters match by discriminator value — wrong kind does not match first shape", () => {
    const shape = objectShape(
      z.object({ kind: z.literal("first"), label: z.string() }),
      (p) => p,
    );
    // match() should be false because discriminator doesn't equal "first".
    expect(shape.match({ kind: "second", label: "x" })).toBe(false);
    expect(shape.match({ kind: "first", label: "x" })).toBe(true);
  });

  it("rejects non-object (array, null, string) in match", () => {
    const shape = objectShape(
      z.object({ id: z.string() }),
      (p) => p,
    );
    expect(shape.match([])).toBe(false);
    expect(shape.match(null)).toBe(false);
    expect(shape.match("string")).toBe(false);
    expect(shape.match({ id: "abc" })).toBe(true);
  });

  it("carries zod validation errors with path", () => {
    const ref = defineRef<unknown, Ctx>({
      typeName: "T",
      desc: "",
      shapes: [
        objectShape(
          z.object({ kind: z.literal("k"), id: z.string(), n: z.number() }),
          (p) => p,
        ),
      ],
    });
    const r = ref.parse({ kind: "k", id: "x", n: "not-a-number" }, makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const nErr = r.errors.find((e) => e.path?.[0] === "n");
      expect(nErr).toBeDefined();
    }
  });

  it("returns a build-step error with shape = tag when build throws", () => {
    const ref = defineRef<unknown, Ctx>({
      typeName: "T",
      desc: "",
      shapes: [
        objectShape(
          z.object({ kind: z.literal("boom"), id: z.string() }),
          () => {
            throw new Error("build failure");
          },
          { tag: "myTag" },
        ),
      ],
    });
    const r = ref.parse({ kind: "boom", id: "1" }, makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].shape).toBe("myTag");
      expect(r.errors[0].message).toBe("build failure");
    }
  });

  it("jsonSchema strips $schema key", () => {
    const shape = objectShape(
      z.object({ kind: z.literal("k"), id: z.string() }),
      (p) => p,
    );
    const schema = shape.jsonSchema() as {
      $schema?: unknown;
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });
});

describe("uuidShape", () => {
  it("matches non-empty strings without spaces", () => {
    const shape = uuidShape<Ctx>(() => null);
    expect(shape.match("abc")).toBe(true);
    expect(shape.match("")).toBe(false);
    expect(shape.match("has space")).toBe(false);
    expect(shape.match(123)).toBe(false);
  });

  it("returns typed error when resolver returns null", () => {
    const shape = uuidShape<Ctx>(() => null);
    const r = shape.resolve("unknown", makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].shape).toBe("uuid");
  });

  it("resolver receives the string input", () => {
    const calls: string[] = [];
    const shape = uuidShape<Ctx>((id) => {
      calls.push(id);
      return { id, label: "ok" };
    });
    const r = shape.resolve("my-id", makeCtx());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["my-id"]);
  });
});

describe("nameShape", () => {
  it("matches any string (including with spaces)", () => {
    const shape = nameShape<Ctx>(() => null);
    expect(shape.match("a b c")).toBe(true);
    expect(shape.match("")).toBe(true);
    expect(shape.match(null)).toBe(false);
  });

  it("returns typed error with 'no entity with that name' when resolver returns null", () => {
    const shape = nameShape<Ctx>(() => null);
    const r = shape.resolve("whatever", makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain("no entity with that name");
  });
});

describe("instanceShape", () => {
  it("matches instances of the declared class", () => {
    const shape = instanceShape<Ctx>(LocalItem);
    expect(shape.match(new LocalItem("1", "x"))).toBe(true);
    expect(shape.match({ id: "1" })).toBe(false);
    expect(shape.match(null)).toBe(false);
  });

  it("passes the instance through unchanged", () => {
    const shape = instanceShape<Ctx>(LocalItem);
    const x = new LocalItem("1", "x");
    const r = shape.resolve(x, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(x);
  });

  it("describe defaults to class name", () => {
    const shape = instanceShape<Ctx>(LocalItem);
    expect(shape.describe).toBe("LocalItem");
  });
});
