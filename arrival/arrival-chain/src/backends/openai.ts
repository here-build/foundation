import type { ModelBackend, ModelSpec } from "../model.js";
import { lazyBackend, renderSchema, specMessages } from "./_shared.js";

export interface OpenAIOptions {
  apiKey?: string;
}

/**
 * Direct OpenAI backend. `spec.model` is the concrete OpenAI model
 * name (e.g. `"gpt-4o-mini"`). Schema-mode emits a structured-output
 * response_format with the rendered JSON Schema; legacy string-marker
 * schemas fall back to `json_object`.
 */
export function openaiBackend(opts: OpenAIOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI(opts.apiKey ? { apiKey: opts.apiKey } : {});
    return {
      async complete(spec: ModelSpec): Promise<unknown> {
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
            : spec.schema !== null
              ? { response_format: { type: "json_object" as const } }
              : {}),
        });
        const text = res.choices[0]?.message?.content ?? "";
        return spec.schema !== null ? JSON.parse(text) : text;
      },
    };
  });
}
