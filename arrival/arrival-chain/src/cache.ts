import "@here.build/plexus/mobx/register";
import { docPlexus, Plexus, PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { InferenceTask } from "./task.js";

/**
 * Doc root for the inference cache — the content-addressed store of
 * resolved `(tier, prompt, schema, cacheKey)` → `InferenceTask` cells.
 *
 * Separated from `Project` (authored intent: files / programs / models /
 * env) so that:
 *
 *   1. Ephemeral runs (CLI `--file` mode) can assert tasks without
 *      polluting any project doc.
 *   2. Multiple projects can share a cache (same prompt-tuple → same hit).
 *   3. The two docs can have independent replication / retention / auth
 *      characteristics in production.
 *
 * Bind to a Project via `project.bindCache(cache)` before running
 * programs or starting workers.
 */
@syncing("ArrivalChainInferenceCache")
export class InferenceCache extends PlexusModel<null> {
  @syncing.child.map /** Content-addressed cache. Key = [tier, prompt, schema, cacheKey]. */
  accessor tasks: Map<readonly [string, string, string | null, string | null], InferenceTask> = new Map();

  transact(fn: () => void): void {
    const plexus = docPlexus.get(this.__doc__!);
    invariant(plexus, "InferenceCache: doc has no Plexus instance");
    plexus.transact(fn);
  }

  /**
   * Find-or-create a task for this content tuple. Pure datalog: asserting
   * an existing fact is a no-op. Concurrent calls converge on the same
   * entity via Plexus map semantics — no in-flight dedup needed at call
   * sites.
   */
  upsertTask(tier: string, prompt: string, schema: string | null, cacheKey: string | null = null): InferenceTask {
    const key = [tier, prompt, schema, cacheKey] as const;
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const task = new InferenceTask();
    this.tasks.set(key, task);
    return task;
  }
}

/**
 * Plexus instance bootstrap for an `InferenceCache` doc. Parallel to
 * `ArrivalChain` (the project-doc bootstrap).
 *
 *   const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
 *   const chain = ArrivalChain.bootstrap(new Project());
 *   chain.root.bindCache(cache);
 */
export class ArrivalCache extends Plexus<InferenceCache> {}
