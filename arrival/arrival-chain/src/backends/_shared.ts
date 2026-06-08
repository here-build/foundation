import { jsonrepair } from "jsonrepair";
import invariant from "tiny-invariant";

import type { Completion, DeltaSink, ModelBackend, ModelSpec, NoticeSink, TokenUsage } from "../model.js";

// ── Tolerant model-JSON coercion ──────────────────────────────────────
//
// A schema'd call should return clean JSON, but real endpoints don't always
// oblige: a thinking model wraps the answer in markdown fences or emits it into a
// reasoning channel (content empty), a slow provider truncates mid-object. The
// strict `JSON.parse` turns every one of these into the same opaque "Unexpected end
// of JSON input". `coerceModelJson` recovers what's recoverable through a small,
// ORDERED ladder and reports *how* it got there (or that it couldn't) so the caller
// can fail legibly. It never repairs a length-truncated stream — that's data loss to
// surface, not a quirk to paper over (the grounding line: don't hide a silent failure).

/** Pull the outermost JSON object/array substring out of free text (a `<think>` block,
 *  a ```json fence) and repair-parse it. The final answer is typically the outermost
 *  balanced structure; returns undefined when there's nothing parseable. */
export function extractJsonObject(s: string): unknown {
  const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(jsonrepair(s.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

export type JsonCoercion = { ok: true; value: unknown; via: "strict" | "repair" | "reasoning" } | { ok: false };

/**
 * Coerce a model's raw output text into a JSON value through an ordered ladder:
 *   1. `strict`    — clean `JSON.parse` (the happy path).
 *   2. `repair`    — `jsonrepair` for fenced / trailing-comma / lightly-malformed
 *                    output, BUT skipped when `finish === "length"` (a truncated
 *                    stream is genuine data loss — surface it, don't fabricate a close).
 *   3. `reasoning` — content was empty; the answer went to the reasoning channel, so
 *                    extract the outermost JSON from it (thinking models / endpoints
 *                    that ignore structured output).
 * Returns `{ ok: false }` when nothing parses, leaving the legible error to the caller
 * (which holds the model name + diagnostics).
 */
export function coerceModelJson(text: string, diag: { finish?: string | null; reasoning?: string } = {}): JsonCoercion {
  try {
    return { ok: true, value: JSON.parse(text), via: "strict" };
  } catch {
    /* fall through */
  }
  if (text.length > 0 && diag.finish !== "length") {
    try {
      return { ok: true, value: JSON.parse(jsonrepair(text)), via: "repair" };
    } catch {
      /* fall through */
    }
  }
  if (text.length === 0 && diag.reasoning) {
    const recovered = extractJsonObject(diag.reasoning);
    if (recovered !== undefined) return { ok: true, value: recovered, via: "reasoning" };
  }
  return { ok: false };
}

/**
 * Wrap a backend behind a lazy loader. The provider SDK is imported on
 * first `complete()`/`stream()` call and cached for the rest of the process.
 */
export function lazyBackend(loader: () => Promise<ModelBackend>): ModelBackend {
  let cached: Promise<ModelBackend> | null = null;
  return {
    async complete(spec: ModelSpec): Promise<Completion> {
      cached ??= loader();
      return (await cached).complete(spec);
    },
    async stream(
      spec: ModelSpec,
      onDelta: DeltaSink,
      signal?: AbortSignal,
      onNotice?: NoticeSink,
    ): Promise<Completion> {
      cached ??= loader();
      const backend = await cached;
      if (backend.stream) return backend.stream(spec, onDelta, signal, onNotice);
      // Backend doesn't stream (a stub): emit the whole value as one delta so
      // streaming consumers still get text + the final completion.
      const completion = await backend.complete(spec);
      const text = typeof completion.value === "string" ? completion.value : JSON.stringify(completion.value);
      onDelta(text);
      return completion;
    },
  };
}

// ── Rate-limit retry (shared across backends) ─────────────────────────

/**
 * Abortable sleep. Resolves after `ms`, or rejects with an AbortError the
 * moment `signal` fires — so a cancelled inference stops waiting out a
 * rate-limit pause instead of hanging for the full delay.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** Max retry attempts on a retryable status (429/503). Default 6. */
  max?: number;
  /**
   * First pause (ms) when the provider sends no Retry-After header. Each
   * subsequent retry doubles this, capped at `fallbackMs`. Default 2_000 —
   * start short (a one-off spike often clears fast), grow toward the window.
   */
  baseMs?: number;
  /**
   * Cap (ms) on a single backoff pause. Default 60_000 — the per-minute window
   * of free rate-limited tiers (OpenRouter free models cap ≈20 rpm and rarely
   * send Retry-After). A Retry-After header always overrides the backoff.
   */
  fallbackMs?: number;
  /**
   * Called just before each rate-limit pause, so callers can surface the wait
   * on a debug channel. `attempt` is 1-based. The default surface stays silent —
   * rate limiting is plumbing; the slowness folds into the call's elapsed time.
   */
  onRetry?: (info: { attempt: number; delayMs: number; status: number }) => void;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 503]);

/** Pull a delay (ms) from an SDK error's Retry-After header — accepts either
 *  a seconds count or an HTTP-date. Returns null when absent/unparseable. */
function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: Headers | Record<string, string> } | undefined)?.headers;
  if (!headers) return null;
  const raw =
    headers instanceof Headers ? headers.get("retry-after") : (headers["retry-after"] ?? headers["Retry-After"]);
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Retry a model call when the provider rate-limits us (HTTP 429) or is
 * briefly unavailable (503). Honors a Retry-After header; otherwise pauses
 * `fallbackMs` (default 60s). The pause is abortable via `signal`. `canRetry`
 * lets a streaming attempt veto a retry once it has already emitted text, so a
 * partially-streamed completion is never re-emitted from scratch.
 */
