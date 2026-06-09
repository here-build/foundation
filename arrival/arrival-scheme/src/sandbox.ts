/**
 * Sandbox Entry Point
 *
 * A minimal entry point for creating sandboxed Scheme environments.
 * Use packs to add capabilities - only imported packs are bundled.
 *
 * UNIFICATION (S8-CORE, 2026-06-09): `createSandbox` and the production
 * `sandboxedEnv` (../sandbox-env.ts, used by arrival-chain/mcp) now share ONE
 * binding set. The auto-loaded `pure-scheme` base module (modules/pure-scheme.ts)
 * projects `sandboxedEnv.__env__`, so the discovery surface here is exactly the
 * surface production runs — the prerequisite for the oracle's Σ layer (O2).
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
import type { SchemeValue } from "./types.js";
import { Environment } from "./Environment.js";
import { sandboxedEnv, FORBIDDEN_IN_SANDBOX } from "./sandbox-env.js";
import { nil } from "./types.js";

// Re-export types needed for sandbox usage
export { Environment as Environment } from "./Environment.js";
export type { EnvironmentModule as EnvironmentModule, FallbackResolver as FallbackResolver } from "./bindings.js";
export type { SchemeValue as SchemeValue } from "./types.js";

/**
 * The SINGLE enforced block list — re-exported from the production sandbox
 * (sandbox-env.ts). One Set decides what a sandbox may NOT see; the old
 * advisory array in modules/pure-scheme.ts is gone.
 */
export { FORBIDDEN_IN_SANDBOX as FORBIDDEN_IN_SANDBOX };

/**
 * The names a sandbox exposes, DERIVED from the production `sandboxedEnv` — the
 * single source of truth both entry points share. Read lazily (getter) so it
 * reflects the live surface, including bootstrap-injected extras (threading
 * macros, SRFI-1 helpers) that land on `sandboxedEnv` after construction.
 *
 * Exposed via a Proxy so the historical array surface (`.includes`, `.length`,
 * indexing, `.toContain`) keeps working with no second list to drift.
 */
export const PURE_SCHEME_BINDINGS: readonly string[] = new Proxy([] as string[], {
  get(_t, prop, receiver) {
    const snapshot = Object.keys(sandboxedEnv.__env__);
    const value = Reflect.get(snapshot, prop, receiver);
    return typeof value === "function" ? value.bind(snapshot) : value;
  },
  has(_t, prop) {
    return Reflect.has(Object.keys(sandboxedEnv.__env__), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(Object.keys(sandboxedEnv.__env__));
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(Object.keys(sandboxedEnv.__env__), prop);
  },
});

/**
 * Build the base module a sandbox runs on, projected from the SINGLE source of
 * truth (`sandboxedEnv`). Id is `"pure-scheme"` so `Environment.fromModules`
 * auto-load dedup is suppressed and the env-chain naming contract holds.
 */
function sandboxBaseModule(): EnvironmentModule {
  return {
    id: "pure-scheme",
    bindings: { ...(sandboxedEnv.__env__ as Record<string, SchemeValue>), nil },
  };
}

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

  // The base is the production `sandboxedEnv` surface — ONE construction path,
  // ONE binding set shared with arrival-chain/mcp. We pass it explicitly (id
  // "pure-scheme") so `fromModules` does NOT auto-load the divergent
  // global-env-sourced base.
  const modules: EnvironmentModule[] = [sandboxBaseModule()];

  // Add packs
  if (options.packs) {
    modules.push(...options.packs);
  }

  // Add user bindings
  modules.push({
    id: "user",
    bindings: (options.bindings ?? {}) as Record<string, never>,
  });

  return Environment.fromModules(modules);
}
