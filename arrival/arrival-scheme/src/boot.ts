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
 * singletons (global_env, sandboxedEnv) exactly once per realm, so every
 * `Environment` reads the same flag. This is what makes the re-entrant inner
 * the re-entrant inner prelude exec safe — by the time it runs, the flag already reads
 * true (bridge.ts sets it at the top of initBridge, before the pack assembly),
 * so the inner exec's self-init check is a no-op and does not recurse.
 */
let bridgeInitialized = false;

/** True once the bridge bootstrap has STARTED (set at the top of initBridge). This
 *  is the re-entrancy guard — a prelude eval running mid-bootstrap sees it true and
 *  skips self-init. It does NOT mean assembly finished; for that await
 *  {@link whenBootstrapComplete}. */
export function isBridgeInitialized(): boolean {
  return bridgeInitialized;
}

/** Mark the bridge bootstrap as started. Called by bridge.ts only. */
export function markBridgeInitialized(): void {
  bridgeInitialized = true;
}

/** The bootstrap COMPLETION promise — resolves once every pack (native clusters +
 *  .scm base packs + sandbox seeding) has been assembled. Separate from the started
 *  flag above: the flag flips true synchronously at the top of initBridge, but the
 *  assembly is async, so a public `exec` must await THIS to avoid observing a
 *  half-assembled env. `null` until initBridge runs. */
let bootstrapComplete: Promise<void> | null = null;

/** Publish the completion promise. Called by bridge.ts only, inside initBridge. */
export function setBootstrapComplete(promise: Promise<void>): void {
  bootstrapComplete = promise;
}

/** The in-flight (or settled) bootstrap completion promise, or `null` if the
 *  bootstrap has not started. `exec` awaits this when the started-flag is already up. */
export function whenBootstrapComplete(): Promise<void> | null {
  return bootstrapComplete;
}
