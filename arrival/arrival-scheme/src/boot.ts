/**
 * Realm-level runtime-bootstrap flag.
 *
 * The interpreter self-initializes on first `exec` (see generator-exec.ts):
 * `Environment.init()` runs the bridge bootstrap once per realm, and
 * `Environment.initialized` reflects whether it has completed/started.
 *
 * This module exists to break an import cycle: `bridge.ts` already imports
 * `Environment`, so `Environment.ts` cannot statically import the flag from
 * `bridge.ts`. Both modules import the flag from HERE instead — a leaf module
 * with no arrival-internal imports, so it sits cycle-neutral.
 *
 * The flag is realm-global on purpose: the bridge bootstrap mutates global
 * singletons (lipsGlobalEnv, sandboxedEnv) exactly once per realm, so every
 * `Environment` reads the same flag. This is what makes the re-entrant inner
 * `exec(BOOTSTRAP_SCHEME)` safe — by the time it runs, the flag already reads
 * true (bridge.ts sets it at the top of initBridge, before the bootstrap exec),
 * so the inner exec's self-init check is a no-op and does not recurse.
 */
let bridgeInitialized = false;

/** True once the bridge bootstrap has started (set at the top of initBridge). */
export function isBridgeInitialized(): boolean {
  return bridgeInitialized;
}

/** Mark the bridge bootstrap as started. Called by bridge.ts only. */
export function markBridgeInitialized(): void {
  bridgeInitialized = true;
}
