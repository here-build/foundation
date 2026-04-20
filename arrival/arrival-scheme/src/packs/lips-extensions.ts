/**
 * LIPS Extensions Pack
 *
 * LIPS-specific bindings that extend R7RS Scheme.
 * These are not part of standard Scheme but useful for JS interop.
 *
 * @example
 * ```typescript
 * import { createSandbox } from '@here.build/arrival-scheme/sandbox';
 * import { createLipsExtensionsPack } from '@here.build/arrival-scheme/packs';
 *
 * const sandbox = await createSandbox({
 *   packs: [await createLipsExtensionsPack()]
 * });
 * ```
 */

import type { EnvironmentModule } from "../bindings.js";
import type { SchemeValue } from "../types.js";

/**
 * LIPS-specific binding names that extend R7RS.
 */
export const LIPS_EXTENSION_BINDINGS = [
  // LIPS-specific operators
  "%", // modulo alias
  "**", // exponentiation
  "1+", // increment
  "1-", // decrement
  "==", // JS-style equality

  // LIPS-specific predicates
  "empty?",
  "function?",
  "array?",
  "object?",
  "regex?",

  // Exactness shorthand
  "exact",
  "inexact",

  // JS-style string operations
  "concat",
  "join",
  "split",
  "replace",
  "match",
  "search",

  // Utility
  "type",
  "clone",
  "repr",
] as const;

/**
 * Create LIPS extensions pack.
 * Must be called after LIPS runtime is initialized (use within createSandbox).
 */
export async function createLipsExtensionsPack(): Promise<EnvironmentModule> {
  // Dynamic import to work with ESM
  const { global_env } = await import("../lips.js");

  const bindings: Record<string, SchemeValue> = {};

  for (const name of LIPS_EXTENSION_BINDINGS) {
    const value = global_env.get(name, { throwError: false });
    if (value !== undefined) {
      bindings[name] = value as SchemeValue;
    }
  }

  return {
    id: "lips-extensions",
    bindings,
  };
}
