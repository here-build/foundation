/**
 * The shared front-end for every prompt backend: parse a `.prompt` (YAML
 * frontmatter + Handlebars body) into a language-neutral IR, once. The four
 * backends (ax / langchain-js / dspy / langchain-py) each render this IR their own
 * idiomatic way — signature-first (ax, dspy) or template-first (the two LangChains).
 *
 * The IR carries BOTH shapes so a backend can pick:
 *   - `inputs` + `description`  → signature backends build a typed signature.
 *   - `messages`               → template backends reproduce the authored prompt,
 *                                 with `{{#each}}` loops surfaced as a structured
 *                                 `loop` segment (pre-rendered to a string at call
 *                                 time, since f-string templates don't iterate).
 */
import { cleanName } from "./names.js";

export interface PromptInput {
  /** Cleaned to a JS identifier (camelCase). Python backends re-clean via `pyName`. */
  name: string;
  /** The original template head, e.g. `failures` — the backend-agnostic source of truth. */
  raw: string;
  type: "string" | "json";
}

/** One chat message: a role and a flat list of literal/var/loop segments. */
export interface Message {
  role: string;
  segs: Seg[];
}

export type Seg =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string; raw: string }
  | { kind: "loop"; list: string; raw: string; item: LoopSeg[] };

/** Segments inside a `{{#each}}` body — `{{this.field}}` becomes a `field` with its path. */
export type LoopSeg = { kind: "text"; text: string } | { kind: "field"; path: string };

export interface PromptDoc {
  meta: Record<string, string>;
  model: string;
  inputs: PromptInput[];
  messages: Message[];
  /** First prose line, markers stripped — the task description for signature backends. */
  description: string;
  /** The raw body (frontmatter removed, trimmed) — preserved verbatim as a comment. */
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.replaceAll(/^["']|["']$/g, "");
  }
  return { meta, body: src.slice(m[0].length) };
}

/** Handlebars block helpers / context refs that are NOT input variables. */
const HELPERS = new Set(["role", "each", "if", "unless", "with", "this", "else", "lookup", "log"]);

/** Input fields of a body: top-level `{{var}}` (string) + `{{#each xs}}` collections (json). */
function extractInputs(body: string): PromptInput[] {
  const arrays = new Set<string>();
  for (const m of body.matchAll(/\{\{#each\s+([\w.]+)/g)) arrays.add(m[1]!.split(".")[0]!);
  const fields = new Map<string, "string" | "json">();
  for (const m of body.matchAll(/\{\{\{?\s*([\w.]+)/g)) {
    const head = m[1]!.split(".")[0]!;
    if (HELPERS.has(head)) continue;
    if (!fields.has(head)) fields.set(head, "string");
  }
  for (const a of arrays) fields.set(a, "json"); // a collection is json, overriding string
  return [...fields].map(([raw, type]) => ({ name: cleanName(raw), raw, type }));
}

/** First body line with letters once `{{…}}` markers are stripped — the natural task description. */
function firstProse(body: string): string {
  for (const line of body.split("\n")) {
    const stripped = line.replaceAll(/\{\{[\s\S]*?\}\}/g, "").trim();
    if (stripped && /[a-z]/i.test(stripped)) return stripped;
  }
  return "";
}

/** Parse a `.prompt` source into the shared IR. */
export function parsePrompt(source: string): PromptDoc {
  const { meta, body } = parseFrontmatter(source);
  const messages: Message[] = [];
  let cur: Message | null = null;
  let loop: { list: string; raw: string; item: LoopSeg[] } | null = null;
  const ensure = (): Message => (cur ??= { role: "user", segs: [] });
  const pushText = (text: string): void => {
    if (!text) return;
    if (loop) loop.item.push({ kind: "text", text });
    else ensure().segs.push({ kind: "text", text });
  };

  const re = /\{\{(\{?)\s*([\s\S]*?)\s*\}?\}\}/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(body)); ) {
    pushText(body.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = m[2]!.trim();

    if (/^role\b/.test(inner)) {
      if (cur) messages.push(cur);
      cur = { role: /["']([^"']+)["']/.exec(inner)?.[1] ?? "user", segs: [] };
    } else if (/^#each\b/.test(inner)) {
      const list = inner
        .replace(/^#each\s+/, "")
        .split(/\s+/)[0]!
        .split(".")[0]!;
      loop = { list: cleanName(list), raw: list, item: [] };
    } else if (/^\/each\b/.test(inner)) {
      if (loop) ensure().segs.push({ kind: "loop", ...loop });
      loop = null;
    } else if (loop && /^this\b/.test(inner)) {
      loop.item.push({ kind: "field", path: inner.replace(/^this\.?/, "") });
    } else if (!HELPERS.has(inner.split(/[.\s]/)[0]!)) {
      const name = inner.split(/[.\s]/)[0]!;
      if (loop) loop.item.push({ kind: "field", path: name });
      else ensure().segs.push({ kind: "var", name: cleanName(name), raw: name });
    }
  }
  pushText(body.slice(last));
  if (cur) messages.push(cur);

  return {
    meta,
    model: meta.model ?? "",
    inputs: extractInputs(body),
    messages,
    description: firstProse(body),
    body: body.trim(),
  };
}

// ── rendering helpers, shared by the template (LangChain) backends ───────────

/** A message flattened to an f-string-ready template + the loops it references. */
export interface RenderedMessage {
  role: string;
  /** Literal text (braces escaped for f-string) with `{name}` / `{loopVar}` placeholders. */
  template: string;
  loops: { var: string; raw: string; item: LoopSeg[] }[];
}

const escapeBraces = (s: string): string => s.replaceAll("{", "{{").replaceAll("}", "}}");

/** Flatten messages to f-string templates; loops collapse to a single `{loopVar}` placeholder. */
export function renderMessages(messages: Message[]): RenderedMessage[] {
  return messages.map((msg) => {
    const loops: RenderedMessage["loops"] = [];
    let template = "";
    for (const seg of msg.segs) {
      if (seg.kind === "text") template += escapeBraces(seg.text);
      else if (seg.kind === "var") template += `{${seg.name}}`;
      else {
        loops.push({ var: seg.list, raw: seg.raw, item: seg.item });
        template += `{${seg.list}}`;
      }
    }
    return { role: msg.role, template: template.replaceAll(/^\n+|\n+$/g, ""), loops };
  });
}

export const pascal = (s: string): string => cleanName(s).replace(/^[a-z]/, (c) => c.toUpperCase());
