import type { ModelBackend } from "./model.js";

/**
 * Model-name → `ModelBackend` lookup. The runner owns this map; programs
 * just call `(infer "model-name" "prompt" …)` with concrete model names
 * and the runner decides which backend serves which model. Async so
 * implementations can defer expensive work to first use.
 *
 * Returns `null` when no backend is configured for `modelId` — the
 * orchestrator turns that into a per-task `InferenceError` rather than
 * crashing the worker.
 *
 * Decoupled from `Project` so the same orchestrator runs unchanged in:
 *   - the local Node daemon (LayeredRouter composed from env + keychain
 *     + auto-detected local servers)
 *   - a Cloudflare Worker / DO (StaticRouter populated from `env`)
 *   - tests (singletonRouter returning a stub for everything)
 */
export interface ModelRouter {
  backendFor(modelId: string): Promise<ModelBackend | null>;
}

/**
 * In-memory model→backend map. Pass entries at construction; mutating
 * the router after construction is a separate concern (rebuild the
 * router, don't reach in).
 */
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
 * Composition: try each layer in order; first non-null wins. Use when
 * the daemon has multiple sources of backends (env vars override
 * keychain entries override auto-detected local servers, for example).
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

/**
 * Convenience for tests: returns `backend` for every model id.
 */
export function singletonRouter(backend: ModelBackend): ModelRouter {
  return {
    async backendFor() {
      return backend;
    },
  };
}

/**
 * The empty router — every lookup returns null. Useful as the default
 * layer when no backend is configured (the orchestrator marks every
 * task as an InferenceError of "no backend for model X").
 */
export const emptyRouter: ModelRouter = {
  async backendFor() {
    return null;
  },
};
