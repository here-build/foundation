import invariant from "tiny-invariant";

import type { Completion, DeltaSink, ModelBackend, ModelSpec } from "../model.js";

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
    async stream(spec: ModelSpec, onDelta: DeltaSink, signal?: AbortSignal): Promise<Completion> {
      cached ??= loader();
      const backend = await cached;
      if (backend.stream) return backend.stream(spec, onDelta, signal);
      // Backend doesn't stream (a stub): emit the whole value as one delta so
      // streaming consumers still get text + the final completion.
      const completion = await backend.complete(spec);
      const text = typeof completion.value === "string" ? completion.value : JSON.stringify(completion.value);
      onDelta(text);
      return completion;
    },
  };
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
