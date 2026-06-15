import { uncachedSumStrategy, type InferCost, type ProjectedCostStrategy, type TokenUsage } from "@here.build/arrival-inference";
import { InferBinding, referenceCost } from "@here.build/arrival-inference";
import type { EvalTrace } from "@here.build/arrival-provenance";

/**
 * Per-task cost facts extracted from one run's trace. The content-addressed
 * cache fires exactly ONE worker per task however many invocations hit it —
 * so cost attribution is per-task, not per-invocation.
 */
export interface TaskCost {
  /** Tier the task was minted under (tuple[0]). NB: not the resolved model —
   *  the router picks the concrete model at completion time, not yet persisted,
   *  so pricing falls back to DEFAULT for unknown keys. Correct while a single
   *  model is wired; revisit when multi-model lands. */
  model: string;
  usage: TokenUsage;
  /** This task fired ≥1 fresh (uncached) call this run — i.e. it was paid for,
   *  not served entirely from a prior run's result. */
  freshThisRun: boolean;
  /** How many invocations bound to this task — each is one deployed call under
   *  the uncached projection. */
  calls: number;
}

export interface RunCost {
  /** USD actually paid this run: each freshly-computed task counted ONCE,
   *  regardless of how many invocations reused it. */
  spent: number;
  /** USD the content-addressed cache covered = uncached baseline − spent.
   *  Cross-run replay AND within-run dedup both land here. Always measured
   *  against the uncached baseline, independent of the projection strategy. */
  saved: number;
  /** USD one cold (fully uncached) deployed run would cost, via the pluggable
   *  strategy. v1 strategy = sum every call at full price, so `projected`
   *  equals `spent + saved`; a future strategy (prod-side caching, batching)
   *  may diverge — which is exactly why it's separate from `saved`. */
  projected: number;
}

/**
 * Pure cost arithmetic over already-extracted per-task facts. Kept separate
 * from the trace walk so the subtle part — count each fresh task once, price
 * reuse against the uncached baseline — is unit-testable without an interpreter.
 */
export function summarizeCosts(
  tasks: readonly TaskCost[],
  strategy: ProjectedCostStrategy = uncachedSumStrategy,
): RunCost {
  let spent = 0;
  let uncached = 0;
  const calls: InferCost[] = [];
  for (const t of tasks) {
    const unit = referenceCost(t.model, t.usage);
    if (t.freshThisRun) spent += unit; // a fresh task is paid for exactly once
    uncached += unit * t.calls; // every invocation at full price = the baseline
    for (let i = 0; i < t.calls; i++) calls.push({ model: t.model, usage: t.usage });
  }
  const projected = strategy.project(calls).total;
  const saved = uncached - spent;
  return { spent, saved, projected };
}

/**
 * Walk a trace's task→invocations index into per-task cost facts, then
 * summarize. A task contributes only once it has a resolved result carrying
 * token usage — pending or errored tasks have no cost to count yet.
 *
 * `freshThisRun` reads the per-invocation `cached` flag (stamped at bind time):
 * a task is fresh this run iff at least one of its invocations bound before it
 * resolved (`cached === false`). A task every invocation found already-resolved
 * pre-existed the run (pure replay → fully saved).
 */
export function runCostSummary(trace: EvalTrace, strategy: ProjectedCostStrategy = uncachedSumStrategy): RunCost {
  const tasks: TaskCost[] = [];
  for (const [obj, invs] of trace.invocationByTask) {
    if (!(obj instanceof InferBinding)) continue;
    const usage = obj.completion?.usage;
    if (!usage) continue; // pending / errored / no-usage backend → nothing to count yet
    tasks.push({
      model: obj.model,
      usage,
      freshThisRun: invs.some((inv) => inv.cached === false),
      calls: invs.length,
    });
  }
  return summarizeCosts(tasks, strategy);
}
