import type { ModelBackend } from "../model.js";
import {
  chatBackend,
  lazyBackend,
  mergeSystem,
  messagesToAnthropic,
  renderSchema,
  specMessages,
  textFromAnthropic,
  toolCallsFromAnthropic,
  toolsToAnthropic,
  type ChatProtocol,
  type RawAnthropicResponse,
  type RetryOptions,
} from "./_shared.js";

export interface AnthropicOptions {
  apiKey?: string;
  maxTokens?: number;
  /** Rate-limit retry policy (429/503). Defaults to 6 attempts, 60s fallback pause. */
  retry?: RetryOptions;
}

/**
 * Direct Anthropic backend — the {@link ChatProtocol} for Anthropic's Messages API,
 * the variance-of-two sibling of `openAICompatBackend`. `spec.model` is the concrete
 * Anthropic model (e.g. `"claude-sonnet-4-6"`). Anthropic differs from the OpenAI
 * protocol in three places, all confined to the protocol's seams: `system` is a
 * top-level param (not a message), there's no native json_schema flag (the shape rides
 * the system text and the reply parses through the shared coercion ladder), and the
 * tool round-trip is block-shaped (`tool_use` / `tool_result` blocks, `input` an
 * object). The completion arc — retry, tool-vs-text, usage — lives in `chatBackend`.
 *
 * Streaming is omitted in v1 (Anthropic's SSE is block-shaped, a different protocol);
 * `lazyBackend` emits the completion as a single delta for streaming consumers.
 */
export function anthropicBackend(opts: AnthropicOptions = {}): ModelBackend {
  return lazyBackend(async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    // Anthropic ALWAYS requires max_tokens. The per-call ceiling (set by the
    // inference plane from the wallet reservation) overrides this construction
    // default when present, so actual ≤ quote by construction.
    const defaultMaxTokens = opts.maxTokens ?? 4096;
    type CreateBody = Parameters<typeof client.messages.create>[0];
    const proto: ChatProtocol<RawAnthropicResponse> = {
      buildBody: (spec) => {
        const schema = renderSchema(spec.schema);
        // No native json_schema flag — embed the rendered shape in the system text and
        // recover the reply via the shared coercion ladder (in chatBackend).
        let schemaPreamble: string | undefined;
        if (spec.schema !== null) {
          const base = "Reply with valid JSON only — no prose, no fences.";
          schemaPreamble = schema ? `${base}\nShape:\n${JSON.stringify(schema, null, 2)}` : base;
        }
        // ONE top-level system, composed persona·call·format, collecting ALL system turns.
        const { systemText, messagesWithoutSystem } = mergeSystem({ messages: specMessages(spec), schemaPreamble });
        return {
          model: spec.model,
          max_tokens: spec.maxTokens ?? defaultMaxTokens,
          system: systemText,
          // messagesToAnthropic serializes the tool round-trip to Anthropic's block shape
          // (the system turns are already removed — they ride `system` above).
          messages: messagesToAnthropic(messagesWithoutSystem),
          ...(spec.tools && spec.tools.length > 0 ? { tools: toolsToAnthropic(spec.tools) } : {}),
        };
      },
      // Non-streamed body ⇒ a `Message`; cast through unknown to the structural raw
      // shape (the SDK's `Message | Stream` return isn't a member of RawAnthropicResponse).
      call: async (body) => (await client.messages.create(body as unknown as CreateBody)) as unknown as RawAnthropicResponse,
      toolCalls: (raw) => toolCallsFromAnthropic(raw.content),
      text: (raw) => textFromAnthropic(raw.content),
      // Anthropic returns usage.{input,output}_tokens — capture it (unrecoverable once
      // cached). No provider dollar cost here; billing falls back to referenceCost.
      usage: (raw) => ({ inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens }),
    };
    return chatBackend(proto, opts.retry);
  });
}
