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
   * Rate-limit retry policy (429/503). Defaults to 6 attempts with a 60s
   * fallback pause — tuned for OpenRouter free models (~20 rpm). Pass
   * `{ max: 0 }` to disable.
   */
  retry?: RetryOptions;
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
    });
    // The SDK's `create` is heavily overloaded with specific param types; the
    // factory needs only the minimal `chat.completions.create` surface, which the
    // real client satisfies at runtime. Bridge the over-specified external type to
    // that minimal surface here (the one place this file already owns the SDK).
    return openAICompatBackend(client as unknown as ChatCompletionsClient, { retry: opts.retry });
  });
}
