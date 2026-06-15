/**
 * Pure Scheme Module
 *
 * Builds a minimal Scheme environment module from the SINGLE unified allowlist
 * (`SAFE_BUILTINS`, ../safe_builtins.ts) — the same list that drives the
 * production `sandboxedEnv` (../sandbox-env.ts). This is the auto-load base
 * `Environment.fromModules` uses for general callers.
 *
 * ============================================================================
 * UNIFICATION (S8-CORE, 2026-06-09)
 * ============================================================================
 * The audit found two divergent allowlists. This module used to own a SECOND,
 * hand-maintained `PURE_SCHEME_BINDINGS` array. It is gone:
 *
 *   • The allowlist is now `SAFE_BUILTINS` (one list). `createPureSchemeModule`
 *     projects exactly those names off the source env.
 *   • `PURE_SCHEME_BINDINGS` (now DERIVED from the live `sandboxedEnv` surface)
 *     is exported from ../sandbox.ts, which can safely import ../sandbox-env.ts
 *     (it is a leaf, outside the Environment↔pure-scheme module cycle).
 *     Re-exporting it from HERE would pull the heavy sandbox-env graph into that
 *     cycle and break class initialization — so it lives next to `createSandbox`.
 *
 * There is no longer a sandbox block list at all: the host-language verbs one
 * once fenced (eval / load / set-obj! / new / …) were deleted at the source by
 * the host-language sweep, so the allowlist is the only lever and non-existence
 * is the guarantee.
 *
 * The SANDBOX itself has one source of truth: `sandboxedEnv`. `createSandbox`
 * projects it directly (see ../sandbox.ts); this module is the general-purpose
 * base for non-sandbox `fromModules` callers, sharing the same allowlist.
 */

import type { EnvironmentModule, FallbackResolver } from "../bindings.js";
import { BOOTSTRAP_SCHEME } from "../bootstrap.js";
import { nil, type SchemeValue } from "../types.js";
import { SAFE_BUILTINS } from "../safe_builtins.js";

/**
 * Create a resolver that pulls the allowlisted Scheme bindings from a source
 * environment. Used to create a pure base from an existing loaded environment.
 */
export function createPureSchemeResolver(sourceEnv: {
  get(name: string, opts?: { throwError?: boolean }): SchemeValue | undefined;
}): FallbackResolver {
  const allow = new Set<string>(SAFE_BUILTINS);
  return {
    id: "pure-scheme",
    resolve(name: string): SchemeValue | undefined {
      if (name === "nil") return nil;
      return allow.has(name) ? sourceEnv.get(name, { throwError: false }) : undefined;
    },
  };
}

/**
 * Create a pure Scheme module that pulls allowlisted bindings from a source
 * environment.
 *
 * @example
 * ```typescript
 * import { global_env } from "./stdlib.js";
 * const pureModule = createPureSchemeModule(global_env);
 * const sandbox = Environment.fromModules([pureModule]);
 * ```
 */
export function createPureSchemeModule(sourceEnv: {
  get(name: string, opts?: { throwError?: boolean }): unknown;
}): EnvironmentModule {
  const bindings: Record<string, SchemeValue> = {
    // nil is a constant, not in source env.
    nil,
  };

  for (const name of SAFE_BUILTINS) {
    if (name === "nil") continue;
    const value = sourceEnv.get(name, { throwError: false });
    if (value !== undefined) {
      bindings[name] = value as SchemeValue;
    }
  }

  return {
    id: "pure-scheme",
    bindings,
    bootstrap: BOOTSTRAP_SCHEME,
  };
}
