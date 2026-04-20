/**
 * Atomic Binding System for Scheme Environment
 *
 * Each binding is a self-contained, typed object that describes
 * a single name in the environment. This enables:
 * - Separation of function/macro/syntax/value bindings
 * - Extensible fallback resolution (keywords, dot notation, etc.)
 * - Future type annotations
 * - Better testability and modularity
 */

import type { Environment } from "./Environment.js";
import type { Pair } from "./Pair.js";
import type { SchemeValue } from "./types.js";

// ============================================
// Evaluation Context
// ============================================

/**
 * Context passed through the evaluation chain.
 * Available as `this` in function bindings.
 */
export interface EvalContext {
  /** Current lexical environment */
  env: Environment;
  /** Current dynamic environment (for dynamic scoping) */
  dynamic_env: Environment;
  /** Whether to use dynamic scoping */
  use_dynamic: boolean;
  /** Error handler */
  error?: (e: Error, code?: SchemeValue) => void;
}

// ============================================
// Base Binding Interface
// ============================================

/**
 * Common interface for all binding types.
 */
export interface Binding {
  /** The Scheme name this binding is registered under */
  readonly name: string;
  /** Documentation string */
  readonly doc?: string;
  /** Binding type discriminator */
  readonly kind: "function" | "macro" | "syntax" | "value";
}

// ============================================
// Function Binding
// ============================================

/**
 * A regular Scheme function.
 * Arguments are evaluated before the function is called.
 */
export class FunctionBinding implements Binding {
  readonly kind = "function" as const;

  constructor(
    readonly name: string,

    readonly fn: (this: EvalContext, ...args: any[]) => any,
    readonly doc?: string,
  ) {}

  /**
   * Call the function with evaluated arguments.
   */
  call(args: SchemeValue[], ctx: EvalContext): SchemeValue {
    return this.fn.call(ctx, ...args);
  }
}

// ============================================
// Macro Binding
// ============================================

/**
 * A Scheme macro (define-macro style).
 * Receives unevaluated code and returns expanded code.
 */
export class MacroBinding implements Binding {
  readonly kind = "macro" as const;

  constructor(
    readonly name: string,
    readonly transform: (this: EvalContext, code: Pair) => SchemeValue,
    readonly doc?: string,
  ) {}

  /**
   * Expand the macro with unevaluated code.
   */
  expand(code: Pair, ctx: EvalContext): SchemeValue {
    return this.transform.call(ctx, code);
  }
}

// ============================================
// Syntax Binding
// ============================================

/**
 * A hygienic macro (syntax-rules style).
 * Uses pattern matching for expansion.
 */
export class SyntaxBinding implements Binding {
  readonly kind = "syntax" as const;

  constructor(
    readonly name: string,
    readonly rules: SyntaxRules,
    readonly doc?: string,
  ) {}
}

/**
 * Syntax rules for hygienic macros.
 * This is a placeholder - the actual implementation is complex.
 */
export interface SyntaxRules {
  literals: string[];
  patterns: SyntaxPattern[];
}

export interface SyntaxPattern {
  pattern: SchemeValue;
  template: SchemeValue;
}

// ============================================
// Value Binding
// ============================================

/**
 * A simple value binding (constants, parameters, etc.)
 */
export class ValueBinding implements Binding {
  readonly kind = "value" as const;

  constructor(
    readonly name: string,
    readonly value: SchemeValue,
    readonly doc?: string,
    readonly constant: boolean = false,
  ) {}
}

// ============================================
// Fallback Resolver
// ============================================

/**
 * Called when normal symbol lookup fails.
 * Enables extensible resolution strategies like:
 * - Keyword accessors (:key -> property accessor)
 * - Dot notation (foo.bar -> property access)
 * - Auto-imports
 * - etc.
 */
export interface FallbackResolver {
  /**
   * Unique identifier for this resolver.
   * Used to prevent duplicate registration.
   */
  readonly id: string;

  /**
   * Attempt to resolve a symbol name.
   *
   * @param name - The symbol name that wasn't found
   * @param env - The environment where lookup failed
   * @returns Resolved value, or undefined if this resolver doesn't handle it
   */
  resolve(name: string, env: Environment): SchemeValue | undefined;
}

// ============================================
// Keyword Resolver
// ============================================

/**
 * Resolves :keyword symbols to property accessor functions.
 * This is Clojure/Common Lisp style keyword access.
 *
 * Example: (:name obj) -> obj.name
 */
export class KeywordResolver implements FallbackResolver {
  readonly id = "keyword";

  resolve(name: string, _env: Environment): SchemeValue | undefined {
    if (typeof name === "string" && name.startsWith(":")) {
      const key = name.slice(1);
      // Return a function that accesses that property
      const accessor = (obj: Record<string, unknown>) => {
        if (obj === null || obj === undefined) {
          return accessor; // Partial application
        }
        return obj[key];
      };
      // Add valueOf for proper symbol representation
      Object.defineProperty(accessor, "valueOf", {
        value: () => name,
        enumerable: false,
      });
      return accessor as SchemeValue;
    }
    return undefined;
  }
}

// ============================================
// Helper: Create bindings from plain objects
// ============================================

/**
 * Create a FunctionBinding from a plain function definition.
 */
