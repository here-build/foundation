import "@here.build/plexus/mobx/register";

import { PlexusModel, syncing } from "@here.build/plexus";
import { autorun } from "mobx";
import invariant from "tiny-invariant";

import type { Project } from "./project.js";

/**
 * Successful inference. Lives as a child of an `InferenceTask` — the
 * task's `result` slot transitions `null → InferenceResult` when the
 * worker finishes.
 */
@syncing("ArrivalChainInferenceResult")
export class InferenceResult extends PlexusModel<InferenceTask> {
  @syncing accessor valueJson: string = "null";
  get value(): unknown { return JSON.parse(this.valueJson); }
}

/**
 * Failed inference. Same slot, different shape — distinguishes success
 * vs. failure via type, not via a state field.
 */
@syncing("ArrivalChainInferenceError")
export class InferenceError extends PlexusModel<InferenceTask> {
  @syncing accessor message: string = "";
}

/**
 * One inference, keyed in `Project.tasks` by its content tuple
 * `[model, prompt, schema]`. The key IS the spec — no hash. The result
 * slot is a discriminated child:
 *   `null`             → pending
 *   `InferenceResult`  → resolved (value is in `result.value`)
 *   `InferenceError`   → failed (message in `result.message`)
 */
@syncing("ArrivalChainInferenceTask")
export class InferenceTask extends PlexusModel<Project> {
  @syncing.child accessor result: InferenceResult | InferenceError | null = null;

  get tuple(): readonly [string, string, string | null, string | null] {
    const k = this.parentFieldKey;
    invariant(Array.isArray(k), "InferenceTask: not keyed in a child.map");
    return k as readonly [string, string, string | null, string | null];
  }
  get model(): string { return this.tuple[0]; }
  get prompt(): string { return this.tuple[1]; }
  get schema(): string | null { return this.tuple[2]; }
  get cacheKey(): string | null { return this.tuple[3]; }

  /** Resolve when result is set; reject if it's an error. */
  waitFor(): Promise<unknown> {
    // Fast path: avoid the TDZ trap where autorun fires synchronously
    // inside `autorun(...)` and would read `dispose` before init.
    const r = this.result;
    if (r instanceof InferenceResult) return Promise.resolve(r.value);
    if (r instanceof InferenceError) return Promise.reject(new Error(r.message));
    return new Promise((resolve, reject) => {
      const dispose = autorun(() => {
        const r = this.result;
        if (r instanceof InferenceResult) { dispose(); resolve(r.value); }
        else if (r instanceof InferenceError) { dispose(); reject(new Error(r.message)); }
      });
    });
  }
}
