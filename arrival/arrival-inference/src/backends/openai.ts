import type { ModelBackend } from "../model.js";
import { type ChatCompletionsClient, lazyBackend, openAICompatBackend, type RetryOptions } from "./_shared.js";

export interface OpenAIOptions {
  apiKey?: string;
  /**
   * Override the API base URL. Use for OpenAI-compatible endpoints —
   * notably LM Studio (`http://localhost:1234/v1`), which speaks the
   * same chat-completions API. Defaults to the OpenAI SDK's default.
   */
  baseURL?: string;
  /**
   * Per-request timeout (ms). The SDK default (~10 min) is too short for a heavy
   * consolidation/ideation call (a large prompt over a slow reasoner times out as
   * `APIConnectionTimeoutError` mid-flight). Default here is generous; the inference
   * plane's own transient-retry still wraps the call (so SDK `maxRetries` is 0 —
   * a single attempt per infer, retried by us, not double-retried by the SDK).
   */
  timeoutMs?: number;
  /**
   * Rate-limit retry policy (429/503). Defaults to 6 attempts with a 60s
   * fallback pause — tuned for OpenRouter free models (~20 rpm). Pass
   * `{ max: 0 }` to disable.
   */
  retry?: RetryOptions;
  /**
   * OpenRouter `reasoning` control, passed through verbatim on every request (not
   * part of the OpenAI API — OpenRouter and some compatible endpoints read it to
   * gate the thinking channel). The materializer use-case: a reasoning-capable model
   * must NOT think when transcribing intent into s-expressions — reasoning eats the
   * token budget into an empty content channel. `{ enabled: false }` disables thinking;
   * `{ exclude: true }` keeps it but drops it from output. Undefined → field omitted.
   */
  reasoning?: Record<string, unknown>;
  /**
   * Backend-level cap on completion tokens (`max_tokens`) — a runaway-generation
   * guard for direct callers (a weak materializer can loop, emitting one ever-growing
   * unterminated JSON string). Undefined → omitted. NB: the inference plane's per-call
   * `spec.maxTokens` reservation ceiling applies independently and is the can't-overspend
   * bound on the charging path; this is the default for direct, non-charging callers.
   */
  maxTokens?: number;
  /**
   * Sampling temperature. Undefined → omitted (endpoint default, e.g. LM Studio's 0.6).
   * A STRUCTURED task — emitting balanced s-expressions — wants this LOW (→0, greedy):
   * bracket-depth is a discrete counter with no error-cancellation, so a single off-
   * distribution token sampled at high temperature drops a bracket and derails the rest
   * of the program. Set 0 for the materializer role.
   */
  temperature?: number;
  /**
   * Injectable transport. The OpenAI SDK accepts a custom `fetch`, so a reverse-tunnel
   * (or any non-default) transport plugs in here without arrival-inference ever importing
   * `cloudflare:workers` — the adapter is built at the API layer and passed down. Undefined
   * → the SDK's own global `fetch`. This is the seam that lets a server-side agent reach a
   * user's localhost model through the per-(user,endpoint) tunnel.
   */
  fetch?: typeof fetch;
}

/**
 * Direct OpenAI backend. `spec.model` is the concrete OpenAI model
 * name (e.g. `"gpt-4o-mini"`). Schema-mode emits a structured-output
 * response_format with the rendered JSON Schema; legacy string-marker
 * schemas fall back to `json_object`.
 *
 * Works with any OpenAI-compatible endpoint via `baseURL` (LM Studio,
 * Together, vLLM, …). Local endpoints typically ignore `apiKey` but
 * the SDK still requires it to be set — pass any non-empty string.
 *
 * The request shaping (schema → system message + response_format,
 * `max_tokens`) and the tolerant parse / streaming loop live in
 * `openAICompatBackend`; this backend just constructs the client. It
 * reports token counts but no dollar cost — direct OpenAI responses
 * carry no `usage.cost`, so billing falls back to `referenceCost`. For
 * the cost-reporting sibling (OpenRouter resale), see `openrouterBackend`.
 */
export function openaiBackend(opts: OpenAIOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      timeout: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min — long enough for a heavy consolidation
      maxRetries: 0, // the inference plane retries; don't double-retry inside the SDK
    });
    // The SDK's `create` is heavily overloaded with specific param types; the
    // factory needs only the minimal `chat.completions.create` surface, which the
    // real client satisfies at runtime. Bridge the over-specified external type to
    // that minimal surface here (the one place this file already owns the SDK).
    return openAICompatBackend(client as unknown as ChatCompletionsClient, {
      retry: opts.retry,
      // Forward the OpenRouter `reasoning` gate + the backend-level `max_tokens` cap
      // through the shared core's provider-extra-fields seam (`extraBody` is spread
      // last into the request and stays out of the content cache key). The inference
      // plane's per-call `spec.maxTokens` reservation still applies independently.
      extraBody: {
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      },
    });
  });
}
