import type { Completion, DeltaSink, ModelBackend, ModelSpec, NoticeSink } from "../model.js";
import { coerceModelJson, lazyBackend, renderSchema, specMessages, withRateLimitRetry, type ChatMessage, type RetryOptions } from "./_shared.js";

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
  /**
   * OpenRouter `reasoning` control, passed through verbatim on every request.
   * Not part of the OpenAI API — OpenRouter (and some compatible endpoints)
   * read it to gate the thinking channel. The materializer use-case: a
   * reasoning-capable model (qwen3.6-flash, qwen3.5-35b-a3b are served as
   * reasoning variants) must NOT think when its job is to transcribe intent
   * into s-expressions — reasoning eats the token budget into an empty
   * content channel and "reasons its way" into a different formalism. Pass
   * `{ enabled: false }` to disable thinking entirely, or `{ exclude: true }`
   * to keep it but drop it from output. Undefined → field omitted (no change).
   */
  reasoning?: Record<string, unknown>;
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
      // Carry the shape in the PROMPT too, not only `response_format`. Endpoints that
      // don't honor `json_schema strict` (many OpenRouter providers, thinking models)
      // otherwise emit empty content or dump the answer into a reasoning channel — the
      // H1 empty-content failure. A system message describing the schema makes the
      // request robust on the FIRST try (no fallback round-trip), and it's redundant-
      // but-harmless where structured output already works. The content cache key is
      // unchanged (it keys on the schema slot, upstream of this injection).
      const messages: ChatMessage[] = schema
        ? [
            {
              role: "system",
              content:
                "Respond with a single JSON value conforming to this JSON Schema. " +
                "Output only the JSON — no prose, no markdown code fences.\n" +
                JSON.stringify(schema),
            },
            ...specMessages(spec),
          ]
        : specMessages(spec);
      return {
        model: spec.model,
        messages,
        // OpenRouter `reasoning` gate (not OpenAI API) — passed through when set.
        // The SDK's create() params don't type it, so the call sites cast.
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
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
    // Parse the model's text into the spec'd value. A schema'd call must yield JSON;
    // `coerceModelJson` recovers fenced / lightly-malformed / reasoning-channel output
    // through an ordered ladder (never repairing a length-truncated stream). When even
    // that fails, the bare `JSON.parse` error ("Unexpected end of JSON input") hides
    // WHY — so we raise a legible cause carrying the stream's shape (finish reason,
    // content length, reasoning-channel size) instead of a parser internal.
    const parse = (spec: ModelSpec, text: string, diag?: { finish?: string | null; reasoning?: string }): unknown => {
      if (spec.schema === null) return text;
      const coerced = coerceModelJson(text, diag);
      if (coerced.ok) return coerced.value;
      const ctx = `finish=${diag?.finish ?? "?"}, content=${text.length}c, reasoning=${diag?.reasoning?.length ?? 0}c`;
      const why =
        text.length === 0
          ? "streamed no content — only a reasoning channel, or the endpoint declined structured output (json_schema strict)"
          : `streamed unparseable/truncated JSON (${JSON.stringify(text.slice(0, 120))}…) — likely cut off (raise max tokens / provider truncated)`;
      throw new Error(`host: "${spec.model}" ${why} [${ctx}]`);
    };

    return {
      async complete(spec: ModelSpec): Promise<Completion> {
        const res = await withRateLimitRetry(() => client.chat.completions.create(requestBody(spec)), opts.retry);
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
      async stream(spec: ModelSpec, onDelta: DeltaSink, signal?: AbortSignal, onNotice?: NoticeSink): Promise<Completion> {
        // `stream_options.include_usage` makes the provider send a final usage-only
        // chunk after the content — so streaming keeps the same cost fact `complete`
        // captures. Structured output streams as partial JSON (unparseable until the
        // close); we accumulate the raw text and parse once at the end.
        let text = "";
        let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
        // Stream shape for diagnostics + recovery: the last finish reason and the text
        // that landed in a reasoning channel (`delta.reasoning` on OpenRouter-shaped
        // endpoints, which the SDK types don't surface — read defensively). A schema'd
        // call that emits only reasoning ends with content=""; `parse` recovers the JSON
        // from `reasoning` when it can, else fails with a legible cause rather than a
        // bare "Unexpected end of JSON input".
        let finish: string | null | undefined;
        let reasoning = "";
        // A 429 surfaces at `create`, before any token — so retry is safe as long as
        // nothing has streamed yet. `canRetry` vetoes a retry once a delta has landed
        // (a mid-stream failure must propagate, not re-emit the prefix). Each attempt
        // resets the accumulator so a retried call starts clean.
        await withRateLimitRetry(
          async () => {
            text = "";
            usage = undefined;
            finish = undefined;
            reasoning = "";
            const res = await client.chat.completions.create(
              { ...requestBody(spec), stream: true, stream_options: { include_usage: true } },
              signal ? { signal } : undefined,
            );
            for await (const chunk of res) {
              const choice = chunk.choices[0];
              const delta = choice?.delta?.content ?? "";
              if (delta) {
                text += delta;
                onDelta(delta);
              }
              const reasoningDelta = choice?.delta as { reasoning?: string; reasoning_content?: string } | undefined;
              reasoning += reasoningDelta?.reasoning ?? reasoningDelta?.reasoning_content ?? "";
              if (choice?.finish_reason) finish = choice.finish_reason;
              if (chunk.usage) usage = chunk.usage;
            }
          },
          {
            ...opts.retry,
            signal,
            canRetry: () => text === "",
            // Compose: keep the construction-level onRetry (CLI verbose log) AND
            // forward the pause to this call's notice sink (→ SSE → node liveness).
            onRetry: (info) => {
              opts.retry?.onRetry?.(info);
              onNotice?.({ kind: "rate-limited", attempt: info.attempt, delayMs: info.delayMs, status: info.status });
            },
          },
        );
        return {
          value: parse(spec, text, { finish, reasoning }),
          usage: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  });
}
