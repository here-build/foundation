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

  call(args: SchemeValue[], ctx: EvalContext): SchemeValue {
    return this.fn.call(ctx, ...args);
  }
}

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

  expand(code: Pair, ctx: EvalContext): SchemeValue {
    return this.transform.call(ctx, code);
  }
}

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
