import type { Completion, ModelBackend, ModelSpec } from "../model.js";
import { lazyBackend, renderSchema, specMessages } from "./_shared.js";

export interface OpenAIOptions {
  apiKey?: string;
  /**
   * Override the API base URL. Use for OpenAI-compatible endpoints —
   * notably LM Studio (`http://localhost:1234/v1`), which speaks the
   * same chat-completions API. Defaults to the OpenAI SDK's default.
   */
  baseURL?: string;
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
 */
export function openaiBackend(opts: OpenAIOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    return {
      async complete(spec: ModelSpec): Promise<Completion> {
        const messages = specMessages(spec);
        const schema = renderSchema(spec.schema);
        const res = await client.chat.completions.create({
          model: spec.model,
          messages,
          ...(schema
            ? {
                response_format: {
                  type: "json_schema" as const,
                  json_schema: { name: "Output", schema, strict: true },
                },
              }
            : spec.schema === null
              ? {}
              : { response_format: { type: "json_object" as const } }),
        });
        const text = res.choices[0]?.message?.content ?? "";
        const value = spec.schema === null ? text : JSON.parse(text);
        // Capture the usage the API already returns (LM Studio + OpenAI both do)
        // — the stable fact behind spent/saved/projected cost. Discarding it is
        // unrecoverable once a result is cached, so capture it on the miss.
        return {
          value,
          usage: {
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  });
}
