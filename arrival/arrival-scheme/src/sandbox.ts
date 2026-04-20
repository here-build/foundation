/**
 * Sandbox Entry Point
 *
 * A minimal entry point for creating sandboxed Scheme environments.
 * Use packs to add capabilities - only imported packs are bundled.
 *
 * @example
 * ```typescript
 * import { createSandbox } from '@here.build/arrival-scheme/sandbox';
 * import { createLipsExtensionsPack } from '@here.build/arrival-scheme/packs';
 *
 * // Pure scheme sandbox
 * const pure = await createSandbox();
 *
 * // With LIPS extensions
 * const withLips = await createSandbox({ packs: [await createLipsExtensionsPack()] });
 * ```
 */

import type { EnvironmentModule } from "./bindings.js";
import { Environment } from "./Environment.js";

// Re-export types needed for sandbox usage
export { Environment as Environment } from "./Environment.js";
export type { EnvironmentModule as EnvironmentModule, FallbackResolver as FallbackResolver } from "./bindings.js";
export type { SchemeValue as SchemeValue } from "./types.js";

/**
 * Options for creating a sandbox environment.
 */
export interface SandboxOptions {
  /**
   * Packs to include in the sandbox.
   * Import packs explicitly - only imported packs are bundled.
   *
   * @example
   * ```typescript
   * import { createLipsExtensionsPack } from '@here.build/arrival-scheme/packs';
   * createSandbox({ packs: [await createLipsExtensionsPack()] });
   * ```
   */
  packs?: EnvironmentModule[];

  /**
   * Custom bindings to add to the sandbox.
   * These are added to a "user" module on top of the stack.
   */
  bindings?: Record<string, unknown>;
}

/**
 * Create a sandboxed Scheme environment.
 *
 * This is an async function because it needs to load the interpreter runtime.
 * The resulting environment is self-contained and isolated.
 *
 * @example
 * ```typescript
 * import { createSandbox } from '@here.build/arrival-scheme/sandbox';
 * import { createLipsExtensionsPack } from '@here.build/arrival-scheme/packs';
 *
 * // Pure scheme sandbox
 * const pure = await createSandbox();
 * await pure.eval('(+ 1 2 3)'); // => 6
 *
 * // Sandbox with LIPS extensions
 * const withLips = await createSandbox({ packs: [await createLipsExtensionsPack()] });
 * await withLips.eval('(** 2 10)'); // => 1024
 *
 * // Sandbox with custom bindings
 * const custom = await createSandbox({
 *   bindings: {
 *     'my-constant': 42,
 *     'my-fn': (x: number) => x * 2,
 *   }
 * });
 * ```
 */
export async function createSandbox(options: SandboxOptions = {}): Promise<Environment> {
  // Dynamically import the main module to ensure full initialization
  await import("./index.js");

  const modules: EnvironmentModule[] = [];

  // Add packs
  if (options.packs) {
    modules.push(...options.packs);
  }

  // Add user bindings
  modules.push({
    id: "user",
    bindings: (options.bindings ?? {}) as Record<string, never>,
  });

  // Create environment with auto-loaded pure scheme as base
  return Environment.fromModules(modules);
}

/**
 * List of all pure Scheme bindings available in sandboxes.
 * Re-exported for documentation and validation purposes.
 */
export {
  PURE_SCHEME_BINDINGS as PURE_SCHEME_BINDINGS,
  FORBIDDEN_IN_SANDBOX as FORBIDDEN_IN_SANDBOX,
} from "./modules/pure-scheme.js";
