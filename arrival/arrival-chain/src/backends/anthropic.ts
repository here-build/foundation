import type { ModelBackend, ModelSpec } from "../model.js";
import { lazyBackend, renderSchema, specMessages } from "./_shared.js";

export interface AnthropicOptions {
  apiKey?: string;
  maxTokens?: number;
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
      async complete(spec: ModelSpec): Promise<unknown> {
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
        const res = await client.messages.create({
          model: spec.model,
          max_tokens: maxTokens,
          system: sys,
          messages: convo,
        });
        const block = res.content[0];
        const text = block && block.type === "text" ? block.text : "";
        return wantsJson ? JSON.parse(text) : text;
      },
    };
  });
}
