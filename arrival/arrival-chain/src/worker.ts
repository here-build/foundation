import { autorun } from "mobx";
import invariant from "tiny-invariant";

import type { ModelBackend } from "./model.js";
import { Project } from "./project.js";
import { InferenceError, InferenceResult, type InferenceTask } from "./task.js";

export interface WorkerOptions {
  /** Stop the worker. */
  signal?: AbortSignal;
  /**
   * Per-run backend override. Three shapes:
   *   - omitted        — backends come from Project.getBackend(name)
   *   - ModelBackend   — used for every task, bypasses model resolution
   *                      (convenient for tests that don't care about
   *                       per-provider routing)
   *   - Record<provider, ModelBackend> — keyed by provider name; takes
   *                      precedence over the static registry per provider
   */
  backends?: ModelBackend | Record<string, ModelBackend>;
}

const isSingleBackend = (b: ModelBackend | Record<string, ModelBackend>): b is ModelBackend =>
  typeof (b as ModelBackend).complete === "function";

/**
 * Observes `project.tasks` and drains pending tasks via the backend
 * registered for the resolved provider.
 *
 * Cache identity is the tier (what the program wrote in `(infer "fast"
 * ...)`). Concrete model selection happens here — `project.models[tier]`
 * resolves to "provider:model"; the backend for `provider` is looked
 * up from `opts.backends` first, then from `Project.getBackend(name)`.
 *
 * Multiple workers on the same doc share work via the result field —
 * first to write wins; later writers' .complete() lands after but isn't
 * published.
 */
export function runProjectWorker(project: Project, opts: WorkerOptions = {}): Promise<void> {
  const claimed = new WeakSet<InferenceTask>();

  const dispatch = (tier: string): { backend: ModelBackend; concreteModel: string } => {
    // Single-backend shim: bypass resolution entirely, use tier as the
    // concrete model name. Common in tests; not the production path.
    if (opts.backends && isSingleBackend(opts.backends)) {
      return { backend: opts.backends, concreteModel: tier };
    }
    const { provider, modelName } = project.resolveTier(tier);
    const override = opts.backends as Record<string, ModelBackend> | undefined;
    const backend = override?.[provider] ?? Project.getBackend(provider);
    invariant(backend, `Worker: no backend registered for provider "${provider}" (tier "${tier}")`);
    return { backend, concreteModel: modelName };
  };

  return new Promise<void>((resolve) => {
    const dispose = autorun(() => {
      // eslint-disable-next-line no-console
      console.log("[worker autorun] tasks.size =", project.tasks.size);
      for (const task of project.tasks.values()) {
        if (task.result !== null || claimed.has(task)) continue;
        // eslint-disable-next-line no-console
        console.log("[worker dispatch]", task.model, task.prompt.slice(0, 60));
        claimed.add(task);
        let dispatched: ReturnType<typeof dispatch>;
        try {
          dispatched = dispatch(task.model);
        } catch (err: unknown) {
          task.result = new InferenceError({
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        dispatched.backend
          .complete({ model: dispatched.concreteModel, prompt: task.prompt, schema: task.schema })
          .then(
            (value) => {
              // Pretty-printed (2-space indent) — the monitor renders the
              // valueJson directly; humans can read it without re-formatting
              // and `JSON.parse` is indifferent to whitespace either way.
              task.result = new InferenceResult({ valueJson: JSON.stringify(value, null, 2) });
            },
            (err: unknown) => {
              task.result = new InferenceError({
                message: err instanceof Error ? err.message : String(err),
              });
            },
          );
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
  });
}
