import type { TokenUsage } from "./model.js";

/**
 * USD per 1,000,000 tokens, input and output. The volatile half of cost
 * accounting: tokens are the stable fact carried on a `Completion`'s usage;
 * dollars are derived here at display time so a price change reflows without
 * rewriting history.
 *
 * APPROXIMATE seed values, OpenRouter-style. For LM Studio (free, local) runs
 * these are a *reference* ("what this would cost hosted"), not real spend; and
 * real prices drift. Treat this map as config to sync against live OpenRouter
 * pricing and to override per deployment — not a source of truth.
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMTok: number;
}

/** Fallback for a model not in the map — a small-open-model estimate. */
const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 0.1, outputPerMTok: 0.3 };

/**
 * Model id → price. Keys are the content-tuple model string. Unknown models
 * fall back to `DEFAULT_PRICE`. Approximate — sync against OpenRouter and/or
 * override per deployment.
 */
export const PRICE_MAP: Readonly<Record<string, ModelPrice>> = {
  // small open models (~7–9B hosted)
  "qwen3.5-9b": { inputPerMTok: 0.05, outputPerMTok: 0.1 },
  // hosted "mini" tier (approximate)
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "claude-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

export function priceFor(model: string): ModelPrice {
  return PRICE_MAP[model] ?? DEFAULT_PRICE;
}

/** Reference cost in USD for one inference's usage at its model's price. */
export function referenceCost(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  return (usage.inputTokens / 1_000_000) * p.inputPerMTok + (usage.outputTokens / 1_000_000) * p.outputPerMTok;
}
