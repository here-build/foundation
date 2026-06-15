import * as z from "zod";

/**
 * Ref — polymorphic input resolver.
 *
 * A single Ref accepts multiple input shapes (UUID, name, object literal, class instance)
 * and resolves them to a single output type T. Used as both context-field declarations
 * and action/fn prop declarations.
 *
 * Shape is data, not fluent API: `shapes: RefShape[]` is an array — introspectable,
 * serializable, testable. .optional() / .list() return new wrapped Refs, no mutation.
 *
 * parse() returns Result<T>, never throws. Accumulated per-shape errors feed good
 * LLM-facing error messages.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] };

export interface ParseError {
  /** Which shape branch tried to match, or "ref" for top-level. */
  shape: string;
  message: string;
  /** For nested failures: path into the input. */
  path?: string[];
  /** What was received, stringified short. */
  received?: string;
}

export interface RefShape<Ctx> {
  /** Shape identifier, used in errors and JSON schema. */
  readonly tag: string;
  /** Short human description for LLM-facing rendering. */
  readonly describe: string;
  /** Fast predicate; if false, shape is skipped without invoking resolve. */
  match(input: unknown): boolean;
  /** Produce T or accumulated errors. Must not throw. */
  resolve(input: unknown, ctx: Ctx): Result<unknown>;
  /** Contribution to the oneOf JSON Schema union. */
  jsonSchema(): object;
}

export interface Ref<T, Ctx = unknown> {
  readonly typeName: string;
  readonly desc: string;
  readonly shapes: readonly RefShape<Ctx>[];
  parse(input: unknown, ctx: Ctx): Result<T>;
  toJsonSchema(): object;
  describeForLLM(): string;
  optional(): Ref<T | undefined, Ctx>;
  list(): Ref<T[], Ctx>;
}

export interface RefSpec<Ctx> {
  typeName: string;
  desc: string;
  shapes: readonly RefShape<Ctx>[];
}

export function defineRef<T, Ctx = unknown>(spec: RefSpec<Ctx>): Ref<T, Ctx> {
  const { typeName, desc, shapes } = spec;
  const ref: Ref<T, Ctx> = {
    typeName,
    desc,
    shapes,
    parse(input, ctx) {
      const errors: ParseError[] = [];
      for (const shape of shapes) {
        if (!shape.match(input)) continue;
        const result = shape.resolve(input, ctx);
        if (result.ok) return result as Result<T>;
        errors.push(...result.errors);
      }
      if (errors.length === 0) {
        errors.push({
          shape: "ref",
          message: `${typeName}: no shape matched`,
          received: shortDescribe(input),
        });
      }
      return { ok: false, errors };
    },
    toJsonSchema() {
      return { oneOf: shapes.map((s) => s.jsonSchema()) };
    },
    describeForLLM() {
      return `${typeName} — accepts: ${shapes.map((s) => s.describe).join(" | ")}`;
    },
    optional() {
      return wrapOptional(ref);
    },
    list() {
      return wrapList(ref);
    },
  };
  return ref;
}

function wrapOptional<T, Ctx>(inner: Ref<T, Ctx>): Ref<T | undefined, Ctx> {
  return {
    typeName: `${inner.typeName}?`,
    desc: `${inner.desc} (optional)`,
    shapes: inner.shapes,
    parse(input, ctx) {
      if (input === undefined || input === null) return { ok: true, value: undefined };
      return inner.parse(input, ctx);
    },
    toJsonSchema: () => inner.toJsonSchema(),
    describeForLLM: () => `${inner.describeForLLM()} (optional)`,
    optional() {
      return this as Ref<T | undefined, Ctx>;
    },
    list() {
      throw new Error("cannot .list() an optional ref; call .list().optional() instead");
    },
  };
}

