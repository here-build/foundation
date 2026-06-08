import { jsonrepair } from "jsonrepair";
import invariant from "tiny-invariant";

import type { Completion, DeltaSink, ModelBackend, ModelSpec, NoticeSink, TokenUsage, ToolCall, ToolDescriptor } from "../model.js";

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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** On an assistant turn: the tool calls the model emitted (neutral shape). Each
   *  backend serializes these to its provider format. */
  toolCalls?: ToolCall[];
  /** On a `tool` turn: the id of the assistant tool call this result answers. */
  toolCallId?: string;
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
    if (o.role !== "system" && o.role !== "user" && o.role !== "assistant" && o.role !== "tool") return null;
    if (o.toolCalls !== undefined && !Array.isArray(o.toolCalls)) return null;
    if (o.toolCallId !== undefined && typeof o.toolCallId !== "string") return null;
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

/**
 * Lower neutral {@link ToolDescriptor}s into OpenAI's `tools` array (the `function`
 * shape). `parameters` is the tool's JSON-Schema `inputSchema` (already lowered via
 * the shared `tagToJsonSchema`, so it can't drift from the wire schema).
 */
export function toolsToOpenAI(tools: readonly ToolDescriptor[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      parameters: t.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
    },
  }));
}

/**
 * Serialize neutral {@link ChatMessage}s into the OpenAI chat shape, expanding the
 * tool round-trip: an assistant turn carrying `toolCalls` → `tool_calls` (arguments
 * JSON-stringified, per the OpenAI wire), and a `tool` turn → `{role:"tool",
 * tool_call_id, content}`. Plain turns pass through unchanged.
 */
export function messagesToOpenAI(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ── Anthropic serialization (the variance-of-two second backend) ──────────────
//
// Anthropic's Messages API differs from OpenAI's in three ways that matter for the
// tool round-trip: (1) `input_schema` not `parameters`, and it must be object-typed;
// (2) a tool call's arguments arrive as an OBJECT (`input`), never a JSON string;
// (3) there is no `tool` role — tool *results* are `tool_result` blocks inside a
// USER turn, and an assistant tool *call* turn carries a CONTENT-BLOCK ARRAY
// (optional text + one `tool_use` block per call). These four helpers are the
// neutral↔Anthropic mapping; the anthropic backend wires them in.

/** Lower neutral {@link ToolDescriptor}s into Anthropic's `tools` array. `input_schema`
 *  must be object-typed — default to an empty object shape when the tool takes no args. */
export function toolsToAnthropic(tools: readonly ToolDescriptor[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description === undefined ? {} : { description: t.description }),
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
  }));
}

/**
 * Serialize neutral {@link ChatMessage}s into Anthropic's `messages` array. System
 * turns are dropped (Anthropic carries `system` as a top-level param, not a message —
 * the caller extracts it). An assistant turn with `toolCalls` becomes a content-block
 * array (`text` block when non-empty, then a `tool_use` block per call, `input` passed
 * through as an object). A `tool` turn becomes a `tool_result` block in a USER message;
 * consecutive tool results (a parallel batch) merge into ONE user message, as Anthropic
 * requires the results to lead the user turn that follows the assistant tool_use.
 */
export function messagesToAnthropic(messages: readonly ChatMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (m.content !== "") blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  return out;
}

/** One block of an Anthropic response's `content` array — read permissively (the
 *  fields present depend on `type`: `text` blocks carry `text`, `tool_use` blocks
 *  carry `id`/`name`/`input`, `thinking` blocks neither). */
export interface RawAnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * Lift Anthropic's `tool_use` content blocks into neutral {@link ToolCall}s — `input`
 * is already an object, so it passes straight through (no JSON-string parse, unlike
 * OpenAI). Returns undefined when the turn carried no tool calls (a plain completion).
 */
export function toolCallsFromAnthropic(content: RawAnthropicBlock[] | null | undefined): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: ToolCall[] = [];
  for (const b of content) {
    if (b?.type === "tool_use") calls.push({ id: b.id, name: b.name ?? "", arguments: b.input ?? {} });
  }
  return calls.length > 0 ? calls : undefined;
}

/** Concatenate the `text` blocks of an Anthropic response's content array, skipping
 *  `tool_use` / `thinking` blocks — the model's prose for this turn. */
