import type { ModelBackend } from "../model.js";
import {
  type ChatCompletionsClient,
  lazyBackend,
  openAICompatBackend,
  type OpenAICompatUsage,
  type RetryOptions,
} from "./_shared.js";

/** OpenRouter's default API base. Speaks the OpenAI chat-completions protocol. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  /**
   * OpenRouter API key. For the platform-resale connection this is the
   * platform's own key; for BYOK it is the customer's. Local/self-hosted
   * endpoints never use this backend.
   */
  apiKey?: string;
  /** Override the API base. Defaults to `https://openrouter.ai/api/v1`. */
  baseURL?: string;
  /** Rate-limit retry policy (429/503). Defaults to 6 attempts, 60s fallback pause. */
  retry?: RetryOptions;
}

/**
 * Convert OpenRouter's reported dollar cost to integer micro-USD (1 USD =
 * 1_000_000), or undefined when no cost is present. This is the provider's OWN
 * settled charge for the call, frozen at response time — the fact resale billing
 * charges against (charge = cost × 1.05), distinct from the volatile
 * `referenceCost` derived from the price map.
 *
 * `usage.cost` is the authoritative total (what OpenRouter actually debited the
 * account). `cost_details.upstream_inference_cost` is the upstream provider's
 * charge and is only a fallback when the total is somehow absent — never preferred
 * over `cost` (it omits OpenRouter's own margin/fees, so billing on it would
 * under-charge). The SDK's usage type declares neither field; the raw response is
 * read defensively (the same way the streaming path reads `delta.reasoning`).
 *
 * Exported because it is the exact, auditable resale-cost conversion (rounding,
 * fallback order, drop-non-meaningful) the billing layer charges against — worth
 * referencing/asserting directly rather than re-deriving at the DB/API edge.
 */
export function openRouterCostMicroUsd(usage: OpenAICompatUsage | undefined): number | undefined {
  const usd =
    typeof usage?.cost === "number"
      ? usage.cost
      : typeof usage?.cost_details?.upstream_inference_cost === "number"
        ? usage.cost_details.upstream_inference_cost
        : undefined;
  // Round (not truncate) to the nearest micro-USD: sub-micro-dollar charges are
  // real on tiny calls, and floating-point cost values shouldn't bias the ledger
  // systematically downward. Negative/NaN are not meaningful costs → drop them.
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return undefined;
  return Math.round(usd * 1_000_000);
}

/**
 * OpenRouter backend. OpenRouter speaks the OpenAI chat-completions API, so this
 * IS the OpenAI-compatible backend (shared request shaping, tolerant parse,
 * streaming loop) plus the two things that make OpenRouter special:
 *
 *  1. It defaults `baseURL` to OpenRouter and sends `usage: { include: true }` so
 *     the response carries the settled dollar cost.
 *  2. It reads that cost (`usage.cost`, with `cost_details` as a fallback) off the
 *     RAW response into `Completion.usage.providerCostMicroUsd` — the SDK types
 *     omit it, so it's read defensively.
 *
 * `spec.model` is the concrete OpenRouter model slug (e.g. `"openai/gpt-4o-mini"`,
 * `"qwen/qwen3.5-9b"`). `spec.maxTokens` flows through as `max_tokens` so actual ≤
 * quote by construction (the inference plane sets it from the wallet reservation).
 */
export function openrouterBackend(opts: OpenRouterOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      baseURL: opts.baseURL ?? OPENROUTER_BASE_URL,
    });
    // The SDK's `create` is heavily overloaded with specific param types; the
    // factory needs only the minimal `chat.completions.create` surface, which the
    // real client satisfies at runtime. Bridge the over-specified external type to
    // that minimal surface here (the one place this file already owns the SDK).
    return openAICompatBackend(client as unknown as ChatCompletionsClient, {
      // OpenRouter only returns `usage.cost` when the request opts in.
      extraBody: { usage: { include: true } },
      costFromUsage: openRouterCostMicroUsd,
      retry: opts.retry,
    });
  });
}