export async function withRateLimitRetry<T>(
  attempt: () => Promise<T>,
  opts: RetryOptions & { signal?: AbortSignal; canRetry?: () => boolean } = {},
): Promise<T> {
  const max = opts.max ?? 6;
  const baseMs = opts.baseMs ?? 2000;
  const fallbackMs = opts.fallbackMs ?? 60_000;
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status;
      if (
        opts.signal?.aborted ||
        n >= max ||
        status === undefined ||
        !RETRYABLE_STATUS.has(status) ||
        (opts.canRetry && !opts.canRetry())
      ) {
        throw error;
      }
      // Retry-After (if sent) is authoritative; otherwise exponential backoff from
      // baseMs, capped at fallbackMs — progressively longer waits, never past the
      // per-minute window.
      const backoff = Math.min(fallbackMs, baseMs * 2 ** n);
      const delayMs = retryAfterMs(error) ?? backoff;
      opts.onRetry?.({ attempt: n + 1, delayMs, status });
      await sleep(delayMs, opts.signal);
    }
  }
}

// ── Spec helpers (shared across backends) ─────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * If `prompt` is the canonical chat-shape JSON (an array of `{role,
 * content}`), return the parsed messages. Otherwise return null —
 * backends fall back to a single-user-message build.
 */
export function parseChatPrompt(prompt: string): ChatMessage[] | null {
  if (prompt.length === 0 || prompt[0] !== "[") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const m of parsed) {
    if (!m || typeof m !== "object") return null;
    const o = m as Record<string, unknown>;
    if (typeof o.role !== "string" || typeof o.content !== "string") return null;
    if (o.role !== "system" && o.role !== "user" && o.role !== "assistant") return null;
  }
  return parsed as ChatMessage[];
}

export type JsonSchema = Record<string, unknown>;

/**
 * Convert the schema DSL's canonical JSON form (a tagged list) into
 * a JSON Schema object suitable for OpenAI structured outputs etc.
 * Returns null if the schema slot is a legacy non-structured string.
 */
export function renderSchema(schemaSlot: string | null): JsonSchema | null {
  if (!schemaSlot) return null;
  let tag: unknown;
  try {
    tag = JSON.parse(schemaSlot);
  } catch {
    return null; // legacy string marker
  }
  return tagToJsonSchema(tag);
}

/**
 * The SINGLE lowering from the schema DSL's tagged-list form to JSON Schema.
 * Everything that needs a schema — OpenAI/Anthropic structured outputs *and*
 * the zod validator (`schemaToZod`) — routes through this one recursion, so the
 * wire schema and the runtime validator can never drift.
 *
 * Exported (not private) precisely so `schemaToZod` is a thin wrapper over this
 * output rather than a second recursion over the tag.
 */
export function tagToJsonSchema(tag: unknown): JsonSchema {
  if (typeof tag === "string") return { type: tag };
  if (!Array.isArray(tag) || tag.length === 0) return {};
  const [kind, ...rest] = tag as [string, ...unknown[]];
  switch (kind) {
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of rest) {
        invariant(
          Array.isArray(field) && (field.length === 2 || field.length === 3),
          "schema/object: field must be (name type) or (name type description)",
        );
        const [name, type, description] = field as [string, unknown, string?];
        const schema = tagToJsonSchema(type);
        if (description) schema.description = description;
        properties[name] = schema;
        required.push(name);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "array":
      return { type: "array", items: tagToJsonSchema(rest[0]) };
    case "enum": {
      // Derive the JSON Schema `type` from the values rather than hardcoding
      // "string": a numeric enum with `type:"string"` is internally inconsistent
      // (the wire schema OpenAI/Anthropic receive contradicts itself, and a
      // spec-conformant validator rejects it). All-strings ⇒ "string" (the common
      // case, unchanged); all-integers ⇒ "integer"; any non-integer number ⇒
      // "number"; a mixed-kind enum drops `type` entirely (no single JSON Schema
      // type describes it — the `enum` constraint alone carries the meaning).
      const type = enumValuesType(rest);
      return type === undefined ? { enum: rest } : { type, enum: rest };
    }
    default:
      return {};
  }
}

/** JSON Schema `type` for an enum's literal values, or undefined when mixed. */
function enumValuesType(values: readonly unknown[]): "string" | "number" | "integer" | undefined {
  if (values.length > 0 && values.every((v) => typeof v === "string")) return "string";
  if (values.length > 0 && values.every((v) => typeof v === "number")) {
    return values.every((v) => Number.isInteger(v)) ? "integer" : "number";
  }
  return undefined; // empty or mixed: let `enum` alone constrain (no contradictory `type`)
}

/**
 * Build a messages array for the backend regardless of whether the
 * spec's prompt is chat-shaped or a plain user prompt. The system
 * message is the program author's concern — if the program wants one,
 * it includes (infer/chat/system "…") in its message list.
 */
export function specMessages(spec: ModelSpec): ChatMessage[] {
  const parsed = parseChatPrompt(spec.prompt);
  if (parsed) return parsed;
  return [{ role: "user", content: spec.prompt }];
}

// ── OpenAI-compatible request/parse core (shared by openai + openrouter) ───────
//
// OpenRouter, LM Studio, Together, vLLM, … all speak the OpenAI chat-completions
// API. The request shaping (schema → system-message + response_format, the
// max_tokens execution bound) and the tolerant text→value parse are byte-for-byte
// identical across them — only the credential/baseURL and any provider-specific
// extra body (OpenRouter's `usage:{include:true}` cost opt-in) differ. These three
// helpers are that shared core, so the OpenAI backend and the OpenRouter backend
// can't drift: a fix to the coercion ladder or the schema injection lands once.

/**
 * The chat-completions request body for a spec: messages (with a schema-carrying
 * system message when the spec is schema'd), the `response_format`
 * (json_schema-strict / json_object / none), and `max_tokens` when the spec
 * carries one. `extra` is spread last for provider-specific fields (OpenRouter's
 * `usage:{include:true}`) — it never participates in the content cache key.
 *
 * The schema is carried in the PROMPT too, not only `response_format`: endpoints
 * that don't honor `json_schema strict` (many OpenRouter providers, thinking
 * models) otherwise emit empty content or dump the answer into a reasoning channel
 * (the H1 empty-content failure). A system message describing the shape makes the
 * request robust on the FIRST try, redundant-but-harmless where structured output
 * already works. The content cache key is unchanged (it keys on the schema slot,
 * upstream of this injection).
 */
export function openAIRequestBody(spec: ModelSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = renderSchema(spec.schema);
  const messages: ChatMessage[] = schema
    ? [
        {
          role: "system",
          content:
            `Respond with a single JSON value conforming to this JSON Schema. ` +
            `Output only the JSON — no prose, no markdown code fences.\n${JSON.stringify(schema)}`,
        },
        ...specMessages(spec),
      ]
    : specMessages(spec);
  return {
    model: spec.model,
    messages,
    // The reservation's spend ceiling, when the inference plane set one. Caps
    // completion tokens so actual ≤ quote by construction; absent for unbounded
    // (ROI-only) calls. Not part of the cache key (an execution bound, not
    // content) — see ModelSpec.maxTokens.
    ...(spec.maxTokens === undefined ? {} : { max_tokens: spec.maxTokens }),
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
    ...extra,
  };
}

/** Diagnostics carried alongside a model's raw text for legible failure: the
 *  finish reason and any text that landed in a reasoning channel. */
export interface ParseDiag {
  finish?: string | null;
  reasoning?: string;
}

/**
 * Parse a model's text into the spec'd value. A schema'd call must yield JSON;
 * `coerceModelJson` recovers fenced / lightly-malformed / reasoning-channel output
 * through an ordered ladder (never repairing a length-truncated stream). When even
 * that fails, the bare `JSON.parse` error ("Unexpected end of JSON input") hides
 * WHY — so we raise a legible cause carrying the stream's shape (finish reason,
 * content length, reasoning-channel size) instead of a parser internal.
 */
export function parseOpenAICompletion(spec: ModelSpec, text: string, diag?: ParseDiag): unknown {
  if (spec.schema === null) return text;
  const coerced = coerceModelJson(text, diag);
  if (coerced.ok) return coerced.value;
  const ctx = `finish=${diag?.finish ?? "?"}, content=${text.length}c, reasoning=${diag?.reasoning?.length ?? 0}c`;
  const why =
    text.length === 0
      ? "streamed no content — only a reasoning channel, or the endpoint declined structured output (json_schema strict)"
      : `streamed unparseable/truncated JSON (${JSON.stringify(text.slice(0, 120))}…) — likely cut off (raise max tokens / provider truncated)`;
  throw new Error(`host: "${spec.model}" ${why} [${ctx}]`);
}

/**
 * The raw `usage` an OpenAI-compatible response carries. The token counts are
 * standard; `cost` / `cost_details` are OpenRouter extensions the OpenAI SDK type
 * does NOT declare — read defensively (the SDK narrows them away, exactly as it
 * does `delta.reasoning`). `cost` is total USD as a float; `upstream_inference_cost`
 * is the provider's own upstream charge (also USD) when reported.
 */
export interface OpenAICompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  cost_details?: { upstream_inference_cost?: number | null } | null;
}

/**
 * Extracts the provider's settled dollar charge (micro-USD) from a raw usage
 * object, or undefined when the provider doesn't report one. A backend that
 * surfaces cost (OpenRouter) passes this; one that doesn't (direct OpenAI) omits
 * it, leaving `providerCostMicroUsd` absent so billing falls back to referenceCost.
 */
export type CostFromUsage = (usage: OpenAICompatUsage | undefined) => number | undefined;

/** Build a `TokenUsage` from a raw OpenAI-compatible usage object, attaching the
 *  provider cost (micro-USD) only when `costFromUsage` yields one. */
function toTokenUsage(usage: OpenAICompatUsage | undefined, costFromUsage?: CostFromUsage): TokenUsage {
  const cost = costFromUsage?.(usage);
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(cost === undefined ? {} : { providerCostMicroUsd: cost }),
  };
}

/** The minimal shape of a non-streamed chat-completions response this factory
 *  reads: the first choice's text plus the (possibly cost-bearing) usage. */
interface RawChatCompletion {
  choices: Array<{ message?: { content?: string | null } | null } | undefined>;
  usage?: OpenAICompatUsage;
}
/** The minimal shape of one streamed chunk: a content/reasoning delta + finish
 *  reason on the choice, and the usage-only final chunk (`include_usage`). */
interface RawChatChunk {
  choices: Array<
    | {
        delta?: { content?: string | null; reasoning?: string; reasoning_content?: string } | null;
        finish_reason?: string | null;
      }
    | undefined
  >;
  usage?: OpenAICompatUsage;
}

/** The minimal OpenAI-client surface this factory uses. Kept structural so the
 *  factory never imports the SDK — each backend constructs its own typed client
 *  and hands it in, keeping the SDK import lazy and per-backend. A single permissive
 *  call signature (rather than overloads) so a real `OpenAI` instance — whose
 *  `create` is heavily overloaded — is structurally assignable without a cast at the
 *  backend; the two response shapes are narrowed inside the factory by call site
 *  (non-streamed body ⇒ completion, `stream:true` ⇒ chunk iterable). */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<RawChatCompletion | AsyncIterable<RawChatChunk>>;
    };
  };
}

export interface OpenAICompatBackendOptions {
  /** Extra request-body fields merged into every call (e.g. OpenRouter's
   *  `usage:{include:true}` cost opt-in). Never part of the cache key. */
  extraBody?: Record<string, unknown>;
  /** Pulls the provider's settled dollar cost (micro-USD) out of the raw usage,
   *  when the provider reports one. Omit for backends with no dollar cost. */
  costFromUsage?: CostFromUsage;
  retry?: RetryOptions;
}

/**
 * The shared complete + stream loop for any OpenAI-compatible chat endpoint.
 * `openaiBackend` and `openrouterBackend` are both this loop with a different
 * client + `extraBody`/`costFromUsage` — so the rate-limit retry, reasoning-channel
 * recovery, structured-output streaming accumulation, and cost capture live in ONE
 * place and the two backends cannot drift.
 */
export function openAICompatBackend(
  client: ChatCompletionsClient,
  opts: OpenAICompatBackendOptions = {},
): ModelBackend {
  const { extraBody, costFromUsage, retry } = opts;
  return {
    async complete(spec: ModelSpec): Promise<Completion> {
      // Non-streamed body ⇒ the completion branch of the client's union return.
      const res = (await withRateLimitRetry(
        () => client.chat.completions.create(openAIRequestBody(spec, extraBody)),
        retry,
      )) as RawChatCompletion;
      const text = res.choices[0]?.message?.content ?? "";
      // Capture the usage the API already returns (LM Studio + OpenAI both do; the
      // provider cost only when costFromUsage finds one) — the stable fact behind
      // spent/saved/projected cost. Discarding it is unrecoverable once a result is
      // cached, so capture it on the miss.
      return {
        value: parseOpenAICompletion(spec, text),
        usage: toTokenUsage(res.usage, costFromUsage),
      };
    },
    async stream(
      spec: ModelSpec,
      onDelta: DeltaSink,
      signal?: AbortSignal,
      onNotice?: NoticeSink,
    ): Promise<Completion> {
      // `stream_options.include_usage` makes the provider send a final usage-only
      // chunk after the content — so streaming keeps the same cost fact `complete`
      // captures. Structured output streams as partial JSON (unparseable until the
      // close); we accumulate the raw text and parse once at the end.
      let text = "";
      let usage: OpenAICompatUsage | undefined;
      // Stream shape for diagnostics + recovery: the last finish reason and the text
      // that landed in a reasoning channel (`delta.reasoning` on OpenRouter-shaped
      // endpoints, which the SDK types don't surface — read defensively). A schema'd
      // call that emits only reasoning ends with content=""; parse recovers the JSON
      // from `reasoning` when it can, else fails with a legible cause.
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
          // `stream:true` body ⇒ the async-iterable branch of the union return.
          const res = (await client.chat.completions.create(
            { ...openAIRequestBody(spec, extraBody), stream: true, stream_options: { include_usage: true } },
            signal ? { signal } : undefined,
          )) as AsyncIterable<RawChatChunk>;
          for await (const chunk of res) {
            const choice = chunk.choices[0];
            const delta = choice?.delta?.content ?? "";
            if (delta) {
              text += delta;
              onDelta(delta);
            }
            // `reasoning` / `reasoning_content` are OpenRouter-shaped reasoning-channel
            // fields the SDK type doesn't surface — present on RawChatChunk's delta.
            reasoning += choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? "";
            if (choice?.finish_reason) finish = choice.finish_reason;
            if (chunk.usage) usage = chunk.usage;
          }
        },
        {
          ...retry,
          signal,
          canRetry: () => text === "",
          // Compose: keep the construction-level onRetry (CLI verbose log) AND
          // forward the pause to this call's notice sink (→ SSE → node liveness).
          onRetry: (info) => {
            retry?.onRetry?.(info);
            onNotice?.({ kind: "rate-limited", attempt: info.attempt, delayMs: info.delayMs, status: info.status });
          },
        },
      );
      return {
        value: parseOpenAICompletion(spec, text, { finish, reasoning }),
        usage: toTokenUsage(usage, costFromUsage),
      };
    },
  };
}
