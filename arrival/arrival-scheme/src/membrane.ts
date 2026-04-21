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

import type { SchemeNumeric } from "./numbers.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import type { SchemeValue } from "./types.js";
import { nil, SchemeCharacter } from "./types.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import { Pair } from "./Pair.js";
import { QuotedPromise } from "./QuotedPromise.js";
import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { LambdaContext } from "./LambdaContext.js";
import { Environment as SchemeEnvironment } from "./Environment.js";
import { SchemePromise } from "./evaluator.js";
import { __lambda__ } from "./primitives.js";
import {
  sandboxedAccess,
  sandboxedHas,
  sandboxedKeys,
  sandboxedSet,
  sandboxedDelete,
  NOT_FOUND,
  SANDBOX_BOUNDARY,
  SandboxViolationError,
} from "./sandbox-boundary.js";

// Re-export sandbox primitives for consumers
export {
  SANDBOX_BOUNDARY as SANDBOX_BOUNDARY,
  SandboxViolationError as SandboxViolationError,
  sandboxedAccess as sandboxedAccess,
  sandboxedHas as sandboxedHas,
  sandboxedKeys as sandboxedKeys,
  sandboxedSet as sandboxedSet,
  sandboxedDelete as sandboxedDelete,
  NOT_FOUND as NOT_FOUND,
  markAsSandboxBoundary as markAsSandboxBoundary,
  isSandboxBoundary as isSandboxBoundary,
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
 */
export function isSchemeValue(value: unknown): boolean {
  if (value === nil) return true;
  if (value === null || value === undefined) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;

  // Check for wrapper classes first
  if (value instanceof SchemeJSObject) return true;
  if (value instanceof SchemeJSFunction) return true;

  // Check for native Scheme types
  if (value instanceof Pair) return true;
  if (value instanceof SchemeSymbol) return true;
  if (value instanceof SchemeString) return true;
  if (value instanceof SchemeCharacter) return true;
  if (value instanceof SchemeExact) return true;
  if (value instanceof SchemeInexact) return true;
  if (value instanceof QuotedPromise) return true;
  if (value instanceof SchemePromise) return true;
  if (value instanceof Macro) return true;
  if (value instanceof Syntax) return true;
  if (value instanceof LambdaContext) return true;
  if (value instanceof SchemeEnvironment) return true;

  // Check for Scheme lambda (function with __lambda__ marker)
  // Note: new evaluator uses string property "__lambda__", old LIPS uses Symbol
  if (typeof value === "function" && ("__lambda__" in value || __lambda__ in value)) return true;

  return false;
}

/**
 * Check if a value is a bytevector-like binary data type.
 * These pass through without wrapping and work with polymorphic bytevector ops.
 */
export function isBytevectorLike(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (value instanceof ArrayBuffer) return true;
  if (value instanceof DataView) return true;
  if (typeof Buffer !== "undefined" && value instanceof Buffer) return true;
  return false;
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
 * Thin wrapper for JS objects. Lazy property access.
 * Following cljs-bean pattern: O(1) creation, convert on access.
 *
 * All property access is sandboxed - see sandbox-boundary.ts for security model.
 */
export class SchemeJSObject {
  static __class__ = "js-object";

  constructor(readonly source: object) {}

  /** Unwrap to original JS object (TO_JS protocol). */
  [TO_JS](): object {
    return this.source;
  }

  /**
   * Get property value, wrapping result through membrane.
   * Uses sandboxed access - blocks prototype chain escapes.
   */
  get(key: string | symbol): SchemeValue {
    const result = sandboxedAccess(this.source, key);
    if (result === NOT_FOUND) {
      return nil;
    }
    return fromJS(result);
  }

  /**
   * Set property value, unwrapping through membrane.
   * Uses sandboxed set - blocks dangerous property names.
   */
  set(key: string | symbol, value: SchemeValue): void {
    sandboxedSet(this.source, key, toJS(value));
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
    return sandboxedDelete(this.source, key);
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
export class SchemeJSFunction {
  static __class__ = "js-function";

  constructor(readonly source: Function) {}

  /** Unwrap to original JS function (TO_JS protocol). */
  [TO_JS](): Function {
    return this.source;
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

  // Binary types pass through (polymorphic ops)
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
  if (value === nil) return null;

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

/** Safe integers ↔ JS number (for bitwise ops etc) */
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

    if (args.length < minArgs) {
      throw new TypeError(`${this.name}: expected at least ${minArgs} args, got ${args.length}`);
    }

    if (!this.inRest && args.length > minArgs) {
      throw new TypeError(`${this.name}: expected ${minArgs} args, got ${args.length}`);
    }

    const jsArgs = args.map((arg, i) => {
      const prof = i < this.in.length ? this.in[i] : this.inRest!;

      if (!prof.match(arg)) {
        throw new TypeError(`${this.name}: argument ${i} type mismatch`);
      }
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
    if (!op) {
      throw new Error(`${this.name}: unknown operator '${name}'`);
    }
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
