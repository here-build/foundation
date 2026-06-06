import { jsonrepair } from "jsonrepair";
import invariant from "tiny-invariant";

import type { Completion, DeltaSink, ModelBackend, ModelSpec, NoticeSink } from "../model.js";

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

export type JsonCoercion =
  | { ok: true; value: unknown; via: "strict" | "repair" | "reasoning" }
  | { ok: false };

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
    async stream(spec: ModelSpec, onDelta: DeltaSink, signal?: AbortSignal, onNotice?: NoticeSink): Promise<Completion> {
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
  const raw = headers instanceof Headers ? headers.get("retry-after") : headers["retry-after"] ?? headers["Retry-After"];
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
  const baseMs = opts.baseMs ?? 2_000;
  const fallbackMs = opts.fallbackMs ?? 60_000;
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      if (opts.signal?.aborted || n >= max || status === undefined || !RETRYABLE_STATUS.has(status) || (opts.canRetry && !opts.canRetry())) {
        throw e;
      }
      // Retry-After (if sent) is authoritative; otherwise exponential backoff from
      // baseMs, capped at fallbackMs — progressively longer waits, never past the
      // per-minute window.
      const backoff = Math.min(fallbackMs, baseMs * 2 ** n);
      const delayMs = retryAfterMs(e) ?? backoff;
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

function tagToJsonSchema(tag: unknown): JsonSchema {
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
    case "enum":
      return { type: "string", enum: rest };
    default:
      return {};
  }
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
