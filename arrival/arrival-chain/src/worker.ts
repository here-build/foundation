import { autorun } from "mobx";

import type { InferenceCache } from "./cache.js";
import type { ModelRouter } from "./registry.js";
import { InferenceError, InferenceResult, type InferenceTask } from "./task.js";

export interface OrchestratorOptions {
  /** Inference cache — autoruns observe `cache.tasks` and drain pending. */
  cache: InferenceCache;
  /** Model-id → backend router. The runner owns this; programs just call
   *  `(infer "model-name" …)` with concrete model names and the router
   *  decides which backend serves which model. */
  router: ModelRouter;
  /** Stop the orchestrator. */
  signal?: AbortSignal;
}

/**
 * The orchestrator. Observes `cache.tasks` via mobx autorun; for each
 * pending task, looks up its `task.model` in the router, awaits the
 * backend's response, writes back to `task.result`.
 *
 * Runtime-agnostic — no Node-specific APIs. Drops in unchanged to:
 *   - Local Node daemon (LayeredRouter of env+keychain+detected)
 *   - Cloudflare DO (StaticRouter populated from `env`)
 *   - Tests (singletonRouter)
 *
 * Multiple orchestrators on the same cache share work via the result
 * field — first to write wins; later writers' result lands after but
 * isn't published. Tie-breaking via the per-instance `claimed` WeakSet
 * keeps a single orchestrator from claiming the same task twice.
 */
export function startOrchestrator(opts: OrchestratorOptions): { done: Promise<void> } {
  const { cache, router } = opts;
  const claimed = new WeakSet<InferenceTask>();
  const log = (...a: unknown[]): void => console.log("[orch]", ...a);

  log("startOrchestrator: spinning up");

  return {
    done: new Promise<void>((resolve) => {
      const dispatch = async (task: InferenceTask): Promise<void> => {
        const modelId = task.model;
        const promptPreview = task.prompt.slice(0, 80).replace(/\n/g, " ");
        log("dispatch start model=", modelId, "prompt=", promptPreview);
        const backend = await router.backendFor(modelId);
        if (!backend) {
          const msg = `Orchestrator: no backend registered for model "${modelId}"`;
          log("dispatch no-backend:", msg);
          task.result = new InferenceError({ message: msg });
          return;
        }
        log("dispatch calling backend.complete model=", modelId);
        try {
          const { value, usage } = await backend.complete({
            model: modelId,
            prompt: task.prompt,
            schema: task.schema,
          });
          log("dispatch backend OK model=", modelId, "preview=", JSON.stringify(value).slice(0, 120));
          task.result = new InferenceResult({
            valueJson: JSON.stringify(value, null, 2),
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log("dispatch backend FAIL model=", modelId, "err=", msg);
          task.result = new InferenceError({ message: msg });
        }
      };

      let lastSeen = 0;
      const dispose = autorun(() => {
        const size = cache.tasks.size;
        if (size !== lastSeen) {
          log("autorun cache.tasks.size=", size, "(was", lastSeen + ")");
          lastSeen = size;
        }
        let scanned = 0;
        let claimedHere = 0;
        for (const task of cache.tasks.values()) {
          scanned++;
          if (task.result !== null || claimed.has(task)) continue;
          claimed.add(task);
          claimedHere++;
          void dispatch(task);
        }
        if (claimedHere > 0) {
          log("autorun claimed", claimedHere, "of", scanned, "tasks");
        }
      });

      const stop = (): void => {
        log("stop signal — disposing autorun");
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
