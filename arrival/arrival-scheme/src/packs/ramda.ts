/**
 * Ramda Pack
 *
 * Provides Ramda-based functional programming utilities for Scheme.
 * These functions work with both LIPS Scheme lists and JavaScript arrays.
 *
 * @example
 * ```typescript
 * import { createSandbox } from '@here.build/arrival-scheme/sandbox';
 * import { createRamdaPack } from '@here.build/arrival-scheme/packs';
 *
 * const sandbox = await createSandbox({
 *   packs: [await createRamdaPack()]
 * });
 * await sandbox.eval('(map (lambda (x) (* x 2)) (list 1 2 3))');
 * ```
 */

import type { EnvironmentModule } from "../bindings.js";
import type { SchemeValue } from "../types.js";

/**
 * Core Ramda binding names exposed to Scheme.
 * These are the most commonly used FP operations.
 */
export const RAMDA_BINDINGS = [
  // Core FP combinators
  "compose",
  "comp",
  "pipe",
  "thread",
  "flow",
  "curry",
  "partial",
  "flip",
  "identity",
  "id",
  "always",
  "constant",

  // Functor/Applicative/Monad operations
  "map",
  "fmap",
  "traverse",
  "apply-to",
  "lift-a2",
  "lift-a3",
  "chain",
  "flat-map",
  "flatten",

  // List operations
  "head",
  "first",
  "safe-head",
  "car",
  "cdr",
  "tail",
  "rest",
  "safe-tail",
  "init",
  "last",
  "safe-last",
  "length",
  "take",
  "drop",
  "slice",
  "append",
  "prepend",
  "concat",
  "join",

  // Type coercion
  "ensure-array",
  "ensure-string",
  "to-number",
  "to-int",

  // Predicates and filtering
  "all",
  "every",
  "any",
  "some",
  "none",
  "filter",
  "r-filter",
  "select",
  "where",
  "keep",
  "reject",
  "remove",
  "exclude",
  "partition",
  "split-by",
  "find",
  "locate",
  "search",
  "find-index",
  "find-last",
  "find-last-index",

  // Reduction and transformation
  "reduce",
  "fold",
  "accumulate",
  "aggregate",
  "reduce-right",
  "fold-right",
  "reduce-by",
  "group-by",
  "classify",
  "count-by",
  "tally",
  "sort",
  "order",
  "sort-by",
  "order-by",
  "sort-with",

  // Object operations
  "prop",
  "get",
  "access",
  "fetch",
  "path",
  "get-in",
  "navigate",
  "dig",
  "prop-or",
  "path-or",
  "safe-prop",
  "safe-path",
  "has",
  "contains",
  "exists?",
  "present?",
  "has-path",
  "props",
  "paths",
  "pick",
  "omit",
  "keys",
  "values",
  "toPairs",
  "fromPairs",

  // Logic and predicates
  "equals",
  "is",
  "is-nil",
  "is-empty",
  "default-to",
  "cond",
  "when",
  "unless",
  "if-else",

  // String operations
  "split",
  "match",
  "test",
  "replace",
  "to-lower",
  "to-upper",
  "trim",

  // Math operations
  "add",
  "subtract",
  "multiply",
  "divide",
  "modulo",
  "negate",
  "min",
  "max",
  "clamp",

  // Comparison
  "gt",
  "gte",
  "lt",
  "lte",

  // Utility
  "compact",

  // Error boundary patterns
  "try-prop",
  "try-path",
  "try-apply",
  "maybe-prop",
  "maybe-path",
] as const;

/**
 * Create the Ramda pack.
 * Must be called after LIPS runtime is initialized (use within createSandbox).
 */
export async function createRamdaPack(): Promise<EnvironmentModule> {
  // Dynamic import to get the RAMDA_FUNCTIONS from ramda-functions.ts
  const { RAMDA_FUNCTIONS } = await import("../ramda-functions.js");

  const bindings: Record<string, SchemeValue> = {};

  for (const name of RAMDA_BINDINGS) {
    const value = RAMDA_FUNCTIONS[name as keyof typeof RAMDA_FUNCTIONS];
    if (value !== undefined && value !== null) {
      bindings[name] = value as SchemeValue;
    }
  }

  return {
    id: "ramda",
    bindings,
  };
}