export function textFromAnthropic(content: RawAnthropicBlock[] | null | undefined): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const b of content) if (b?.type === "text" && typeof b.text === "string") text += b.text;
  return text;
}

/** The minimal shape of a non-streamed Anthropic response the backend reads: the
 *  content-block array (text + tool_use) and the token usage. Structural, so the
 *  backend casts the SDK's `Message` to it without importing the SDK type — the same
 *  pattern as {@link RawChatCompletion} for OpenAI. */
export interface RawAnthropicResponse {
  content: RawAnthropicBlock[];
  usage: { input_tokens: number; output_tokens: number };
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
  const base = specMessages(spec);
  const schemaPreamble =
    `Respond with a single JSON value conforming to this JSON Schema. ` +
    `Output only the JSON — no prose, no markdown code fences.\n${JSON.stringify(schema)}`;
  // MERGE the schema preamble into the prompt's existing leading system message rather
  // than prepending a SECOND one — `[system, system, user]` is rejected by some
  // OpenRouter providers ("system message must be at the beginning"), while a single
  // leading system message is universally accepted. Prepend a fresh one only if the
  // prompt has no leading system message.
  const messages: ChatMessage[] = !schema
    ? base
    : base.length > 0 && base[0]!.role === "system"
      ? [{ role: "system", content: `${schemaPreamble}\n\n${base[0]!.content}` }, ...base.slice(1)]
      : [{ role: "system", content: schemaPreamble }, ...base];
  return {
    model: spec.model,
    messages: messagesToOpenAI(messages),
    // Tools the model may call, lowered to OpenAI's `function` shape. Present only
    // when the spec carries them (a plain completion omits the field entirely).
    ...(spec.tools && spec.tools.length > 0 ? { tools: toolsToOpenAI(spec.tools) } : {}),
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
 * Parse a model's text into the spec'd value — provider-agnostic (OpenAI-compat AND
 * Anthropic route through it, so both get the same recovery). A schema'd call must
 * yield JSON; `coerceModelJson` recovers fenced / lightly-malformed / reasoning-channel
 * output through an ordered ladder (never repairing a length-truncated stream). When
 * even that fails, the bare `JSON.parse` error ("Unexpected end of JSON input") hides
 * WHY — so we raise a legible cause carrying the stream's shape (finish reason,
 * content length, reasoning-channel size) instead of a parser internal.
 */
export function parseModelValue(spec: ModelSpec, text: string, diag?: ParseDiag): unknown {
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
 * Lift OpenAI's raw `tool_calls` (on the response message) into neutral
 * {@link ToolCall}s, parsing each `function.arguments` JSON string into an object.
 * Returns undefined when the turn carried no tool calls (a plain completion).
 */
export function toolCallsFromOpenAI(
  message: { tool_calls?: RawOpenAIToolCall[] } | null | undefined,
): ToolCall[] | undefined {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((tc) => ({
    id: tc.id,
    name: tc.function?.name ?? "",
    arguments: parseToolArguments(tc.function?.arguments),
  }));
}

/** OpenAI tool-call arguments arrive as a JSON string; parse to an object,
 *  tolerating empty/malformed (→ `{}`). */
function parseToolArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  choices: Array<{ message?: { content?: string | null; tool_calls?: RawOpenAIToolCall[] } | null } | undefined>;
  usage?: OpenAICompatUsage;
}

/** OpenAI's raw tool_call shape on a response message — note `arguments` is a JSON
 *  STRING, not an object (lifted to an object by `toolCallsFromOpenAI`). */
interface RawOpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
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

// ── Backend driver: a protocol + the shared completion arc ────────────────────
//
// A chat backend is "a protocol + a driver". The two providers (OpenAI-compatible,
// Anthropic) differ ONLY in five seams — how a neutral spec becomes a request body,
// the client call, and how the raw response yields tool-calls / text / usage.
// Everything else (rate-limit retry, the tool-vs-text value decision, the
// `toolCalls`-when-present spread, the shared JSON coercion ladder) is identical and
// lives in `chatBackend`. So adding a backend is filling in five functions, and the
// arc logic — the part most prone to silent drift between copies — can't diverge.

/**
 * The seam between a chat provider and the shared completion arc {@link chatBackend}
 * drives. `Raw` is the provider's non-streamed response shape (structural — see
 * {@link RawChatCompletion} / {@link RawAnthropicResponse}).
 *
 * `stream` is OPTIONAL because it's genuinely divergent — OpenAI-compat streams
 * content/reasoning deltas + an include_usage chunk; Anthropic's SSE is block-shaped
 * (a different protocol, deferred in v1). A protocol supplies its own `stream` or none;
 * when absent, `lazyBackend` emits the completion as a single delta.
 */
export interface ChatProtocol<Raw> {
  /** Neutral spec → the provider's request body (messages, tools, schema, max_tokens). */
  buildBody(spec: ModelSpec): Record<string, unknown>;
  /** Issue the non-streamed call and resolve the provider's raw response. */
  call(body: Record<string, unknown>, signal?: AbortSignal): Promise<Raw>;
  /** Lift the response's tool calls into neutral {@link ToolCall}s (undefined when none). */
  toolCalls(raw: Raw): ToolCall[] | undefined;
  /** The response's prose text (the part a schema'd plain turn parses). */
  text(raw: Raw): string;
  /** The response's token usage (+ provider cost where reported). */
  usage(raw: Raw): TokenUsage;
  /** Provider-native streaming, when it has one. Omit to fall back to one-delta emit. */
  stream?: ModelBackend["stream"];
}

/**
 * Turn a {@link ChatProtocol} into a {@link ModelBackend}: the shared completion arc
 * (retry → call → tool-or-parse → usage), plus the protocol's own stream when present.
 * This is the single place the tool-vs-text decision and the coercion ladder live —
 * every backend goes through it, so OpenAI and Anthropic can't drift on the arc.
 */
export function chatBackend<Raw>(proto: ChatProtocol<Raw>, retry?: RetryOptions): ModelBackend {
  return {
    async complete(spec: ModelSpec): Promise<Completion> {
      const raw = await withRateLimitRetry(() => proto.call(proto.buildBody(spec)), retry);
      const toolCalls = proto.toolCalls(raw);
      const text = proto.text(raw);
      // A tool-calling turn returns tool calls (often with empty/no content) — do NOT
      // force a schema'd JSON parse; the agentic loop dispatches the calls and
      // re-infers. A plain turn parses through the shared coercion ladder. Usage is
      // captured even on the miss (unrecoverable once a result is cached).
      return {
        value: toolCalls ? text : parseModelValue(spec, text),
        ...(toolCalls ? { toolCalls } : {}),
        usage: proto.usage(raw),
      };
    },
    ...(proto.stream ? { stream: proto.stream } : {}),
  };
}

/**
 * The OpenAI-compatible backend: the {@link ChatProtocol} for any endpoint speaking
 * the chat-completions API. `openaiBackend` and `openrouterBackend` are both this with
 * a different client + `extraBody`/`costFromUsage` — so reasoning-channel recovery,
 * structured-output streaming accumulation, and cost capture live in ONE place.
 */
export function openAICompatBackend(
  client: ChatCompletionsClient,
  opts: OpenAICompatBackendOptions = {},
): ModelBackend {
  const { extraBody, costFromUsage, retry } = opts;
  const proto: ChatProtocol<RawChatCompletion> = {
    buildBody: (spec) => openAIRequestBody(spec, extraBody),
    // Non-streamed body ⇒ the completion branch of the client's union return.
    call: async (body) => (await client.chat.completions.create(body)) as RawChatCompletion,
    toolCalls: (raw) => toolCallsFromOpenAI(raw.choices[0]?.message),
    text: (raw) => raw.choices[0]?.message?.content ?? "",
    // Capture the usage the API already returns (LM Studio + OpenAI both do; provider
    // cost only when costFromUsage finds one) — the fact behind spent/saved/projected.
    usage: (raw) => toTokenUsage(raw.usage, costFromUsage),
    stream: async (
      spec: ModelSpec,
      onDelta: DeltaSink,
      signal?: AbortSignal,
      onNotice?: NoticeSink,
    ): Promise<Completion> => {
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
        value: parseModelValue(spec, text, { finish, reasoning }),
        usage: toTokenUsage(usage, costFromUsage),
      };
    },
  };
  return chatBackend(proto, retry);
}
