/**
 * Membrane - Typed boundary crossing for Scheme ↔ JS interop
 *
 * This module provides two layers of interop:
 *
 * 1. WRAPPER LAYER (fromJS/toJS): General JS↔Scheme value crossing
 *    - Thin wrappers (cljs-bean style) for objects/functions
 *    - WeakMap identity cache (Miller/Van Cutsem pattern)
 *    - Primitives pass through without wrapping
 *
 * 2. CODEC LAYER (Codec/Operator): Typed bidirectional conversion at FFI boundaries
 *    - Bidirectional type converters at the boundary
 *    - Type-safe FFI between Scheme and JavaScript
 *
 * See docs/membrane-design.md for full design rationale.
 */

import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { SchemeBool } from "./SchemeBool.js";
import { SchemeBytevector } from "./SchemeBytevector.js";
import { SchemeVector } from "./SchemeVector.js";
import { Environment as SchemeEnvironment } from "./Environment.js";
import { SchemePromise } from "./evaluator.js";
import { LambdaContext } from "./LambdaContext.js";
import { SchemeString } from "./SchemeString.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import { Macro } from "./Macro.js";
import { type SchemeNumeric, SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { __lambda__ } from "./primitives.js";
import { QuotedPromise } from "./QuotedPromise.js";
// `jsToLips` import is intentionally a runtime cycle with rosetta.ts —
// rosetta.ts statically imports `SchemeJSObject` from this file. ES module
// resolution lets the cycle close at definition time (both functions are
// declared before any call site fires); the lazy `.get` body below only
// reads `jsToLips` when actually invoked.
import { jsToLips } from "./rosetta.js";
import {
  markAsSandboxBoundary,
  NOT_FOUND,
  SandboxViolationError,
  sandboxedAccess,
  sandboxedHas,
  sandboxedKeys,
} from "./sandbox-boundary.js";
import { Syntax } from "./Syntax.js";
import { type SchemeValue, Nil, nil, SchemeCharacter } from "./types.js";

// Re-export sandbox primitives for consumers
export {
  SANDBOX_BOUNDARY as SANDBOX_BOUNDARY,
  SandboxViolationError as SandboxViolationError,
  sandboxedAccess as sandboxedAccess,
  sandboxedHas as sandboxedHas,
  sandboxedSet as sandboxedSet,
  NOT_FOUND as NOT_FOUND,
  markAsSandboxBoundary as markAsSandboxBoundary,
} from "./sandbox-boundary.js";

// ============================================================================
// WRAPPER LAYER: General JS↔Scheme Value Crossing
// ============================================================================

/**
 * Symbol used by wrapper classes to implement unwrapping.
 * Any object with this symbol can be unwrapped via toJS().
 * Following PyO3's trait pattern - each class implements its own unwrap.
 */
export const TO_JS = Symbol.for("scheme.toJS");

/**
 * Check if a value is already a Scheme value (prevents double-wrapping).
 *
 * `instanceof Nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)`
 * mints fresh Nil clones (types.ts:87) — reference-equality misses them, and the
 * boundary would then double-wrap a provenance-bearing list-terminator since
 * downstream checks (SchemeString / SchemeJSObject / Pair) won't catch a Nil
 * subclass either. This was the bug flagged in the Tier-1 cross-package audit
 * and the canonical example for guards.ts:is_nil (fix in 5f7f9e46a).
 */
export function isSchemeValue(value: unknown): boolean {
  switch (true) {
    case value instanceof Nil:
      return true;
    case value === null || value === undefined:
    case typeof value !== "object" && typeof value !== "function":
      return false;

    // Wrapper classes first
    case value instanceof SchemeJSObject:
    case value instanceof SchemeJSFunction:

    // Native Scheme types
    case value instanceof Pair:
    case value instanceof SchemeSymbol:
    case value instanceof SchemeString:
    case value instanceof SchemeBytevector:
    case value instanceof SchemeVector:
    case value instanceof SchemeCharacter:
    case value instanceof SchemeExact:
    case value instanceof SchemeInexact:
    case value instanceof SchemeBool:
    case value instanceof QuotedPromise:
    case value instanceof SchemePromise:
    case value instanceof Macro:
    case value instanceof Syntax:
    case value instanceof LambdaContext:
    case value instanceof SchemeEnvironment:

    // Scheme lambda: new evaluator uses string "__lambda__", old LIPS uses Symbol
    case typeof value === "function" && ("__lambda__" in value || __lambda__ in value):
      return true;

    default:
      return false;
  }
}

/**
 * Check if a value is a bytevector-like binary data type.
 * These pass through without wrapping and work with polymorphic bytevector ops.
 */
export function isBytevectorLike(value: unknown): boolean {
  switch (true) {
    case value instanceof Uint8Array:
    case value instanceof ArrayBuffer:
    case value instanceof DataView:
    case typeof Buffer !== "undefined" && value instanceof Buffer:
      return true;
    default:
      return false;
  }
}

/**
 * Lazy wrapper for JS arrays. O(1) creation, converts elements on access via fromJS.
 * NOT a Pair — consumers must check explicitly with `instanceof SchemeJSArray`.
 */
export class SchemeJSArray {
  static __class__ = "js-array";

  constructor(readonly source: readonly unknown[]) {}

  get length(): number {
    return this.source.length;
  }

  at(index: number): SchemeValue {
    if (index < 0 || index >= this.source.length) return nil;
    return fromJS(this.source[index]);
  }

  [TO_JS](): readonly unknown[] {
    return this.source;
  }

  toString(): string {
    return "#<js-array>";
  }
}

/** WeakMap cache ensuring same JS object always produces same wrapper. */
const jsToWrapper = new WeakMap<object, SchemeValue>();

/**
 * Module-level entry cache keyed by wrapper identity. WeakMap rather than an
 * instance field for two reasons: (1) true encapsulation — the Map never
 * appears on the wrapper's own properties so sandbox symbol-to-field auto-
 * resolution can't reach it; (2) the tslib-helper avoidance the workspace
 * `importHelpers: true` triggers on TS6 `#`-private slots in this build.
 * GC-correct: cache entry disappears with the wrapper.
 */
const entryCaches = new WeakMap<SchemeJSObject, Map<string, AValue>>();

/**
 * Thin wrapper for JS objects. Lazy property access — entries box on
 * demand through `jsToLips` (rosetta.ts), carrying the wrapper's provenance.
 *
 * All property access is sandboxed - see sandbox-boundary.ts for security model.
 *
 * War story (Option C — 2026-05-28): `get(key)` used to call `fromJS(result)`,
 * which passed JS primitives through unboxed and threw away any chance of
 * the entry carrying the container's provenance. With the rosetta deep-stamp
 * (jsToLips passes provenance into every constructed AValue), the wrapper's
 * own surface needs the same discipline: entries must box through the boxer
 * registry stamped with `this.provenance`, so `(@ obj :x)` on a wrapper that
 * came from an `(infer …)` result carries infer's id at the access point,
 * not just at the container level. Identity stability is preserved via the
 * module-level cache: the same `.get("x")` twice returns the same AValue, so
 * `(eq? (@ obj :x) (@ obj :x))` holds.
 */
export class SchemeJSObject extends AValue {
  static __class__ = "js-object";
  readonly kind = "object" as const;

  constructor(
    readonly source: object,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  /** Unwrap to original JS object (TO_JS protocol). */
  [TO_JS](): object {
    return this.source;
  }

  toJs(): Record<string, unknown> {
    return this.source as Record<string, unknown>;
  }

  withProvenance(p: ReadonlySet<number>): SchemeJSObject {
    // New wrapper = new identity = empty cache. Provenance-variant entries
    // would otherwise leak between wrappers; cleaner to let each lineage
    // build its own cache the first time it's queried.
    return new SchemeJSObject(this.source, p);
  }

  /**
   * Read a property as a security-validated, provenanced, cached AValue.
   * Single dispatch point for `dict-ref` / `@` / `:key` consumers — they
   * route here, getting boundary checks + provenance flow + identity
   * stability (`(eq? (@ obj :x) (@ obj :x))` returns #t because the cached
   * AValue is reused).
   *
   * Missing key returns `nil` (matches dict-ref's existing semantics).
   * `sandboxedAccess` filters the boundary; `NOT_FOUND` → either blocked
   * or absent — same `nil` from this surface either way.
   *
   * Cycle protection lives in `jsToLips`'s WeakSet: if `source` participates
   * in a JS-side cycle that surfaces through a property access, the inner
   * traversal terminates before re-entering this wrapper.
   */
  get(key: string | symbol): SchemeValue {
    // Cache keyed by stringified key — symbol keys are an edge case (the
    // sandbox boundary blocks most symbol access anyway) and skipping the
    // cache for them keeps the Map<string, AValue> shape clean.
    const cacheKey = typeof key === "string" ? key : undefined;
    let cache = cacheKey !== undefined ? entryCaches.get(this) : undefined;
    if (cacheKey !== undefined && cache !== undefined) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    let raw: unknown;
    try {
      raw = sandboxedAccess(this.source, key);
    } catch (e) {
      // Boundary violations (Object.prototype methods, dangerous names,
      // boundary-marked prototypes) collapse to `nil` — same shape as
      // "absent." Spec §5.3 says `(@ obj "key")` returns the value at key
      // or nil; the wrapper doesn't expose error detail to the sandbox.
      if (e instanceof SandboxViolationError) return nil;
      throw e;
    }
    if (raw === NOT_FOUND) return nil;

    // Method-call ban: a function-valued property IS a method. The pure-dataflow
    // sandbox has no representation for a foreign invocation, and returning a
    // callable would let Scheme escape into uncontrolled JS — so methods are
    // invisible (same `nil` as absent). Getter/accessor reads are unaffected:
    // `sandboxedAccess` (via `Reflect.get`) has already INVOKED the getter to a
    // value above, so a getter that yields data passes through here; only an
    // actual function result (a method, or the rare getter-returns-a-function)
    // is blocked.
    if (typeof raw === "function") return nil;

    // Box through jsToLips so primitives become AValue subtypes stamped with
    // this wrapper's provenance. SchemeJSObject's instance was constructed
    // through rosetta deep-stamping for the common case (jsToLips reached
    // here on the way down); direct construction with empty provenance keeps
    // the empty-provenance fast-path everywhere.
    const boxed = jsToLips(raw, {}, this.provenance);
    if (cacheKey !== undefined && boxed instanceof AValue) {
      if (cache === undefined) {
        cache = new Map();
        entryCaches.set(this, cache);
      }
      cache.set(cacheKey, boxed);
    }
    return boxed;
  }

  /**
   * Set property value, unwrapping through membrane. Cache invalidation for
   * the touched key keeps subsequent `.get(key)` consistent with the new
   * underlying value.
   */
  set(key: string | symbol, _value: SchemeValue): void {
    // Writes are banned. arrival is a pure-dataflow sandbox — mutating the
    // foreign peer is not dataflow, and the membrane exposes a read-only view
    // by design. (Silent no-op is worse than throwing: the program would
    // believe it wrote.)
    throw new SandboxViolationError(
      "Cannot assign to a foreign object — writes are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  /**
   * Check if property exists (sandboxed - only own + safe inherited).
   * Returns false for blocked properties and boundary-protected inherited props.
   */
  has(key: string | symbol): boolean {
    return sandboxedHas(this.source, key);
  }

  /**
   * Delete a property (sandboxed - only own properties).
   */
  delete(key: string | symbol): boolean {
    // Deletion is a mutation — banned for the same reason as `set` (pure
    // dataflow, read-only membrane).
    throw new SandboxViolationError(
      "Cannot delete from a foreign object — mutations are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  /** Get own enumerable property keys (never includes inherited). */
  keys(): string[] {
    return sandboxedKeys(this.source);
  }

  toString(): string {
    return "#<js-object>";
  }

  valueOf(): object {
    return this.source;
  }
}

/**
 * Wrapper for JS functions. Handles boundary crossing on invocation.
 */
export class SchemeJSFunction extends AValue {
  static __class__ = "js-function";
  readonly kind = "procedure" as const;

  constructor(
    readonly source: Function,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  /** Unwrap to original JS function (TO_JS protocol). */
  [TO_JS](): Function {
    return this.source;
  }

  /** Procedures are not serializable. */
  toJs(): never {
    invariant(false, "SchemeJSFunction: not serializable");
  }

  withProvenance(p: ReadonlySet<number>): SchemeJSFunction {
    return new SchemeJSFunction(this.source, p);
  }

  /** Invoke the wrapped function with Scheme values. */
  apply(thisArg: unknown, args: SchemeValue[]): SchemeValue {
    const jsThis = toJS(thisArg);
    const jsArgs = args.map(toJS);
    const result = this.source.apply(jsThis, jsArgs);
    return fromJS(result);
  }

  /** Call with no this binding. */
  call(...args: SchemeValue[]): SchemeValue {
    return this.apply(undefined, args);
  }

  toString(): string {
    return `#<js-function ${this.source.name || "anonymous"}>`;
  }

  valueOf(): Function {
    return this.source;
  }
}

// ============================================================================
// SANDBOX BOUNDARIES — SchemeJSObject, SchemeJSFunction
// ============================================================================
// War story (2026-05-28 audit): these two wrappers are explicitly the
// JS↔Scheme membrane — every JS value crossing into the sandbox becomes one
// of them. Their own `get/set/has/delete/keys` already route through
// `sandboxedAccess` for the WRAPPED value, but the WRAPPER's prototype
// itself is reachable via symbol-to-field auto-resolution. Without a boundary
// marker, sandbox code could read the wrapper's `apply`, `call`, or
// `toString` to reach the underlying `source` Function or Object. (`apply`
// taking the wrapped source and running it with sandbox-controlled args is
// the canonical escape shape.) Marking the wrapper classes ensures the
// prototype chain stops here — only own sandbox-safe properties on the
// wrapped value flow through.
// ============================================================================
markAsSandboxBoundary(SchemeJSObject);
markAsSandboxBoundary(SchemeJSFunction);

/**
 * Convert a JavaScript value to a Scheme value.
 * Entry point for JS → Scheme boundary crossing.
 */
export function fromJS(value: unknown): SchemeValue {
  // Null/undefined → nil
  if (value === null || value === undefined) return nil;

  // Primitives pass through (including JS Symbol)
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "symbol") return value;

  // Already a Scheme value? Pass through (prevents double-wrapping)
  if (isSchemeValue(value)) return value;

  // Arrays pass through (shared mutation OK, vectors are JS arrays in R7RS)
  if (Array.isArray(value)) return value;

  // Binary types pass through raw (polymorphic ops). This is an intentional
  // membrane contract (membrane.spec.ts: "passes through bytevector-like types",
  // "preserves Uint8Array identity") — FFI identity must be preserved, so the
  // membrane does NOT box them. Scheme producers mint SchemeBytevector; raw
  // binary that bypasses producers (FFI) stays raw and is coerced on use by
  // asBytevector. bytevector? therefore stays polymorphic (boxed OR raw).
  if (isBytevectorLike(value)) return value;

  // Promises pass through (use '> for QuotedPromise)
  if (value instanceof Promise) return value;

  // Check wrapper cache for objects
  const cached = jsToWrapper.get(value as object);
  if (cached) return cached;

  // Create appropriate wrapper
  let wrapper: SchemeValue;
  if (typeof value === "function") {
    wrapper = new SchemeJSFunction(value as Function);
  } else {
    wrapper = new SchemeJSObject(value as object);
  }

  jsToWrapper.set(value as object, wrapper);
  return wrapper;
}

/**
 * Convert a Scheme value to a JavaScript value.
 * Exit point for Scheme → JS boundary crossing.
 */
export function toJS(value: unknown): unknown {
  // Check for wrapper protocol first
  if (value && typeof value === "object" && TO_JS in value) {
    return (value as Record<symbol, () => unknown>)[TO_JS]!();
  }

  // nil → null
  // `instanceof Nil`: see isSchemeValue above — provenance-bearing Nil clones must
  // also project to JS null at the boundary, otherwise they leak into the JS caller
  // as opaque Scheme objects.
  if (value instanceof Nil) return null;

  // Native Scheme types with valueOf
  if (value instanceof SchemeString) return value.valueOf();
  if (value instanceof SchemeCharacter) return value.valueOf();
  if (value instanceof SchemeExact) return value.valueOf();
  if (value instanceof SchemeInexact) return value.valueOf();
  if (value instanceof QuotedPromise) return value.valueOf();

  // SchemeSymbol stays as-is (JS can call .toString() if needed)
  // Pair stays as-is (JS can work with car/cdr)

  // Everything else passes through
  return value;
}

// ============================================================================
// CODEC LAYER: Typed Bidirectional Conversion at FFI Boundaries
// ============================================================================

/**
 * Bidirectional type codec for FFI boundaries.
 *
 * Each codec co-locates three concerns at the definition site:
 * - match: runtime type guard (which values does this codec handle?)
 * - toJS: forward conversion (Scheme → JS)
 * - fromJS: backward conversion (JS → Scheme)
 *
 * @template S - Scheme side type
 * @template J - JavaScript side type
 */
export interface Codec<S, J> {
  /** Type guard: can this codec handle this value? */
  match(value: unknown): value is S;

  /** Forward: Scheme → JS */
  toJS(value: S): J;

  /** Backward: JS → Scheme */
  fromJS(value: J): S;
}

// ============================================================================
// Number Codecs
// ============================================================================

/** Any Scheme number ↔ JS number/bigint */
export const AnyNum: Codec<SchemeNumeric, number | bigint> = {
  match(v): v is SchemeNumeric {
    return v instanceof SchemeExact || v instanceof SchemeInexact;
  },

  toJS(v) {
    if (v instanceof SchemeExact) {
      if (v.isInteger && v.num >= BigInt(Number.MIN_SAFE_INTEGER) && v.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(v.num);
      }
      if (v.isInteger) return v.num;
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },

  fromJS(v) {
    if (typeof v === "bigint") {
      return new SchemeExact(v);
    }
    if (Number.isSafeInteger(v)) {
      return new SchemeExact(BigInt(v));
    }
    return new SchemeInexact(v);
  },
};

/** Exact integers ↔ JS bigint */
export const Int: Codec<SchemeExact, bigint> = {
  match(v): v is SchemeExact {
    return v instanceof SchemeExact && v.isInteger;
  },
  toJS: (v) => v.num,
  fromJS: (v) => new SchemeExact(v),
};

/** Safe integers ↔ JS number (for bitwise ops etc.) */
export const SafeInt: Codec<SchemeExact, number> = {
  match(v): v is SchemeExact {
    return (
      v instanceof SchemeExact &&
      v.isInteger &&
      v.num >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v.num <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  },
  toJS: (v) => Number(v.num),
  fromJS: (v) => new SchemeExact(BigInt(v)),
};

/** Inexact reals ↔ JS number */
export const Real: Codec<SchemeInexact, number> = {
  match(v): v is SchemeInexact {
    return v instanceof SchemeInexact && v.isReal;
  },
  toJS: (v) => v.real,
  fromJS: (v) => new SchemeInexact(v),
};

/** Any number as JS number (lossy for bigints and rationals) */
export const Num: Codec<SchemeNumeric, number> = {
  match(v): v is SchemeNumeric {
    return v instanceof SchemeExact || v instanceof SchemeInexact;
  },
  toJS(v) {
    if (v instanceof SchemeExact) {
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },
  fromJS(v) {
    if (Number.isSafeInteger(v)) {
      return new SchemeExact(BigInt(v));
    }
    return new SchemeInexact(v);
  },
};

// ============================================================================
// Boolean Profunctor
// ============================================================================

/** Scheme boolean ↔ JS boolean */
export const Bool: Codec<boolean, boolean> = {
  match(v): v is boolean {
    return typeof v === "boolean";
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ============================================================================
// String Profunctor
// ============================================================================

/** Scheme string ↔ JS string */
export const Str: Codec<string, string> = {
  match(v): v is string {
    return typeof v === "string";
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ============================================================================
// Void Profunctor (for side-effect functions)
// ============================================================================

/** Void/undefined ↔ undefined */
export const Void: Codec<undefined, undefined> = {
  match(v): v is undefined {
    return v === undefined;
  },
  toJS: () => {},
  fromJS: () => {},
};

// ============================================================================
// Type Utilities
// ============================================================================

type ExtractJS<P extends Codec<any, any>[]> = {
  [K in keyof P]: P[K] extends Codec<any, infer J> ? J : never;
};

type ExtractScheme<P extends Codec<any, any>> = P extends Codec<infer S, any> ? S : never;

type OperatorArgs<In extends Codec<any, any>[], InRest extends Codec<any, any> | undefined> =
  InRest extends Codec<any, infer J> ? [...ExtractJS<In>, ...J[]] : ExtractJS<In>;

// ============================================================================
// Operator Class
// ============================================================================

export interface OperatorConfig<
  In extends Codec<any, any>[],
  InRest extends Codec<any, any> | undefined,
  Out extends Codec<any, any>,
> {
  in: In;
  inRest?: InRest;
  out: Out;
  fn: (...args: OperatorArgs<In, InRest>) => ExtractJS<[Out]>[0];
}

export class Operator<
  In extends Codec<any, any>[] = Codec<any, any>[],
  InRest extends Codec<any, any> | undefined = undefined,
  Out extends Codec<any, any> = Codec<any, any>,
> {
  readonly in: In;
  readonly inRest?: InRest;
  readonly out: Out;
  readonly fn: (...args: OperatorArgs<In, InRest>) => ExtractJS<[Out]>[0];

  constructor(
    readonly name: string,
    config: OperatorConfig<In, InRest, Out>,
  ) {
    this.in = config.in;
    this.inRest = config.inRest;
    this.out = config.out;
    this.fn = config.fn;
  }

  /** Arity info for documentation/introspection */
  get arity(): { min: number; max: number | null } {
    return {
      min: this.in.length,
      max: this.inRest ? null : this.in.length,
    };
  }

  /** Factory with better generic inference */
  static create<
    const In extends Codec<any, any>[],
    const InRest extends Codec<any, any> | undefined,
    const Out extends Codec<any, any>,
  >(name: string, config: OperatorConfig<In, InRest, Out>): Operator<In, InRest, Out> {
    return new Operator(name, config);
  }

  call(args: unknown[]): ExtractScheme<Out> {
    const minArgs = this.in.length;

    TypeError.invariant(args.length >= minArgs, `${this.name}: expected at least ${minArgs} args, got ${args.length}`);
    TypeError.invariant(
      this.inRest || args.length <= minArgs,
      `${this.name}: expected ${minArgs} args, got ${args.length}`,
    );

    const jsArgs = args.map((arg, i) => {
      const prof = i < this.in.length ? this.in[i] : this.inRest!;
      TypeError.invariant(prof.match(arg), `${this.name}: argument ${i} type mismatch`);
      return prof.toJS(arg as any);
    });

    const jsResult = this.fn(...(jsArgs as any));
    return this.out.fromJS(jsResult);
  }
}

// ============================================================================
// Environment Registry
// ============================================================================

export class Environment {
  private readonly operators = new Map<string, Operator<any, any, any>>();

  constructor(readonly name: string = "default") {}

  /** Register an operator */
  register(op: Operator<any, any, any>): this {
    this.operators.set(op.name, op);
    return this;
  }

  /** Register multiple operators */
  registerAll(...ops: Operator<any, any, any>[]): this {
    for (const op of ops) {
      this.register(op);
    }
    return this;
  }

  /** Get an operator by name */
  get(name: string): Operator<any, any, any> | undefined {
    return this.operators.get(name);
  }

  /** Check if operator exists */
  has(name: string): boolean {
    return this.operators.has(name);
  }

  /** Call an operator by name */
  call(name: string, args: unknown[]): unknown {
    const op = this.get(name);
    invariant(op, `${this.name}: unknown operator '${name}'`);
    return op.call(args);
  }

  /** List all operator names */
  keys(): string[] {
    return [...this.operators.keys()];
  }

  /** Create a child environment that inherits from this one */
  extend(name: string): Environment {
    const child = new Environment(name);
    // Copy all operators from parent
    for (const [key, op] of this.operators) {
      child.operators.set(key, op);
    }
    return child;
  }

  /** Create a restricted environment with only specified operators */
  restrict(name: string, allowList: string[]): Environment {
    const restricted = new Environment(name);
    for (const key of allowList) {
      const op = this.operators.get(key);
      if (op) {
        restricted.operators.set(key, op);
      }
    }
    return restricted;
  }
}

// One boxer for both arrays and plain objects — registry keys by `typeof`, and
// `typeof [] === "object"`. Arrays cons-up into a proper scheme list; everything
// else wraps. Provenance stamps the top-level result only; spine elements stay
// empty until a provenance-aware op touches them.
AValue.registerBoxer("object", (v, p) => {
  if (Array.isArray(v)) {
    let list: AValue = nil;
    for (let i = v.length - 1; i >= 0; i--) {
      list = new Pair(AValue.fromJs(v[i]), list) as unknown as AValue;
    }
    return p === EMPTY_PROVENANCE ? list : list.withProvenance(p);
  }
  return new SchemeJSObject(v as object, p);
});

AValue.registerBoxer("function", (v, p) => new SchemeJSFunction(v as Function, p));
