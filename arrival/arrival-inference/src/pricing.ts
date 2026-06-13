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

// ── Reference SPEED table — the "performance computation factor" ──────────────
//
// The mirror of PRICE_MAP for TIME. A local (LM Studio / Ollama) run records its
// ACTUAL wall-clock per inference (`usage.durationMs`), but that's slow hardware. To
// answer "would this investigation finish in <5 min on a fast cloud endpoint?", we
// project: take the recorded TOKEN COUNTS and divide by a reference model's measured
// throughput. So we experiment cheaply on local models overnight and read out the
// EFFECTIVE cloud time, without burning OpenRouter credits on every iteration.
//
// Values are measured-throughput approximations (June 2026): Groq LPU + Cerebras WSE
// are the latency leaders OpenRouter routes to. `tokensPerSec` = sustained OUTPUT
// throughput; `ttftMs` = time-to-first-token (prefill + first token), which dominates
// for the scout's many tiny structured emissions. Sync against live provider stats.

/** Reference throughput for projecting effective cloud time. */
export interface ModelSpeed {
  /** Sustained output tokens/sec. */
  tokensPerSec: number;
  /** Time-to-first-token ms (prefill + first token). */
  ttftMs: number;
}

/** A generic hosted small-model floor when the reference isn't in the table. */
const DEFAULT_SPEED: ModelSpeed = { tokensPerSec: 120, ttftMs: 450 };

/**
 * Reference model id → measured throughput. The keys are REFERENCE endpoints we
 * project onto (the fast-cloud target), not necessarily the model that actually ran.
 * Pick the projection target by passing its id to `effectiveCloudMs` / the time
 * strategy — e.g. run the scout on local rnj, project onto "groq/llama-3.1-8b-instant".
 */
export const SPEED_MAP: Readonly<Record<string, ModelSpeed>> = {
  // Groq LPU — lowest TTFT, the scout-seat target (many tiny structured turns).
  "groq/llama-3.1-8b-instant": { tokensPerSec: 750, ttftMs: 150 },
  "groq/llama-3.3-70b-versatile": { tokensPerSec: 300, ttftMs: 250 },
  // Cerebras WSE — highest sustained throughput, the heavy-consolidation target.
  "cerebras/gpt-oss-120b": { tokensPerSec: 2000, ttftMs: 200 },
  "cerebras/llama-3.3-70b": { tokensPerSec: 1800, ttftMs: 200 },
  // Hosted flash tier (broad availability, moderate speed).
  "gemini-2.5-flash": { tokensPerSec: 200, ttftMs: 400 },
  // A local 8-bit MoE reference (so a local run can project onto "itself, hosted").
  "qwen3.6-35b-a3b": { tokensPerSec: 90, ttftMs: 600 },
};

export function speedFor(refModel: string): ModelSpeed {
  return SPEED_MAP[refModel] ?? DEFAULT_SPEED;
}

/**
 * Effective wall-clock ms ONE inference's token counts would take on `refModel` (a
 * fast-cloud target). `ttftMs` covers prefill + first token; the rest streams at
 * `tokensPerSec`. This is the per-call unit the parallelism-aware projector sums along
 * the critical path. Reads `usage.outputTokens`; ignores the ACTUAL `usage.durationMs`
 * (that was the slow-local time we're projecting AWAY from).
 */
export function effectiveCloudMs(refModel: string, usage: Pick<TokenUsage, "outputTokens">): number {
  const s = speedFor(refModel);
  return s.ttftMs + (usage.outputTokens / s.tokensPerSec) * 1000;
}