function wrapList<T, Ctx>(inner: Ref<T, Ctx>): Ref<T[], Ctx> {
  return {
    typeName: `${inner.typeName}[]`,
    desc: `list of ${inner.desc}`,
    shapes: inner.shapes,
    parse(input, ctx) {
      if (!Array.isArray(input)) {
        return {
          ok: false,
          errors: [{ shape: "list", message: `expected array, got ${typeOf(input)}` }],
        };
      }
      const values: T[] = [];
      const errors: ParseError[] = [];
      for (const [i, element] of input.entries()) {
        const result = inner.parse(element, ctx);
        if (result.ok) values.push(result.value);
        else {
          for (const e of result.errors) {
            errors.push({ ...e, path: [String(i), ...(e.path ?? [])] });
          }
        }
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: values };
    },
    toJsonSchema: () => ({ type: "array", items: inner.toJsonSchema() }),
    describeForLLM: () => `list of ${inner.describeForLLM()}`,
    optional(): Ref<T[] | undefined, Ctx> {
      return wrapOptional(this as unknown as Ref<T[], Ctx>) as unknown as Ref<T[] | undefined, Ctx>;
    },
    list() {
      throw new Error("nested lists not supported");
    },
  };
}

// ─── Shape factories ────────────────────────────────────────────────────────

/** UUID-string shape: matches non-empty strings, runs resolve, null = miss. */
export function uuidShape<Ctx>(
  resolve: (id: string, ctx: Ctx) => unknown | null,
  opts: { describe?: string } = {},
): RefShape<Ctx> {
  return {
    tag: "uuid",
    describe: opts.describe ?? "UUID",
    match: (input) => typeof input === "string" && input.length > 0 && !input.includes(" "),
    resolve: (input, ctx) => {
      const resolved = resolve(input as string, ctx);
      if (resolved == null) {
        return { ok: false, errors: [{ shape: "uuid", message: "unknown UUID", received: shortDescribe(input) }] };
      }
      return { ok: true, value: resolved };
    },
    jsonSchema: () => ({ type: "string", description: opts.describe ?? "UUID" }),
  };
}

/** Name-string shape: tried after uuidShape miss. Returns null to fall through. */
export function nameShape<Ctx>(
  resolve: (name: string, ctx: Ctx) => unknown | null,
  opts: { describe?: string } = {},
): RefShape<Ctx> {
  return {
    tag: "name",
    describe: opts.describe ?? "name",
    match: (input) => typeof input === "string",
    resolve: (input, ctx) => {
      const resolved = resolve(input as string, ctx);
      if (resolved == null) {
        return {
          ok: false,
          errors: [{ shape: "name", message: "no entity with that name", received: shortDescribe(input) }],
        };
      }
      return { ok: true, value: resolved };
    },
    jsonSchema: () => ({ type: "string", description: opts.describe ?? "name" }),
  };
}

/**
 * Object-literal shape with a discriminator field.
 * Uses Zod internally for structural validation; users don't need to know.
 */
export function objectShape<S extends z.ZodObject<any>, T, Ctx>(
  schema: S,
  build: (parsed: z.infer<S>, ctx: Ctx) => T,
  opts: { tag?: string; describe?: string } = {},
): RefShape<Ctx> {
  const discriminatorField = detectDiscriminator(schema);
  const tag = opts.tag ?? discriminatorField ?? "object";
  const describe = opts.describe ?? renderShapeDescription(schema, discriminatorField);
  return {
    tag,
    describe,
    match: (input) => {
      if (typeof input !== "object" || input == null || Array.isArray(input)) return false;
      if (discriminatorField) {
        const discVal = (input as Record<string, unknown>)[discriminatorField];
        const expected = getDiscriminatorValue(schema, discriminatorField);
        if (expected != null && discVal !== expected) return false;
      }
      return true;
    },
    resolve: (input, ctx) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          errors: parsed.error.issues.map((issue) => ({
            shape: tag,
            message: issue.message,
            path: issue.path.map(String),
            received: "received" in issue ? String((issue as { received: unknown }).received) : undefined,
          })),
        };
      }
      try {
        return { ok: true, value: build(parsed.data, ctx) };
      } catch (error) {
        return {
          ok: false,
          errors: [{ shape: tag, message: (error as Error).message }],
        };
      }
    },
    jsonSchema: () => {
      const { $schema: _, ...rest } = z.toJSONSchema(schema);
      return rest;
    },
  };
}

