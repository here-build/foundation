import invariant from "tiny-invariant";
import { streamText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Completion, ModelBackend, ModelSpec } from "../model.js";
import { coerceModelJson, renderSchema, specMessages } from "./_shared.js";

export interface VercelOptions {
  /** Which AI-SDK provider. `openai-compatible` covers LM Studio / OpenRouter / any /v1
   *  endpoint; `anthropic` is the native Messages API (Opus direct). */
  provider: "openai-compatible" | "anthropic";
  /** openai-compatible base URL (e.g. http://localhost:1234/v1, https://openrouter.ai/api/v1). */
  baseURL?: string;
  apiKey?: string;
  /** Provider name label (openai-compatible only). */
  name?: string;
  /** Default completion-token cap; per-call `spec.maxTokens` overrides. Anthropic REQUIRES one,
   *  so a default is applied there when neither is set. */
  maxTokens?: number;
  temperature?: number;
}

const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/**
 * Vercel AI-SDK backend. The reason it exists: the OpenAI/Anthropic SDKs do a NON-streaming
 * request for a one-shot completion, and undici's `headersTimeout` (5 min, un-overridable from
 * the SDK) fires while a slow provider buffers a heavy consolidation before sending headers —
 * the "Request timed out" wall. This backend uses `streamText` / `streamObject`, so headers land
 * at the FIRST token and the body streams; the timeout wall disappears by construction. It also
 * unifies LM Studio / OpenRouter / Anthropic behind one transport.
 */
export function vercelBackend(opts: VercelOptions): ModelBackend {
  const model = (modelId: string) => {
    if (opts.provider === "anthropic") {
      return createAnthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) })(modelId);
    }
    return createOpenAICompatible({
      name: opts.name ?? "local",
      baseURL: opts.baseURL ?? "http://localhost:1234/v1",
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    })(modelId);
  };

  return {
    async complete(spec: ModelSpec): Promise<Completion> {
      const schema = renderSchema(spec.schema);
      const all = specMessages(spec);

      // System turns go to the SDK's `system` option (the AI SDK warns + can reject system roles
      // inside the messages array). The schema instruction rides there too — structured output via
      // a prompt instruction + the shared coercion ladder, NOT the provider's native json-schema
      // mode (some openai-compatible models silently ignore it, returning `{}`).
      const systemParts = all.filter((m) => m.role === "system").map((m) => m.content);
      if (schema) {
        systemParts.push(`Respond with ONLY a single JSON value conforming to this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(schema)}`);
      }
      const system = systemParts.join("\n\n") || undefined;

      // FLATTEN the agentic-loop shapes the AI SDK's strict validation rejects: a `tool`-result
      // turn becomes a user turn (it's feedback the model reads next), and an assistant turn's
      // tool-calls are dropped (the text-mode scout re-emits from text, never via native tools).
      const messages = all
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content || "(no content)" })) as ModelMessage[];
      if (messages.length === 0) messages.push({ role: "user", content: system ?? "" });

      // anthropic ignores `temperature` for some models (a harmless warning); omit it there.
      const temperature = opts.provider === "anthropic" ? undefined : opts.temperature;
      const maxOutputTokens =
        spec.maxTokens ?? opts.maxTokens ?? (opts.provider === "anthropic" ? ANTHROPIC_DEFAULT_MAX_TOKENS : undefined);

      // INTER-TOKEN IDLE WATCHDOG: streaming kills the headers-timeout wall, but a stream that
      // STALLS mid-generation (a local LM Studio model that hangs after some tokens) would await
      // forever — a silent 0%-CPU wedge. Abort if no delta arrives within the idle window; the
      // for-await then throws, surfacing as a transient error that `makeInfer` re-rolls. The
      // window is generous (a slow thinking model can pause between tokens) but finite. Env:
      // ARRIVAL_INFER_IDLE_MS (default 180s).
      const idleMs = Number(process.env.ARRIVAL_INFER_IDLE_MS) || 180_000;
      const ac = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ac.abort(new Error(`infer idle ${idleMs}ms — stream stalled (aborted)`)), idleMs);
      };
      // TOTAL deadline backstop: the idle watchdog only catches a STALL — a pathologically slow but
      // never-quite-idle stream would run unbounded. A generous hard ceiling closes that gap.
      // Env: ARRIVAL_INFER_TOTAL_MS (default 15 min).
      const totalMs = Number(process.env.ARRIVAL_INFER_TOTAL_MS) || 900_000;
      const totalTimer = setTimeout(() => ac.abort(new Error(`infer total ${totalMs}ms exceeded (aborted)`)), totalMs);

      const result = streamText({
        model: model(spec.model),
        messages,
        abortSignal: ac.signal,
        ...(system !== undefined ? { system } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      });
      let text = "";
      try {
        armIdle(); // first-activity deadline
        // fullStream (NOT textStream): re-arm on ANY activity — content OR reasoning. A reasoning
        // model actively thinking emits `reasoning-delta` parts (silent on textStream), so the
        // content-only watchdog FALSE-ABORTED it mid-think (the nemotron / glm:thinking "stall").
        // Now only a TRUE stall — no part of any kind for the idle window — fires. Text accumulates
        // from `text-delta` parts only; an `error` part is re-thrown (textStream threw upstream
        // errors; fullStream surfaces them as parts — preserve the makeInfer retry path).
        for await (const part of result.fullStream) {
          armIdle();
          if (part.type === "text-delta") text += part.text;
          else if (part.type === "error") throw new Error(String(part.error));
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
      }
      const u = await result.usage;

      let value: unknown = text;
      if (schema) {
        const coerced = coerceModelJson(text, {});
        invariant(coerced.ok, () => `vercel: unparseable schema'd response (${text.slice(0, 120)})`);
        value = coerced.value;
      }
      return { value, usage: { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 } };
    },
  };
}
