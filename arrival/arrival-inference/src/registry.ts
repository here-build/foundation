import type { ModelBackend } from "./model.js";

/**
 * The runner owns this map; programs call `(infer "model-name" …)` with concrete model
 * names and the runner decides which backend serves which. Async so implementations can
 * defer expensive work (SDK import, endpoint probe) to first use.
 *
 * `null` ⇒ no backend configured for `modelId` — the {@link InferStore} turns that into a
 * rejected cell rather than crashing the run.
 *
 * Decoupled from `Project` so ONE router runs unchanged across hosts:
 *   - local Node daemon — {@link LayeredRouter} over env + keychain + auto-detected local servers
 *   - Cloudflare Worker / DO — {@link StaticRouter} populated from `env`
 *   - tests — {@link singletonRouter} returning a stub for everything
 */
export interface ModelRouter {
  backendFor(modelId: string): Promise<ModelBackend | null>;
}

/** Immutable by construction — mutation means rebuild the router, never reach in. */
export class StaticRouter implements ModelRouter {
  private readonly entries: ReadonlyMap<string, ModelBackend>;

  constructor(entries: Iterable<readonly [string, ModelBackend]> | Record<string, ModelBackend>) {
    this.entries =
      entries instanceof Map
        ? entries
        : Symbol.iterator in (entries as object)
          ? new Map(entries as Iterable<readonly [string, ModelBackend]>)
          : new Map(Object.entries(entries as Record<string, ModelBackend>));
  }

  async backendFor(modelId: string): Promise<ModelBackend | null> {
    return this.entries.get(modelId) ?? null;
  }
}

/**
 * First non-null layer wins — layer ORDER is precedence (env over keychain over
 * auto-detected local servers, say). For a daemon with several backend sources.
 */
export class LayeredRouter implements ModelRouter {
  constructor(private readonly layers: readonly ModelRouter[]) {}

  async backendFor(modelId: string): Promise<ModelBackend | null> {
    for (const layer of this.layers) {
      const b = await layer.backendFor(modelId);
      if (b !== null) return b;
    }
    return null;
  }
}

/** Every model id resolves to `backend` — the test stub. */
export function singletonRouter(backend: ModelBackend): ModelRouter {
  return {
    async backendFor() {
      return backend;
    },
  };
}

/** The default layer when nothing is configured — every lookup is null, so the
 *  {@link InferStore} rejects each cell with "no backend for model X". */
export const emptyRouter: ModelRouter = {
  async backendFor() {
    return null;
  },
};
