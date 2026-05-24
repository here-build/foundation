import { autorun } from "mobx";

import type { InferenceCache } from "./cache.js";
import type { Project } from "./project.js";
import type { BackendRegistry } from "./registry.js";
import { InferenceError, InferenceResult, type InferenceTask } from "./task.js";

export interface OrchestratorOptions {
  /** Project doc — read for tier → provider:model resolution. */
  project: Project;
  /** Inference cache — autoruns observe `cache.tasks` and drain pending. */
  cache: InferenceCache;
  /** Provider → backend lookup. Replaces the old static `Project.getBackend`. */
  backends: BackendRegistry;
  /** Stop the orchestrator. */
  signal?: AbortSignal;
}

/**
 * The orchestrator. Observes `cache.tasks` via mobx autorun; for each
 * pending task, resolves tier → provider:model through `project.models`,
 * fetches the backend from `backends`, awaits the result, writes back
 * to `task.result`.
 *
 * Runtime-agnostic — no Node-specific APIs. Drops in unchanged to:
 *   - Local Node daemon (LayeredRegistry of env+keychain+detected)
 *   - Cloudflare DO (StaticRegistry populated from `env`)
 *   - Tests (singletonRegistry)
 *
 * Multiple orchestrators on the same cache share work via the result
 * field — first to write wins; later writers' result lands after but
 * isn't published. Tie-breaking via the per-instance `claimed` WeakSet
 * keeps a single orchestrator from claiming the same task twice.
 */
export function startOrchestrator(opts: OrchestratorOptions): { done: Promise<void> } {
  const { project, cache, backends } = opts;
  const claimed = new WeakSet<InferenceTask>();

  return {
    done: new Promise<void>((resolve) => {
      const dispatch = async (task: InferenceTask): Promise<void> => {
        let provider: string;
        let modelName: string;
        let tierError: unknown = null;
        try {
          ({ provider, modelName } = project.resolveTier(task.model));
        } catch (error) {
          tierError = error;
          provider = task.model;
          modelName = task.model;
        }
        const backend = await backends.get(provider);
        if (!backend) {
          task.result = new InferenceError({
            message: tierError
              ? tierError instanceof Error ? tierError.message : String(tierError)
              : `Orchestrator: no backend registered for provider "${provider}" (tier "${task.model}")`,
          });
          return;
        }
        try {
          const value = await backend.complete({
            model: modelName,
            prompt: task.prompt,
            schema: task.schema,
          });
          // Pretty-printed (2-space) — the monitor renders valueJson directly;
          // JSON.parse is whitespace-indifferent so this costs nothing.
          task.result = new InferenceResult({ valueJson: JSON.stringify(value, null, 2) });
        } catch (error) {
          task.result = new InferenceError({
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const dispose = autorun(() => {
        for (const task of cache.tasks.values()) {
          if (task.result !== null || claimed.has(task)) continue;
          claimed.add(task);
          void dispatch(task);
        }
      });

      const stop = (): void => {
        dispose();
        resolve();
      };
      if (opts.signal) {
        if (opts.signal.aborted) return stop();
        opts.signal.addEventListener("abort", stop, { once: true });
      }
    }),
  };
}
