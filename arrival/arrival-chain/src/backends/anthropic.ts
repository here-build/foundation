import type { Completion, ModelBackend, ModelSpec } from "../model.js";
import { lazyBackend, renderSchema, specMessages, withRateLimitRetry, type RetryOptions } from "./_shared.js";

export interface AnthropicOptions {
  apiKey?: string;
  maxTokens?: number;
  /** Rate-limit retry policy (429/503). Defaults to 6 attempts, 60s fallback pause. */
  retry?: RetryOptions;
}

/**
 * Direct Anthropic backend. `spec.model` is the concrete Anthropic
 * model (e.g. `"claude-sonnet-4-6"`). Anthropic has no native
 * json_schema flag — schema-mode embeds the rendered shape in the
 * system message and parses the reply.
 */
export function anthropicBackend(opts: AnthropicOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    const maxTokens = opts.maxTokens ?? 4096;
    return {
      async complete(spec: ModelSpec): Promise<Completion> {
        const messages = specMessages(spec);
        const systemMessage = messages.find((m) => m.role === "system")?.content ?? "";
        const convo = messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        const schema = renderSchema(spec.schema);
        const wantsJson = spec.schema !== null;
        const sys = wantsJson
          ? `${systemMessage}\nReply with valid JSON only — no prose, no fences.${
              schema ? `\nShape:\n${JSON.stringify(schema, null, 2)}` : ""
            }`
          : systemMessage;
        const res = await withRateLimitRetry(
          () =>
            client.messages.create({
              model: spec.model,
              max_tokens: maxTokens,
              system: sys,
              messages: convo,
            }),
          opts.retry,
        );
        const block = res.content[0];
        const text = block?.type === "text" ? block.text : "";
        const value = wantsJson ? JSON.parse(text) : text;
        // Anthropic returns usage.{input,output}_tokens — capture it (unrecoverable
        // once cached). See the OpenAI backend + model.ts Completion.
        return {
          value,
          usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        };
      },
    };
  });
}