/** "Already an instance" — pass-through for values produced by other refs/discovery. */
export function instanceShape<Ctx>(
  cls: abstract new (...args: any[]) => unknown,
  opts: { describe?: string } = {},
): RefShape<Ctx> {
  return {
    tag: "instance",
    describe: opts.describe ?? cls.name,
    match: (input) => input instanceof cls,
    resolve: (input) => ({ ok: true, value: input }),
    jsonSchema: () => ({ description: `${cls.name} instance` }),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function typeOf(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}

function shortDescribe(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return typeOf(input);
  }
}

function detectDiscriminator(schema: z.ZodObject<any>): string | undefined {
  const shape = schema.shape ?? {};
  for (const [key, val] of Object.entries(shape)) {
    if (val instanceof z.ZodLiteral) return key;
  }
  return undefined;
}

function getDiscriminatorValue(schema: z.ZodObject<any>, field: string): unknown {
  const shape = schema.shape ?? {};
  const fieldSchema = shape[field];
  if (fieldSchema instanceof z.ZodLiteral) {
    return fieldSchema.value;
  }
  return undefined;
}

function renderShapeDescription(schema: z.ZodObject<any>, discriminator?: string): string {
  const shape = schema.shape ?? {};
  const discVal = discriminator ? getDiscriminatorValue(schema, discriminator) : undefined;
  const otherFields = Object.keys(shape).filter((k) => k !== discriminator);
  if (discriminator && discVal) {
    const extra = otherFields.length > 0 ? `, ${otherFields.join(", ")}` : "";
    return `{${discriminator}: "${discVal}"${extra}}`;
  }
  return `{${Object.keys(shape).join(", ")}}`;
}

// ─── Primitives (for simple schema-level field declarations) ────────────────
//
// Each primitive carries a phantom `_t` so downstream `InferFieldType` can
// recover the TS type from the spec without runtime cost. The phantom is never
// set at runtime — it exists purely as a type-level witness.

export interface StringSpec {
  kind: "string";
  desc?: string;
  optional?: boolean;
  readonly _t?: string;
}
export interface NumberSpec {
  kind: "number";
  desc?: string;
  optional?: boolean;
  readonly _t?: number;
}
export interface BooleanSpec {
  kind: "boolean";
  desc?: string;
  optional?: boolean;
  readonly _t?: boolean;
}
export interface EnumSpec<V extends readonly string[] = readonly string[]> {
  kind: "enum";
  values: V;
  desc?: string;
  optional?: boolean;
  readonly _t?: V[number];
}

/** Object map of string → string. Common for CSS-style bags, HTTP headers, etc. */
export interface StringRecordSpec {
  kind: "string-record";
  desc?: string;
  optional?: boolean;
  readonly _t?: Record<string, string>;
}

/** JSON scalar: string | number | boolean. Common for prop-value inputs. */
export interface ScalarSpec {
  kind: "scalar";
  desc?: string;
  optional?: boolean;
  readonly _t?: string | number | boolean;
}

/** Untyped array — passed through as-is. Use when element validation lives in the handler. */
export interface RawListSpec {
  kind: "raw-list";
  desc?: string;
  optional?: boolean;
  readonly _t?: unknown[];
}

export type Primitive = StringSpec | NumberSpec | BooleanSpec | EnumSpec | StringRecordSpec | ScalarSpec | RawListSpec;

export const str = (desc?: string): StringSpec => ({ kind: "string", desc });
export const num = (desc?: string): NumberSpec => ({ kind: "number", desc });
export const bool = (desc?: string): BooleanSpec => ({ kind: "boolean", desc });
export const oneOf = <const V extends readonly string[]>(values: V, desc?: string): EnumSpec<V> => ({
  kind: "enum",
  values,
  desc,
});
export const stringRecord = (desc?: string): StringRecordSpec => ({
  kind: "string-record",
  desc,
});
export const scalar = (desc?: string): ScalarSpec => ({ kind: "scalar", desc });
export const rawList = (desc?: string): RawListSpec => ({ kind: "raw-list", desc });

/**
 * Mark a primitive as optional. Reads left-to-right at call sites:
 *   `kernel.optional(kernel.str("desc"))` — the spec is optional.
 *
 * Type-level: preserves the primitive subtype and narrows `optional` to the
 * literal `true`, so `InferFieldType` widens the field type to `T | undefined`.
 */
export function optional<P extends Primitive>(spec: P): P & { optional: true } {
  return { ...spec, optional: true };
}

export function primitiveJsonSchema(p: Primitive): object {
  let base: object;
  switch (p.kind) {
    case "enum": {
      base = { type: "string", enum: [...p.values] };

      break;
    }
    case "string-record": {
      base = { type: "object", additionalProperties: { type: "string" } };

      break;
    }
    case "scalar": {
      base = { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] };

      break;
    }
    case "raw-list": {
      base = { type: "array" };

      break;
    }
    default: {
      base = { type: p.kind };
    }
  }
  return p.desc ? { ...base, description: p.desc } : base;
}

