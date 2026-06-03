import type { Completion, DeltaSink, ModelBackend, ModelSpec } from "../model.js";
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
    // The request body shared by complete + stream: messages + the
    // response_format derived from the schema slot (structured / json_object /
    // none). `text → value` parses structured output; raw text passes through.
    const requestBody = (spec: ModelSpec) => {
      const schema = renderSchema(spec.schema);
      return {
        model: spec.model,
        messages: specMessages(spec),
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
      };
    };
    const parse = (spec: ModelSpec, text: string): unknown => (spec.schema === null ? text : JSON.parse(text));

    return {
      async complete(spec: ModelSpec): Promise<Completion> {
        const res = await client.chat.completions.create(requestBody(spec));
        const text = res.choices[0]?.message?.content ?? "";
        // Capture the usage the API already returns (LM Studio + OpenAI both do)
        // — the stable fact behind spent/saved/projected cost. Discarding it is
        // unrecoverable once a result is cached, so capture it on the miss.
        return {
          value: parse(spec, text),
          usage: {
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
          },
        };
      },
      async stream(spec: ModelSpec, onDelta: DeltaSink, signal?: AbortSignal): Promise<Completion> {
        // `stream_options.include_usage` makes the provider send a final usage-only
        // chunk after the content — so streaming keeps the same cost fact `complete`
        // captures. Structured output streams as partial JSON (unparseable until the
        // close); we accumulate the raw text and parse once at the end.
        const res = await client.chat.completions.create(
          { ...requestBody(spec), stream: true, stream_options: { include_usage: true } },
          signal ? { signal } : undefined,
        );
        let text = "";
        let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
        for await (const chunk of res) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            text += delta;
            onDelta(delta);
          }
          if (chunk.usage) usage = chunk.usage;
        }
        return {
          value: parse(spec, text),
          usage: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  });
}
