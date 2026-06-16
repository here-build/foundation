/**
 * Module & resolver contracts for the Scheme environment.
 *
 * Defines the two interfaces the environment-composition layer
 * (`Environment.fromModules`) consumes:
 * - `FallbackResolver` — extensible lazy lookup (keyword accessors, dot
 *   notation, auto-imports) tried when a direct binding lookup misses.
 * - `EnvironmentModule` — a composable unit of bindings + resolver +
 *   bootstrap code, layered into the environment chain.
 */

import type { Environment } from "./Environment.js";
import type { SchemeValue } from "./values/types.js";

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