export function primitiveParse(p: Primitive, input: unknown): Result<unknown> {
  if (input === undefined) {
    if (p.optional) return { ok: true, value: undefined };
    return { ok: false, errors: [{ shape: p.kind, message: "required" }] };
  }
  switch (p.kind) {
    case "string":
      return typeof input === "string"
        ? { ok: true, value: input }
        : { ok: false, errors: [{ shape: "string", message: `expected string, got ${typeOf(input)}` }] };
    case "number":
      return typeof input === "number"
        ? { ok: true, value: input }
        : { ok: false, errors: [{ shape: "number", message: `expected number, got ${typeOf(input)}` }] };
    case "boolean":
      return typeof input === "boolean"
        ? { ok: true, value: input }
        : { ok: false, errors: [{ shape: "boolean", message: `expected boolean, got ${typeOf(input)}` }] };
    case "enum":
      return typeof input === "string" && p.values.includes(input)
        ? { ok: true, value: input }
        : {
            ok: false,
            errors: [{ shape: "enum", message: `expected one of ${p.values.join("|")}, got ${shortDescribe(input)}` }],
          };
    case "string-record": {
      if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return { ok: false, errors: [{ shape: "string-record", message: `expected object, got ${typeOf(input)}` }] };
      }
      const entries = Object.entries(input as Record<string, unknown>);
      const bad = entries.find(([, v]) => typeof v !== "string");
      if (bad) {
        return {
          ok: false,
          errors: [
            {
              shape: "string-record",
              message: `values must be strings; ${bad[0]} is ${typeOf(bad[1])}`,
              path: [bad[0]],
            },
          ],
        };
      }
      return { ok: true, value: input as Record<string, string> };
    }
    case "scalar":
      if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
        return { ok: true, value: input };
      }
      return {
        ok: false,
        errors: [{ shape: "scalar", message: `expected string | number | boolean, got ${typeOf(input)}` }],
      };
    case "raw-list":
      if (Array.isArray(input)) return { ok: true, value: input };
      return {
        ok: false,
        errors: [{ shape: "raw-list", message: `expected array, got ${typeOf(input)}` }],
      };
  }
}

export type FieldSpec<Ctx = unknown> = Primitive | Ref<unknown, Ctx>;

export function fieldJsonSchema(f: FieldSpec): object {
  if ("kind" in f) return primitiveJsonSchema(f);
  return f.toJsonSchema();
}

export function fieldParse<Ctx>(f: FieldSpec<Ctx>, input: unknown, ctx: Ctx): Result<unknown> {
  if ("kind" in f) return primitiveParse(f, input);
  return f.parse(input, ctx);
}

export function fieldIsOptional(f: FieldSpec): boolean {
  if ("kind" in f) return f.optional === true;
  // Ref optionality is represented by the optional() wrapper; we detect it by
  // checking if parse accepts undefined.
  const result = f.parse(undefined, {} as never);
  return result.ok;
}

// ─── Type-level inference from FieldSpec to TS output type ──────────────────
//
// Refs encode their T in the generic parameter; primitives encode it in the
// phantom `_t`. InferFieldType<F> recovers T for either. Optional primitives
// widen to `T | undefined` only when `optional: true` is a literal — setting
// it from a widened boolean loses precision (same limitation as TS literal
// inference elsewhere; handle via `as const` if needed).

export type InferFieldType<F> =
  F extends Ref<infer T, any>
    ? T
    : F extends { _t?: infer T }
      ? F extends { optional: true }
        ? T | undefined
        : T
      : unknown;

export type InferProps<P extends Record<string, FieldSpec<any>>> = {
  [K in keyof P]: InferFieldType<P[K]>;
};