export function fn(
  name: string,

  impl: (this: EvalContext, ...args: any[]) => any,
  doc?: string,
): FunctionBinding {
  return new FunctionBinding(name, impl, doc);
}

/**
 * Create a MacroBinding from a plain macro definition.
 */
export function macro(
  name: string,
  transform: (this: EvalContext, code: Pair) => SchemeValue,
  doc?: string,
): MacroBinding {
  return new MacroBinding(name, transform, doc);
}

/**
 * Create a ValueBinding from a plain value.
 */
export function val(name: string, value: SchemeValue, doc?: string, constant = false): ValueBinding {
  return new ValueBinding(name, value, doc, constant);
}

// ============================================
// Core JavaScript Globals Resolver
// ============================================

/**
 * Core JavaScript globals needed for basic LIPS functionality.
 * This is a controlled allowlist of globals that bootstrap.scm depends on.
 */
const CORE_JS_GLOBALS: Record<string, unknown> = {
  // Constructors
  Array,
  Object,
  RegExp,
  Error,
  Promise,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  Date,
  // Math object
  Math,
  // JSON
  JSON,
  // Symbol
  Symbol,
  // Global functions
  parseInt: Number.parseInt,
  parseFloat: Number.parseFloat,
  isNaN: Number.isNaN,
  isFinite: Number.isFinite,
  encodeURI,
  decodeURI,
  encodeURIComponent,
  decodeURIComponent,
  // Constants
  Infinity,
  NaN: Number.NaN,
  undefined,
};

/**
 * Resolver that provides core JavaScript globals.
 * Use this when you need basic JS interop (Arrays, Math, etc.)
 */
export class CoreJavaScriptResolver implements FallbackResolver {
  readonly id = "core-javascript";

  resolve(name: string): SchemeValue | undefined {
    if (Object.hasOwn(CORE_JS_GLOBALS, name)) {
      return CORE_JS_GLOBALS[name] as SchemeValue;
    }
    return undefined;
  }
}

/**
 * Resolver that provides browser-specific globals.
 * Only use this in browser environments.
 */
export class BrowserGlobalsResolver implements FallbackResolver {
  readonly id = "browser-globals";

  resolve(name: string): SchemeValue | undefined {
    // Only available in browser context
    if (typeof globalThis === "undefined") return undefined;

    const globals: Record<string, unknown> = {
      window: typeof window === "undefined" ? undefined : window,
      document: typeof document === "undefined" ? undefined : document,
      localStorage: typeof localStorage === "undefined" ? undefined : localStorage,
      sessionStorage: typeof sessionStorage === "undefined" ? undefined : sessionStorage,
      fetch: typeof fetch === "undefined" ? undefined : fetch,
      setTimeout: typeof setTimeout === "undefined" ? undefined : setTimeout,
      setInterval: typeof setInterval === "undefined" ? undefined : setInterval,
      clearTimeout: typeof clearTimeout === "undefined" ? undefined : clearTimeout,
      clearInterval: typeof clearInterval === "undefined" ? undefined : clearInterval,
      requestAnimationFrame: typeof requestAnimationFrame === "undefined" ? undefined : requestAnimationFrame,
      cancelAnimationFrame: typeof cancelAnimationFrame === "undefined" ? undefined : cancelAnimationFrame,
    };

    if (Object.hasOwn(globals, name) && globals[name] !== undefined) {
      return globals[name] as SchemeValue;
    }
    return undefined;
  }
}

/**
 * Resolver that provides Node.js-specific globals.
 * Only use this in Node.js environments.
 */
export class NodeGlobalsResolver implements FallbackResolver {
  readonly id = "node-globals";

  resolve(name: string): SchemeValue | undefined {
    const globals: Record<string, unknown> = {
      process: typeof process === "undefined" ? undefined : process,
      Buffer: typeof Buffer === "undefined" ? undefined : Buffer,
      console: typeof console === "undefined" ? undefined : console,
      __dirname: undefined, // These need special handling in real impl
      __filename: undefined,
    };

    if (Object.hasOwn(globals, name) && globals[name] !== undefined) {
      return globals[name] as SchemeValue;
    }
    return undefined;
  }
}

// ============================================
// Environment Module System
// ============================================

/**
 * An EnvironmentModule is a composable unit that provides:
 * - Direct bindings (eager, added to __env__)
 * - A resolver for lazy/dynamic lookup
 * - Bootstrap Scheme code to run after bindings are set
 *
 * Modules are composed into an environment chain where each module
 * becomes a child environment of the previous one. Resolution order
 * is per-module: bindings first, then resolver, then yield to parent.
 */
export interface EnvironmentModule {
  /**
   * Unique identifier for this module.
   * Used for dependency resolution and debugging.
   */
  readonly id: string;

  /**
   * Module IDs that must be loaded before this module.
   */
  readonly dependencies?: string[];

  /**
   * Direct bindings to add to the environment.
   * These are checked before resolvers.
   */
  readonly bindings?: Record<string, SchemeValue>;

  /**
   * Resolver for lazy/dynamic symbol lookup.
   * Called when direct binding lookup fails.
   * Return undefined to yield to parent module.
   */
  readonly resolver?: FallbackResolver;

  /**
   * Scheme code to evaluate after bindings and resolver are set.
   * Useful for defining derived functions/macros.
   */
  readonly bootstrap?: string;
}
