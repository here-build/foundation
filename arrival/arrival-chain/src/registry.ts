import type { ModelBackend } from "./model.js";

/**
 * Provider-name → `ModelBackend` lookup. Async so implementations can
 * defer expensive work to first use (lazy-load an SDK, read a key from
 * the OS keychain, probe a localhost endpoint). Returns `null` when no
 * backend is configured for `provider` — the orchestrator turns that
 * into a per-task `InferenceError` rather than crashing the worker.
 *
 * Decoupled from `Project` so the same orchestrator runs unchanged in:
 *   - the local Node daemon (LayeredRegistry composed from env +
 *     keychain + auto-detected local servers)
 *   - a Cloudflare Worker / DO (StaticRegistry populated from `env`)
 *   - tests (singletonRegistry returning a stub for everything)
 */
export interface BackendRegistry {
  get(provider: string): Promise<ModelBackend | null>;
}

/**
 * In-memory provider→backend map. Pass entries at construction; mutating
 * the registry after construction is a separate concern (rebuild the
 * registry, don't reach in).
 */
export class StaticRegistry implements BackendRegistry {
  private readonly entries: ReadonlyMap<string, ModelBackend>;

  constructor(entries: Iterable<readonly [string, ModelBackend]> | Record<string, ModelBackend>) {
    this.entries =
      entries instanceof Map
        ? entries
        : Symbol.iterator in (entries as object)
          ? new Map(entries as Iterable<readonly [string, ModelBackend]>)
          : new Map(Object.entries(entries as Record<string, ModelBackend>));
  }

  async get(provider: string): Promise<ModelBackend | null> {
    return this.entries.get(provider) ?? null;
  }
}

/**
 * Composition: try each layer in order; first non-null wins. Use when
 * the daemon has multiple sources of backends (env vars override
 * keychain entries override auto-detected local servers, for example).
 */
export class LayeredRegistry implements BackendRegistry {
  constructor(private readonly layers: readonly BackendRegistry[]) {}

  async get(provider: string): Promise<ModelBackend | null> {
    for (const layer of this.layers) {
      const b = await layer.get(provider);
      if (b !== null) return b;
    }
    return null;
  }
}

/**
 * Convenience for tests: returns `backend` for every provider name.
 * Equivalent to today's `runWorker({ backends: <single ModelBackend> })`
 * shim but expressed via the registry interface.
 */
export function singletonRegistry(backend: ModelBackend): BackendRegistry {
  return {
    async get() {
      return backend;
    },
  };
}

/**
 * The empty registry — every `get` returns null. Useful as the default
 * layer when no backend is configured (the orchestrator will mark every
 * task as an InferenceError of "no backend for provider X").
 */
export const emptyRegistry: BackendRegistry = {
  async get() {
    return null;
  },
};
