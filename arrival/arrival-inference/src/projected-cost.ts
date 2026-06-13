import type { TokenUsage } from "./model.js";
import { referenceCost } from "./pricing.js";

/** One inference's cost inputs: which model, how many tokens. */
export interface InferCost {
  model: string;
  usage: TokenUsage;
}

export interface ProjectedCost {
  /** Total USD for one deployed run under this strategy. */
  total: number;
  /** Per-model breakdown — feeds the per-block / hover surface. */
  byModel: ReadonlyArray<{ model: string; cost: number; calls: number }>;
}

/**
 * Projects what ONE *deployed* run of a program costs — distinct from what
 * dev-time experimentation *spent* (the content-addressed cache makes reruns
 * ~free). Pluggable, because "deployment cost" can be refined later
 * (production-side caching, model routing, batching, prompt-caching discounts);
 * v1 is the honest worst case — every inference at full price, uncached.
 *
 * Relationship to the measured numbers: for a given run, `spent + saved` equals
 * the uncached-sum projection of that run's calls — the cache splits the
 * deployment cost into what you paid (spent) and what it covered (saved).
 */
export interface ProjectedCostStrategy {
  readonly id: string;
  project(calls: readonly InferCost[]): ProjectedCost;
}

/** v1: sum every call at full uncached price — the "if deployed cold" figure. */
export const uncachedSumStrategy: ProjectedCostStrategy = {
  id: "uncached-sum",
  project(calls) {
    const agg = new Map<string, { cost: number; calls: number }>();
    let total = 0;
    for (const c of calls) {
      const cost = referenceCost(c.model, c.usage);
      total += cost;
      const cur = agg.get(c.model) ?? { cost: 0, calls: 0 };
      cur.cost += cost;
      cur.calls += 1;
      agg.set(c.model, cur);
    }
    return { total, byModel: [...agg].map(([model, v]) => ({ model, cost: v.cost, calls: v.calls })) };
  },
};
