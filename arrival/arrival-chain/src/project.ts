import "@here.build/plexus/mobx/register";
import {
  createRosettaWrapper,
  execGeneratorFromString as exec,
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  sandboxedEnv,
  lipsToJs,
  Nil,
} from "@here.build/arrival-scheme";
import { docPlexus, PlexusModel, syncing } from "@here.build/plexus";
import Handlebars from "handlebars";
import invariant from "tiny-invariant";

import {
  type DataEffectResolver,
  type DataEffectResult,
  defineDataEffectRosettas,
  inertDataResolver,
} from "./data-effects.js";
import {
  defineMcpRosettas,
  dispatchThroughChain,
  inertMcpResolver,
  isMcpBreak,
  isMcpServerValue,
  MCP_BREAK,
  type McpEffectContext,
  type McpEffectResolver,
  McpServerValue,
  resolveTools,
  wrapMcpResolver,
} from "./mcp-effects.js";
import { runAgenticLoop } from "./agentic-loop.js";
import type { ChatMessage } from "./backends/_shared.js";
import { Draft } from "./draft.js";
import { DataBinding, dataEffectKey, type EffectLog, inferEffectKey, stableJson } from "./effect-log.js";
import { defineExposeRosetta, type OnExpose } from "./expose.js";
import { InferBinding, type InferStoreLike } from "./infer-store.js";
import { InferString } from "./infer-string.js";
import type { Completion, ToolCall, ToolDescriptor } from "./model.js";
import { RunSpend } from "./run-spend.js";
import { Program, ProgramVersion } from "./program.js";
import { formatRunError, Hypothesis, Run, RunError, RunResult } from "./run.js";
import {
  defineImportRosetta,
  defineRequireRosetta,
  loaderFromResolver,
  makeProjectLoader,
  type Loader,
  type PromptUnit,
  type RequireResolver,
} from "./loader.js";
import { analyzeTemplate, coerceShape, type TemplateInfo, validateShape } from "./template-analyze.js";
import type { EvalTrace } from "./trace.js";

// The brand arrival-scheme tags keyword-accessor pluck functions with (see
// Environment.ts). Read via the same registered symbol so it matches across the
// package boundary — an explicit check, not a valueOf/string-shape heuristic.
const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

/**
 * Resolve a `dict` key. A keyword key (e.g. `:tagline`) evaluates to a branded
 * pluck function carrying its bare field name; use that so `(dict :tagline v)`
 * is symmetric with `(:tagline obj)` access (and templates `{{tagline}}` still
 * resolve). Plain string keys pass through unchanged.
 */
function dictKey(k: unknown): string {
  if (typeof k === "function") {
    const field = (k as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(k);
}

/** Fold alternating key/value call args into a dict — the `dict` rosetta body,
 *  reused by the `.prompt` proc to build its `:k v …` kwargs dict at JS level
 *  (so `(run-x key :k v)` folds exactly as the old `(apply dict kv)` did). */
function buildDict(args: unknown[]): Record<string, unknown> {
  invariant(args.length % 2 === 0, "dict: needs an even number of args (alternating keys/values)");
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) out[dictKey(args[i])] = args[i + 1];
  return out;
}

/** Field → producing-point ids, folded in lockstep with `buildDict` over the same
 *  `:k v …` kv list. `kvProv` is the rosetta's `ctx.argProvenance` aligned to `kv`
 *  (the per-arg DEEP provenance — element origins, not the empty list spine), so
 *  `inputsProvenance[field]` is the set of points whose value landed in that slot.
 *  This is what lets a value PACKED INTO A LIST keep its per-field attribution:
 *  the field carries the union of its elements' origins, not one collapsed value. */
function buildInputsProvenance(kv: unknown[], kvProv: readonly ReadonlySet<number>[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (let i = 0; i < kv.length; i += 2) out[dictKey(kv[i])] = [...(kvProv[i + 1] ?? [])];
  return out;
}

/** Canonicalise a `(role content)` message list to the single prompt string used
 *  as a task's content key (the cache/dedup identity). Shared by `infer/chat` and
 *  the `.prompt` proc, so both mint IDENTICAL task keys for the same messages —
 *  the property that keeps a `.prompt` run replayable against the same cache. */
function canonicalizeMessages(messages: unknown): string {
  invariant(Array.isArray(messages), "infer/chat: messages must be a list");
  return JSON.stringify(
    messages.map((m) => {
      invariant(Array.isArray(m) && m.length === 2, "infer/chat: each message must be (role content)");
      return { role: String(m[0]), content: String(m[1]) };
    }),
  );
}

/** Parse a scheme `(role content)` message list into neutral {@link ChatMessage}s — the
 *  SEED for `infer/agentic/end-to-end`'s loop. The user supplies plain user/system/
 *  assistant turns; the loop appends the rich (toolCalls / tool-result) turns itself, and
 *  each round re-serialises the growing list via `JSON.stringify` (the same wire form
 *  `parseChatPrompt` reads back), so per-turn cache keys stay stable. */
function parseSchemeChatMessages(messages: unknown): ChatMessage[] {
  invariant(Array.isArray(messages), "infer/agentic/end-to-end: messages must be a list");
  return messages.map((m) => {
    invariant(Array.isArray(m) && m.length === 2, "infer/agentic/end-to-end: each message must be (role content)");
    return { role: String(m[0]) as ChatMessage["role"], content: String(m[1]) };
  });
}

/**
 * Execution circuit-breaker, threaded into `exec`/`execExpr` and checked at the
 * evaluator's TICK boundary (≈ every 1000 iterations or 5ms). It bounds runaway
 * recursion AND runaway macro expansion alike (the expander rides the same TICK)
 * — which is what makes enabling user `syntax-rules` safe: a macro adds no new
 * threat class beyond the infinite recursion any program could already write,
 * and the same breaker caps both.
 *
 * The two fields are NOT interchangeable:
 *   budgetMs — a SYNCHRONOUS wall-clock deadline (`performance.now() > deadline`)
 *              checked at the TICK. Because it needs no event loop, it cuts even a
 *              pure-CPU runaway (tight loop, expansion bomb) when the loop never
 *              breathes. THIS is the breaker for runaway CPU. Opt-in: the deadline
 *              counts IO too, and an LLM-bound program spends most of its
 *              wall-clock awaiting inference, so there's no sane global default —
 *              the caller who knows the workload sets it.
 *   signal   — cooperative cancellation, observed at the TICK abort-check. Lands
 *              at IO/await boundaries (e.g. between infer calls) and as a
 *              pre-aborted fast-fail. It does NOT preempt a pure-CPU spin: the
 *              TICK yield is a microtask (`await Promise.resolve()`), which starves
 *              the macrotask timer queue, so a timer-based abort can't fire
 *              mid-spin. For runaway CPU, reach for budgetMs.
 */
export interface ExecBudget {
  signal?: AbortSignal;
  budgetMs?: number;
}

// Cache compiled+analyzed templates by source string. Templates are pure
// functions of their source; safe to share across runs and projects.
interface CompiledTemplate {
  render: HandlebarsTemplateDelegate;
  info: TemplateInfo;
}
const TEMPLATE_CACHE = new Map<string, CompiledTemplate>();

function compileTemplate(source: string): CompiledTemplate {
  let tm = TEMPLATE_CACHE.get(source);
  if (!tm) {
    tm = {
      render: Handlebars.compile(source, { noEscape: true }),
      info: analyzeTemplate(source),
    };
    TEMPLATE_CACHE.set(source, tm);
  }
  return tm;
}

/** Per root-slot, the subfields a template actually reads — the static truth for
 *  granular field-to-field wiring. `{ ideas: ["idea"] }` for a digest that reads only
 *  `this.idea` off each element though `spark` also produced `energy`. An empty list =
 *  whole-value use (`{{topic}}`, `{{this}}`) → a box wire; a proper subset of the
 *  producer's record = per-field wires, the unread fields left out. Unioned across a
 *  chat template's role sections.
 *
 *  Walks the Handlebars AST itself rather than reusing the validation `Shape`, whose
 *  `#each` element collapses to `any` (its `addPath` can't upgrade an array element to
 *  an object in place — fine for validation, lossy for our field set). A scope stack
 *  tracks the slot a `#each`/`#with` body is iterating, so `{{this.idea}}` inside
 *  `{{#each ideas}}` attributes `idea` to `ideas`. */
function templateReads(sections: { source: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (slot: string, field: string | null): void => {
    const acc = (out[slot] ??= []);
    if (field !== null && !acc.includes(field)) acc.push(field);
  };
  const BLOCK_HELPERS = new Set(["if", "unless", "each", "with"]);
  // A scope is the slot a body iterates (`each`/`with`), or null at the root dict.
  const walk = (nodes: HbsNode[], scope: string | null): void => {
    for (const n of nodes) {
      if (n.type === "MustacheStatement" || n.type === "SubExpression") {
        const parts = pathOf(n.path);
        if (scope === null) {
          // `{{a.b}}` reads b off a; `{{a}}` is whole-a; `{{this…}}` at root is noise.
          if (parts.length >= 2) add(parts[0]!, parts[1]!);
          else if (parts.length === 1) add(parts[0]!, null);
        } else {
          // Inside `#each ideas`: `{{this.idea}}`/`{{idea}}` → ideas reads `idea`;
          // `{{this}}` (no parts) → whole element use.
          add(scope, parts.length >= 1 ? parts[0]! : null);
        }
        // helper arguments are read too
        for (const p of (n.params as HbsNode[] | undefined) ?? []) walk([p], scope);
      } else if (n.type === "BlockStatement") {
        const helper = pathOf(n.path)[0];
        const arg = pathOf((n.params as HbsNode[] | undefined)?.[0]);
        const inner = helper && BLOCK_HELPERS.has(helper) && arg.length > 0 ? arg[0]! : scope;
        if (helper === "each" || helper === "with") {
          if (arg.length > 0) add(arg[0]!, null); // the slot itself is referenced
          walk(((n.program as HbsNode | undefined)?.body as HbsNode[] | undefined) ?? [], inner);
        } else {
          // `if`/`unless`: body stays in the outer scope.
          if (arg.length > 0) add(scope ?? arg[0]!, scope ? arg[0]! : null);
          walk(((n.program as HbsNode | undefined)?.body as HbsNode[] | undefined) ?? [], scope);
        }
        walk(((n.inverse as HbsNode | undefined)?.body as HbsNode[] | undefined) ?? [], scope);
      }
    }
  };
  for (const s of sections) {
    const ast = Handlebars.parse(s.source) as unknown as { body: HbsNode[] };
    walk(ast.body, null);
  }
  return out;
}

type HbsNode = { type: string; path?: unknown; params?: unknown; program?: unknown; inverse?: unknown; body?: unknown };

/** PathExpression `parts` (`this.idea` → `["idea"]`, `this` → `[]`), or `[]` for
 *  non-paths (literals, etc.). `this`/`@`-prefixed segments are already stripped by
 *  Handlebars into `parts`. */
function pathOf(node: unknown): string[] {
  const n = node as { type?: string; parts?: unknown } | undefined;
  if (!n || n.type !== "PathExpression") return [];
  return Array.isArray(n.parts) ? (n.parts as string[]) : [];
}

const isPrimitiveLike = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  Array.isArray(v) ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean";

const isDictLike = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Build the input dict from a list of call-site args, per the three modes:
 *
 *   1. (template dict)       — dict-like single arg: pass through (validated)
 *   2. (template primitive)  — primitive single arg + single-var template:
 *                              wrap as `{<singleVarName>: arg}`
 *   3. (template k1 v1 k2 v2 …) — even args, every even index is a string
 *                                 matching a template root field: build dict
 *
 * Anything else throws with a structured message.
 */
function resolveTemplateInput(args: unknown[], info: TemplateInfo): Record<string, unknown> {
  if (args.length === 0) {
    throw new Error("template: expected at least one argument");
  }
  if (args.length === 1) {
    const a = args[0];
    if (isDictLike(a)) return a;
    if (isPrimitiveLike(a)) {
      if (!info.singleVarName) {
        throw new Error(
          `template: single primitive arg passed to a template with ${info.rootFields.length} fields ` +
            `(${info.rootFields.join(", ")}); either pass a dict, or use alternating keyword/value args`,
        );
      }
      return { [info.singleVarName]: a };
    }
    throw new Error(`template: unsupported single-arg type ${typeName(a)}`);
  }
  // Multi-arg: alternating string-key / value pairs.
  if (args.length % 2 !== 0) {
    throw new Error(`template: expected even number of args (alternating key/value), got ${args.length}`);
  }
  const fieldSet = new Set(info.rootFields);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (typeof k !== "string") {
      throw new TypeError(`template: key at position ${i} is not a string (got ${typeName(k)})`);
    }
    if (info.rootFields.length > 0 && !fieldSet.has(k)) {
      throw new Error(`template: unknown field "${k}"; template root fields are: ${info.rootFields.join(", ")}`);
    }
    out[k] = args[i + 1];
  }
  return out;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Single-entry rosetta the require-expansion calls. Takes the template
 * source and the rest-list of call-site args, dispatches to one of the three
 * call modes, validates, and renders.
 */
/** Nil-like for the array→`[]` failsafe: a scheme empty-list crosses the rosetta
 *  membrane as `nil` (`instanceof Nil` also catches provenance-bearing clones),
 *  plus JS null/undefined for an absent field. */
const isNilLike = (v: unknown): boolean => v == null || v instanceof Nil;

function renderTemplateCall(source: string, args: unknown[]): string {
  const tm = compileTemplate(source);
  // Coerce array-shaped fields that arrived nil (empty scheme list) to `[]` before
  // validating, so `{{#each}}` over an empty collection renders nothing rather than
  // tripping the array check — the cross-lang membrane can't make an empty list a
  // JS array on its own (see coerceShape).
  const data = coerceShape(tm.info.shape, resolveTemplateInput(args, tm.info), isNilLike);
  const ok = validateShape(tm.info.shape, data);
  if (!ok.ok) {
    throw new Error(`template input mismatch: ${ok.message}`);
  }
  return tm.render(data);
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

/** Coerce a scheme value to a nullable scalar string (false/null/undefined → null). */
const nullable = (v: unknown): string | null => (v === undefined || v === false || v === null ? null : String(v));

/** A `(dict …)` folds to a plain JS record; the `:meta` config slot must be one. */
const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Canonicalise a schema arg (string marker | tagged-list DSL | nothing) to the
 *  single string used as the schema slot of a task's content key. */
const schemaSlot = (v: unknown): string | null => {
  if (v === undefined || v === false || v === null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
};

/**
 * The infer-resolution seam: resolve ONE `(infer …)` call site to its value. The
 * caller decides where the task lives (the project's content-addressed cache, or
 * host's per-File tasks) and how it resolves. Returns the RAW value;
 * `buildArrivalEnv` wraps it to a list for scheme. Args arrive already coerced
 * (model/prompt stringified, schema via schemaSlot, cacheKey via nullable).
 */
export type InferFn = (
  ctx: { currentInvocation?: unknown } | undefined,
  model: string,
  prompt: string,
  schema: string | null,
  cacheKey: string | null,
  /**
   * Tools the model may call THIS turn. Optional + additive: a plain `(infer …)` omits
   * it (one-shot, unchanged); `infer/agentic/end-to-end` passes the resolved tool set so
   * the backend sends them and the result carries `toolCalls`. When present, the resolver
   * folds the tools into the cache identity (same messages + different tools = different
   * inference) and returns an {@link InferString} carrying the turn's `toolCalls`.
   */
  tools?: ToolDescriptor[],
) => Promise<unknown>;

// ── tool-enabled inference: identity folding + record/replay shape ─────────────
//
// A tool-enabled inference (the `infer/agentic/end-to-end` per-turn call) keeps the
// SAME cell/effect-log/binding/cache machinery as a plain `(infer …)` — these three
// helpers are the only deltas, all gated on whether tools were passed, so a plain infer
// is byte-for-byte unchanged.

/** Fold the tool set into the cache identity. Tools are an extra identity dimension
 *  (same messages + different tools = different inference), so folding them into the
 *  cacheKey reuses the (model,prompt,schema,cacheKey) key machinery — cell, effect-log,
 *  binding, AND disk cache — with no new key dimension. Order-preserving (tool order is
 *  semantically meaningful to the model). */
export function toolCacheKey(cacheKey: string | null, tools: readonly ToolDescriptor[]): string {
  return stableJson({ cacheKey, tools });
}

/** The record shape for a tool-enabled inference: value + the model's tool calls, so
 *  replay reconstructs the InferString WITH its calls (the loop branches on them). A
 *  plain infer records the bare value (unchanged). */
export function recordInfer(completion: Completion, hasTools: boolean): string {
  return hasTools
    ? JSON.stringify({ value: completion.value ?? null, toolCalls: completion.toolCalls ?? [] })
    : JSON.stringify(completion.value ?? null);
}

/** Revive a recorded/tweaked value. Tool-enabled → reconstruct the InferString (text +
 *  toolCalls; reasoning/chunks accrue in the loop driver, not here); plain → the bare
 *  parsed value (unchanged). */
export function reviveInfer(raw: string, hasTools: boolean): unknown {
  if (!hasTools) return JSON.parse(raw);
  const rec = JSON.parse(raw) as { value: unknown; toolCalls?: ToolCall[] };
  return new InferString(String(rec.value ?? ""), "", [], rec.toolCalls ?? []);
}

/** The fresh (cache-miss) return for a tool-enabled inference: an InferString carrying
 *  the turn's text + toolCalls. Plain → the bare value. */
export function freshInfer(completion: Completion, hasTools: boolean): unknown {
  return hasTools
    ? new InferString(String(completion.value ?? ""), "", [], completion.toolCalls ?? [])
    : completion.value;
}

/**
 * Drive `infer/agentic/end-to-end`'s loop and return the final {@link InferString}. SHARED
 * by the verb AND the `.prompt mcp:` sealed proc — resolve the servers' tools, then loop
 * infer↔dispatch via {@link runAgenticLoop}:
 *   - each turn through the cached infer seam with `ctx=undefined`, so per-turn inferences
 *     record as effects WITHOUT re-binding the agentic node's trace (one provenance node);
 *   - each dispatch through the server's middleware chain + positional tape, break-aware
 *     ({@link isMcpBreak}), with the loop's `{round,maxRounds}` handed in as `progress`.
 * The full trajectory rides the result's external-only `chunks`.
 */
async function runAgenticInfer(
  infer: InferFn,
  mcpResolve: McpEffectResolver,
  ctx: unknown,
  model: string,
  messages: ChatMessage[],
  servers: McpServerValue[],
): Promise<InferString> {
  const mcpCtx = ctx as McpEffectContext;
  const { tools, serverOf } = await resolveTools(servers, mcpResolve, mcpCtx);
  const result = await runAgenticLoop(messages, {
    infer: async (msgs) => {
      const out = await infer(undefined, model, JSON.stringify(msgs), null, null, tools);
      return out instanceof InferString
        ? { text: String(out), toolCalls: [...out.__toolCalls__], reasoning: out.__reasoning__ || undefined }
        : { text: String(out ?? ""), toolCalls: [] };
    },
    dispatch: async (call, progress) => {
      const server = serverOf.get(call.name);
      if (server === undefined) {
        throw new Error(`infer/agentic/end-to-end: model called unknown tool "${call.name}" — not in the :tools set`);
      }
      return dispatchThroughChain(
        server,
        "tools/call",
        { tool: call.name, args: call.arguments },
        mcpResolve,
        mcpCtx,
        progress,
      );
    },
    isHalt: isMcpBreak,
  });
  return new InferString(result.text, "", result.chunks);
}

/**
 * Build a sandboxed arrival-chain environment with the standard rosettas —
 * `infer`, `infer/chat`, `json/parse`, `dict`, `template/handlebars`, plus
 * `require`/`import` — EXCEPT inference resolution, which is injected via `infer`.
 *
 * This is the seam that lets a host route `(infer …)` into its own task store
 * without arrival-chain hardcoding where tasks live: `Project.run` passes a
 * cache-backed resolver; host passes a per-File one. The caller execs
 * `BUILTIN_PREAMBLE` (+ its source) against the returned env.
 *
 * DATA EFFECTS follow the identical seam: `(http/*)` / `(sql/query)` resolve
 * through an injected {@link DataEffectResolver} (`opts.data`). Absent it, those
 * verbs are inert — they exist but throw a teaching error at call time (the
 * disarmed default {@link inertDataResolver}), never a network/DB call and never
 * a silent no-op. The OSS engine ships the verbs disarmed; the SaaS host injects
 * the credentialed resolver. The verb BODIES (`http/get`, `sql/query`, …) are
 * registered by node A3 over the `data` capability resolved here.
 */
export function buildArrivalEnv(opts: {
  name: string;
  infer: InferFn;
  loader: Loader;
  /** Tap for `require`d module internals — `run` passes the trace; `runTraced`
   *  omits it so library internals don't explode the live trace. */
  tap?: EvalTrace;
  /** Base dir for resolving relative `(require …)`. */
  dirname?: string;
  /**
   * The per-run reflective budget accumulator backing `(infer/spent)` /
   * `(infer/calls)`. When the host feeds it (calling `spend.record(...)` as each
   * cell settles), those forms return the running fold over THIS run's own fresh
   * inference costs. When absent (back-compat default), the namespace is still
   * bound but inert — `(infer/spent)` returns 0 — so existing callers are
   * unaffected and a program that reads it never throws. Reserve level: namespace
   * present, no runtime trap. See `RunSpend`.
   */
  spend?: RunSpend;
  /**
   * Host capability for DATA EFFECTS — the membrane `(http/*)` / `(sql/query)`
   * cross. The data-side twin of `infer`: the engine knows the verbs, the host
   * binds label→credential. Absent, the verbs are INERT (present but throwing
   * {@link inertDataResolver}'s teaching error) — the OSS engine never reaches a
   * network or a database without a host arming it. See `data-effects.ts`.
   */
  data?: DataEffectResolver;
  /**
   * Host capability for MCP — the membrane `(mcp/call …)` / `(mcp/list …)` cross.
   * The client-side twin of `data`/`infer`: the engine knows the verbs, the host
   * binds server→credentialed transport. Absent, the verbs are INERT (present but
   * throwing {@link inertMcpResolver}'s teaching error). See `mcp-effects.ts`.
   */
  mcp?: McpEffectResolver;
  /**
   * Host sink for `(declare/expose …)`. Each time the form evaluates, the engine
   * hands the host a typed {@link OnExpose} declaration (name + the `(s/object …)`
   * input/output schemas + the handler bridged to plain JS) so host's registry
   * can gate/invoke it. Absent, the form still evaluates and returns its handler
   * (usable in-program) — it just registers nowhere. Same "capability optional,
   * verb always present" posture as `import`/`data`. The static twin is
   * `extractExpose` (reads the signature without ever running the handler).
   */
  onExpose?: OnExpose;
}): ReturnType<typeof sandboxedEnv.inherit> {
  const env = sandboxedEnv.inherit(opts.name);
  // Every (infer …) yields a list to scheme; the resolver returns the raw value.
  const list = (v: unknown): unknown => (Array.isArray(v) ? v : [v]);

  env.defineRosetta("infer", {
    withContext: true,
    options: { provenancePoint: true },
    fn: async (ctx, model, prompt, schema, cacheKey) =>
      list(await opts.infer(ctx, String(model), String(prompt), schemaSlot(schema), nullable(cacheKey))),
  });
  env.defineRosetta("json/parse", { fn: (s: unknown) => JSON.parse(String(s)) });
  env.defineRosetta("dict", { fn: (...args: unknown[]) => buildDict(args) });
  env.defineRosetta("template/handlebars", {
    fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
  });
  env.defineRosetta("infer/chat", {
    withContext: true,
    options: { provenancePoint: true },
    fn: async (ctx, model, messages, schema, cacheKey) =>
      list(await opts.infer(ctx, String(model), canonicalizeMessages(messages), schemaSlot(schema), nullable(cacheKey))),
  });
  // Reflective budget: `(infer/spent)` folds over the run's OWN prior inference
  // costs (reference USD, fresh calls only — cache hits are free); `(infer/calls)`
  // counts them. NOT provenance points — they read the run's history, they don't
  // produce an inference. Inert (→ 0) when no accumulator is bound. The racy-read
  // lint flags these reads inside a parallel HOF arm, where the fold is meaningless
  // (see `racy-read-lint.ts`); here we just vend the value.
  env.defineRosetta("infer/spent", { fn: () => opts.spend?.spent() ?? 0 });
  env.defineRosetta("infer/calls", { fn: () => opts.spend?.calls() ?? 0 });
  // Seal a `.prompt` PromptUnit into a provenance-point native proc. The output
  // schema is evaluated ONCE here (the `s/…` rosettas live on this env) and
  // slotted exactly as `infer/chat` would. Calling the proc `(run-x key :k v …)`
  // folds the kwargs, renders its sections, and infers AT JS LEVEL — and because
  // it's a `provenancePoint`, ITS OWN call-site invocation becomes the provenance
  // point. So a `.prompt` traces as ONE node at the real `(run-x …)` site with
  // the infer sealed inside it — no unwrapped line-1 `(infer/chat …)` lambda. The
  // task it mints is byte-identical to the equivalent `infer/chat` (shared
  // canonicalize + schemaSlot + nullable), so cache + replay are preserved.
  const compileInferUnit = async (unit: PromptUnit): Promise<unknown> => {
    let schemaSlotStr: string | null = null;
    if (unit.schemaSrc !== null) {
      const [form] = await parse(unit.schemaSrc);
      schemaSlotStr = schemaSlot(lipsToJs(await execExpr(form, { env })));
    }
    return createRosettaWrapper({
      withContext: true,
      options: { provenancePoint: true, argProvenance: true },
      fn: async (ctx, key, ...kv: unknown[]) => {
        const folded = buildDict(kv);
        // `:meta` is the inference-CONFIG channel (model override, future temp/
        // maxTokens) — kept separate from the template-INPUT namespace, so a
        // `.prompt` can still have any template var name. Strip it from `inputs`
        // before rendering; it's plumbing, not a hole the template fills.
        const meta = isPlainRecord(folded.meta) ? folded.meta : {};
        const { meta: _metaSlot, ...inputs } = folded;
        // Model = materialization: call-time `meta.model` wins, else the
        // frontmatter default, else a hard error (nothing to route to).
        const model = meta.model === undefined ? unit.model : String(meta.model);
        if (model === null) {
          throw new Error(
            `.prompt: "${unit.path}" has no model — set frontmatter \`model:\` or pass \`:meta (dict :model "…")\` at the call site`,
          );
        }
        // ctx.argProvenance aligns to the scheme args [key, ...kv]; drop the
        // leading `key` slot so it lines up with `kv` for buildInputsProvenance.
        // `meta` is config, not an input, so drop it from the per-field provenance.
        const argProv = (ctx as { argProvenance?: ReadonlySet<number>[] } | undefined)?.argProvenance;
        const inputsProvenanceAll = argProv ? buildInputsProvenance(kv, argProv.slice(1)) : undefined;
        const inputsProvenance = inputsProvenanceAll
          ? Object.fromEntries(Object.entries(inputsProvenanceAll).filter(([k]) => k !== "meta"))
          : undefined;
        // Bind the node's story (file, model, the structured inputs) to its
        // provenance node NOW, before the inference runs. It's all known at call
        // time, so the card renders its header + init fields WHILE the answer is
        // still streaming — not only once it resolves. `result` flows on as the
        // ordinary value. Same setMetadata-vs-POJO story as `markProvenancePoint`:
        // a real Invocation is a MobX observable (action), a plain test ctx is a
        // bare object.
        const inv = (ctx as { currentInvocation?: { setMetadata?(m: unknown): void; metadata?: unknown } } | undefined)
          ?.currentInvocation;
        if (inv) {
          const nodeMeta = { kind: "prompt", path: unit.path, model, inputs, inputsProvenance, reads: templateReads(unit.sections) };
          if (typeof inv.setMetadata === "function") inv.setMetadata(nodeMeta);
          else inv.metadata = nodeMeta;
        }
        const messages = unit.sections.map((s) => [s.role, renderTemplateCall(s.source, [inputs])]);
        // `mcp:` frontmatter ⇒ an AGENTIC prompt: list those servers' tools and loop
        // infer↔dispatch through the shared engine, returning the final answer. (Schema'd
        // agentic output isn't supported in v1 — error rather than silently drop the schema.)
        if (unit.mcpServers) {
          if (schemaSlotStr !== null) {
            throw new Error(
              `.prompt: "${unit.path}" combines \`mcp:\` (agentic) with \`output:\` (schema) — structured agentic output is not supported in v1`,
            );
          }
          const servers = unit.mcpServers.map((name) => new McpServerValue(name));
          const chatMessages: ChatMessage[] = messages.map(([role, content]) => ({
            role: String(role) as ChatMessage["role"],
            content: String(content),
          }));
          return runAgenticInfer(opts.infer, opts.mcp ?? inertMcpResolver, ctx, model, chatMessages, servers);
        }
        return opts.infer(ctx, model, canonicalizeMessages(messages), schemaSlotStr, nullable(key));
      },
    });
  };
  // Data-effect verbs (http/*, sql/query) over the resolved capability seam.
  // Disarmed default: with no host resolver they throw the teaching error rather
  // than reach a network/DB (present-but-inert, never an unbound symbol). Node A3
  // enriches the per-verb arg coercion inside `defineDataEffectRosettas`.
  defineDataEffectRosettas(env, opts.data ?? inertDataResolver);
  // MCP dispatch verbs (mcp/call, mcp/list) over the resolved capability seam. Same
  // disarmed-default posture: with no host resolver they throw the teaching error
  // rather than reach a server (present-but-inert, never an unbound symbol).
  defineMcpRosettas(env, opts.mcp ?? inertMcpResolver);
  // `mcp/break` — the bare halt sentinel a middleware returns to stop the agentic loop
  // without calling next (flow 4). Bound as a VALUE (not a verb) so scheme references it
  // bare; the JS chain runner compares the same global symbol `===`.
  env.set("mcp/break", MCP_BREAK);
  // `(infer/agentic/end-to-end model messages servers)` — the ONE explicit agentic verb
  // (V's framing: run the loop end-to-end, return the FINAL answer; a single `(infer …)`
  // never carries tool calls). `servers` is a list of `(mcp …)` handles. We list their
  // tools once (→ the model's tool set + toolName→server routing), then drive the JS loop:
  // each turn infers WITH the tools (W1 returns an InferString carrying `__toolCalls__`),
  // each tool call dispatches across the SAME mcp resolver (middleware [C3] + server tape),
  // and the loop finalizes on a no-tool turn. The whole run is ONE provenance node — the
  // per-turn inferences receive `undefined` ctx so they record as effects WITHOUT
  // re-binding this node's trace; the trajectory rides the final InferString as
  // external-only `chunks`.
  const mcpResolve = opts.mcp ?? inertMcpResolver;
  env.defineRosetta("infer/agentic/end-to-end", {
    withContext: true,
    options: { provenancePoint: true },
    fn: async (ctx, model, messages, servers) => {
      const serverVals = (Array.isArray(servers) ? servers : [servers]).filter(isMcpServerValue);
      // The loop, dispatch, break-handling + trajectory all live in the shared
      // `runAgenticInfer` (reused by the `.prompt mcp:` proc). `list` wraps the final
      // InferString the same way `(infer …)` wraps its value.
      return list(await runAgenticInfer(opts.infer, mcpResolve, ctx, String(model), parseSchemeChatMessages(messages), serverVals));
    },
  });
  // `(declare/expose …)` — the sealed-skill registration form. Reuses the same
  // `buildDict` keyword folder as `dict`/the `.prompt` proc so `:input`/`:output`/
  // `:handler` resolve identically; the host's `onExpose` sink receives the typed
  // declaration. Inert (handler-factory only) when no sink is supplied.
  defineExposeRosetta({ env, buildDict, onExpose: opts.onExpose });
  defineImportRosetta({ env, loader: opts.loader });
  defineRequireRosetta({ env, loader: opts.loader, tap: opts.tap, baseDir: opts.dirname ?? "", compileInferUnit });
  return env;
}

/**
 * Doc root.
 *   `files`    — owns Programs by path (the filesystem of this project)
 *   `programs` — non-owning refs into `files`, in explicit execution order
 *
 * Inference is resolved by a runtime-bound `InferStore` — bind one via
 * `project.bindInfer(store)` before running programs. The store is not
 * part of the synced model: a run is a pure function of the project's
 * files, so each host resolves inference through its own store (sharing
 * a disk/HTTP cache as configured) without cross-doc entity pointers.
 *
 * A file in `files` but NOT in `programs` is a library — imported by
 * other files, never executed standalone. Workers consume `programs`
 * in array order.
 */
@syncing("ArrivalChainProject")
export class Project extends PlexusModel<null> {
  // Model resolution lives in a separate `ModelRouter` passed to the
  // orchestrator at startup — see `registry.ts`. Project is pure model
  // state (no API keys, no SDK instances, no model→endpoint mappings — programs
  // call `(infer "model-id" …)` with the literal model name the runner
  // knows how to route).

  @syncing.child.map /** path → Program. Owning child map. */ accessor files: Map<string, Program> = new Map();

  // ── Inference plane (runtime, not synced) ─────────────────────────
  //
  // The content-keyed single-flight `InferStore` that resolves every
  // `(infer …)` — replacing the CRDT Task plane. Bound at orchestration
  // time (runner / CLI / DO / test setup). Like the old cache it is not
  // synced: a run is a pure function of the project's files, so each host
  // resolves inference through its own store (sharing a disk/HTTP cache as
  // configured) without any cross-doc entity pointers.

  #infer: InferStoreLike | null = null;

  bindInfer(store: InferStoreLike): void {
    this.#infer = store;
  }

  get infer(): InferStoreLike {
    invariant(this.#infer, "Project: no inference store bound — call project.bindInfer(store) before running programs");
    return this.#infer;
  }

  // Config-as-code: per-run configuration is no longer a project-env map.
  // A program `(require "config.scm")`s a file of `(define config/<name> …)`
  // forms, which spill ordinary bindings into the run env. There is no
  // scheme-side write path and no host-injected env — execution stays a pure
  // function of the project's files, which is what makes replay sound.

  transact(fn: () => void): void {
    const plexus = docPlexus.get(this.__doc__!);
    invariant(plexus, "Project: doc has no Plexus instance");
    plexus.transact(fn);
  }

  // ── Files + programs ──────────────────────────────────────────────

  addFile(path: string, initialSource?: string): Program {
    const program = new Program();
    this.transact(() => {
      this.files.set(path, program);
      if (initialSource !== undefined) program.publish(initialSource);
    });
    return program;
  }

  /** Backwards-compat alias for addFile; "program" used to be a distinct concept. */
  addProgram(path: string, initialSource?: string): Program {
    return this.addFile(path, initialSource);
  }

  findFile(path: string): Program | undefined {
    return this.files.get(path);
  }

  /** Reverse lookup: which path holds this Program? */
  findFilePath(program: Program): string | undefined {
    for (const [path, p] of this.files) if (p === program) return path;
    return undefined;
  }

  /**
   * Snapshot every file's CURRENT latest-version index: `{path → versionIndex}`.
   * Taken at invoke-start and recorded on the Run; the replay loader binds it so
   * a run sees ONE coherent cut of the project for its whole duration — a
   * concurrent `promoteDraft` on a `(require)`d library can't tear an in-flight
   * run, and a hypothesis replays the exact bytes the original saw. Files with no
   * published version yet (index `-1`) are skipped — there's nothing to pin, and
   * a require would fail the same way against latest. */
  captureVersionSet(): Map<string, number> {
    const set = new Map<string, number>();
    for (const [path, program] of this.files) {
      const idx = program.versions.length - 1;
      if (idx >= 0) set.set(path, idx);
    }
    return set;
  }

  // ── Execution ─────────────────────────────────────────────────────

  /**
   * Run an arrival-scheme program against this project's task cache.
   *
   * `infer` is bound via defineRosetta: each call ↔ find-or-create a
   * task entity in `tasks` keyed by the content tuple `[m,p,s]`, then
   * await its resolution. Resolution happens out-of-band — a
   * `runProjectWorker` (or any peer) observes `tasks` and drains
   * pending ones. There is no orchestration between `run` and the
   * worker beyond the doc.
   *
   * Parallelism falls out of LIPS's promise-aware evaluator: a missing
   * cell returns a Promise; `(map infer xs)` collects them; the
   * program's consumer (`promise_all` inside map/string-append) is
   * where the wait happens. Force at observation, not at the call.
   */
  async run(
    source: string,
    opts: {
      trace?: EvalTrace;
      resolver?: RequireResolver;
      /** Override the module loader for `(require …)`. Defaults to the project VFS. */
      loader?: Loader;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Per-run curated `import` registry — `(import "name")` resolves here.
       *  Merged onto the loader's defaults (per-run entries win). */
      imports?: Map<string, unknown>;
      /** Called with the kind-tagged effect key for every EXTERNAL effect (infer,
       *  http, sql) as it fires, in evaluation order. The Run/Hypothesis recorders
       *  push these into `.effects` — the per-run effect-log's key sequence. */
      onEffect?: (effectKey: string) => void;
      /** Called when an effect SETTLES with its value: `(taggedKey, valueJson)`.
       *  Feed an `effectLogCollector().record` here to build the run's full
       *  effect-log in one pass (the source a later replay binds via `effectLog`).
       *  Fires for fresh AND replayed effects (replay re-records the identical
       *  value), so the produced log is complete regardless of cache/replay state. */
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      /**
       * Override inference resolution by content tuple — keyed by canonical JSON of
       * the UNTAGGED tuple `[model, prompt, schema, cacheKey]`. The counterfactual
       * surface: `runHypothesis` passes chosen overrides here so a branched tuple
       * short-circuits with a NEW value (never hits the LLM). Partial (only the
       * branched tuples; the rest flow through). Distinct from `effectLog`, which
       * replays RECORDED values across ALL effect kinds — bind both to replay a run
       * yet branch one node. Tweaks win over the log (the counterfactual is the point).
       */
      tweaks?: Map<string, string>;
      /**
       * Deterministic-replay log: kind-tagged effect key → recorded value JSON (see
       * `effect-log.ts`). Before any external call the matching kind+payload is
       * looked up here; a hit short-circuits with the recorded value — so binding a
       * FULL log makes every effect replay with ZERO external hits, and binding a log
       * with a changed node's forward-cone subtracted (`invalidateForwardCone`)
       * re-runs exactly the invalidated effects while the rest replay free. The
       * cross-kind currency is the tagged key, so http/sql/infer share one map
       * without collision.
       */
      effectLog?: EffectLog;
      /**
       * Host capability for DATA EFFECTS (`(http/*)` / `(sql/query)`). Threaded to
       * `buildArrivalEnv` so the verbs (node A3) reach the credentialed resolver,
       * wrapped here so each data effect records into `.effects` and replays from
       * `effectLog` through the SAME seam as infer — one effect membrane, three kinds.
       */
      data?: DataEffectResolver;
      /**
       * Host capability for MCP (`(mcp/call …)` / `(mcp/list …)`). Threaded to
       * `buildArrivalEnv` so the verbs reach the credentialed resolver, wrapped here
       * (POSITIONAL server-tape) so each mcp call records into the effect-log and
       * replays HERMETICALLY — the MCP twin of the `data` seam.
       */
      mcp?: McpEffectResolver;
      /**
       * Host sink for `(declare/expose …)` (node D4). Threaded straight to
       * `buildArrivalEnv` so each declaration that evaluates during the run hands
       * the host its typed {@link OnExpose} declaration (name + evaluated schemas +
       * the JS-bridged handler) — the seam host's exposed-function INVOCATION
       * uses to capture a sealed skill's handler from a run, then call it. Absent
       * (the default), the form still evaluates + returns its handler; it just
       * registers nowhere — same "capability optional, verb always present" posture
       * as `infer`/`data`/`import`. Evaluating the form does NOT call the handler
       * (it captures the lambda closure), so a registration run is side-effect-free
       * beyond whatever the file's OTHER top-level forms do.
       */
      onExpose?: OnExpose;
      /** Host hook to inject extra rosettas onto the pipeline env after the
       *  standard ones are wired and before the program runs — e.g. a bridge into
       *  another sandbox. Keeps `.prompt`/`require`/trace machinery intact while
       *  letting a host extend the env's capability surface. */
      extendEnv?: (env: ReturnType<typeof buildArrivalEnv>) => void;
    } & ExecBudget = {},
  ): Promise<unknown> {
    // The per-run reflective budget accumulator behind `(infer/spent)`. Folds the
    // reference cost of each FRESH inference as its cell settles, in evaluation
    // order — so a program's ROI/TCO loop can read what it has paid so far. Local
    // to this run (the `InferStore` is cross-run / shared; "spent THIS run" is not).
    const spend = new RunSpend();

    // The cache-backed infer resolver: find-or-create a task in this project's
    // content-addressed cache, bind the trace, await its result. The rosetta
    // wiring + list-wrapping live in buildArrivalEnv (shared with runTraced +
    // host); this closure is the project-specific seam.
    const inferAndWait: InferFn = async (ctx, model, prompt, schema, cacheKey, tools) => {
      // Tools are part of the inference identity (same messages + different tools =
      // different result) — fold them into the cacheKey so the existing
      // (model,prompt,schema,cacheKey) machinery distinguishes toolsets with no new key
      // dimension. Absent tools ⇒ the original key + bare value, byte-for-byte.
      const hasTools = tools !== undefined && tools.length > 0;
      const key = hasTools ? toolCacheKey(cacheKey, tools) : cacheKey;
      // Two short-circuit maps, consulted before any inference — counterfactual
      // first (it supplies NEW values), then the replay log (RECORDED values):
      //   - tweaks: keyed by the UNTAGGED content tuple (the legacy hypothesis surface).
      //   - effectLog: keyed by the kind-TAGGED effect key (the all-kinds replay surface).
      // A hit on either skips the LLM entirely (the whole point of replay/branch).
      const tweakKey = JSON.stringify([model, prompt, schema, key]);
      const tweak = opts.tweaks?.get(tweakKey);
      if (tweak !== undefined) return reviveInfer(tweak, hasTools); // buildArrivalEnv wraps to a list
      const effectKeyStr = inferEffectKey(model, prompt, schema, key);
      const replayed = opts.effectLog?.get(effectKeyStr);
      if (replayed !== undefined) {
        // Replay still records the effect (the key sequence is part of the run's
        // identity) and marks the trace node as a cached provenance point — so a
        // replayed run's trace/graph is shaped identically to the original.
        opts.onEffect?.(effectKeyStr);
        opts.onEffectResult?.(effectKeyStr, replayed);
        const inv = ctx?.currentInvocation;
        if (inv && opts.trace) {
          opts.trace.markInferCached(inv as never, true);
          opts.trace.markProvenancePoint(inv as never);
        }
        return reviveInfer(replayed, hasTools);
      }
      // Single-flight cell: the first call for this content tuple starts the
      // backend; later identical calls ride the same cell. Acquire keeps it alive;
      // release lets the last holder abort a superseded run. `tools` rides on the spec
      // (the backend sends them); identity is already in `key`.
      const cell = this.infer.get({ model, prompt, schema, tools }, key);
      const cached = cell.finished(); // already-settled at bind = served from a prior get this run
      cell.acquire();
      opts.onEffect?.(effectKeyStr);
      const inv = ctx?.currentInvocation;
      let binding: InferBinding | undefined;
      if (inv && opts.trace) {
        binding = new InferBinding(model, prompt, schema, key, cell);
        opts.trace.bindTask(binding, inv as never);
        opts.trace.markInferCached(inv as never, cached);
        // Every (infer …) is a fresh provenance singleton {self.id}.
        opts.trace.markProvenancePoint(inv as never);
      }
      try {
        const completion = await cell.done;
        if (binding) binding.completion = completion; // stamp usage for synchronous cost walk
        // Fold this inference into the reflective budget — fresh calls only (a
        // cache hit cost nothing this run, so it's free; `(infer/spent)` sums what
        // was PAID, never what was saved). Stamped after the await settles, so the
        // value a later `(infer/spent)` reads is order-correct.
        spend.record(model, completion.usage, !cached);
        // Record the settled value into the effect-log sink (its key was already
        // recorded above). A tool-enabled turn records {value, toolCalls} so replay
        // reconstructs the InferString with its calls; a plain infer records the bare
        // value, the same shape replay reads back.
        opts.onEffectResult?.(effectKeyStr, recordInfer(completion, hasTools));
        return freshInfer(completion, hasTools);
      } finally {
        cell.release();
      }
    };

    const loader = opts.loader ?? (opts.resolver ? loaderFromResolver(opts.resolver) : makeProjectLoader(this));
    // `import` is the curated host-capability registry (FS-free). Merge the
    // per-run set onto the loader's defaults; the require rosetta taps this run.
    if (opts.imports) for (const [name, value] of opts.imports) loader.imports.set(name, value);
    // Data effects cross the same record+replay seam as infer: wrap the host
    // resolver so each (http/*)/(sql/query) consults `effectLog` (replay) and
    // records its tagged key into `.effects`. Absent a host resolver the verbs
    // stay inert (buildArrivalEnv's default), so this is armed only when a `data`
    // capability was supplied.
    const data = opts.data
      ? this.#wrapDataResolver(opts.data, {
          effectLog: opts.effectLog,
          onEffect: opts.onEffect,
          onEffectResult: opts.onEffectResult,
          trace: opts.trace,
        })
      : undefined;
    // MCP crosses the same record+replay seam, but keyed POSITIONALLY (server-tape) —
    // see wrapMcpResolver. Anchored to "" (run scope) for program-initiated calls; the
    // step-2 agentic loop will anchor model-driven calls to the enclosing infer's id.
    const mcp = opts.mcp
      ? wrapMcpResolver(opts.mcp, {
          inferenceId: "",
          effectLog: opts.effectLog,
          onEffect: opts.onEffect,
          onEffectResult: opts.onEffectResult,
        })
      : undefined;
    const env = buildArrivalEnv({
      name: "arrival-chain",
      infer: inferAndWait,
      loader,
      tap: opts.trace,
      dirname: opts.dirname,
      spend,
      data,
      mcp,
      onExpose: opts.onExpose,
    });
    opts.extendEnv?.(env);
    const results = await exec(BUILTIN_PREAMBLE + source, {
      env,
      tap: opts.trace,
      signal: opts.signal,
      budgetMs: opts.budgetMs,
    });
    let last: unknown = results.at(-1);
    if (isThenable(last)) last = await last;
    return lipsToJs(last, {});
  }

  /**
   * Wrap a host {@link DataEffectResolver} with the effect-log record+replay seam,
   * so `(http/*)` / `(sql/query)` cross the SAME membrane as `(infer …)`:
   *   - REPLAY: a kind-tagged key present in `effectLog` short-circuits with the
   *     recorded value — zero external hits. (The same partial-invalidation a
   *     subtracted log gives infer applies to data effects for free.)
   *   - RECORD: the tagged key is reported via `onEffect` (→ `Run.effects`) and the
   *     settled value via `onEffectResult` (→ the effect-log collector).
   *   - PROVENANCE: the effect's invocation is marked a provenance point and bound
   *     to a {@link DataBinding}, so it becomes a node in the causal graph and the
   *     forward-cone reaches it (A3 registers the verbs without provenance marking;
   *     we add it HERE, where the effect-log lives, so data effects are first-class
   *     cone members exactly like infers).
   *
   * Inert when no `effectLog` and no recording sinks AND no trace — but we still
   * mark provenance so the graph is correct; the wrap is cheap.
   */
  #wrapDataResolver(
    inner: DataEffectResolver,
    seam: {
      effectLog?: EffectLog;
      onEffect?: (effectKey: string) => void;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      trace?: EvalTrace;
    },
  ): DataEffectResolver {
    return async (ctx, effect) => {
      const key = dataEffectKey(effect);
      const inv = (ctx as { currentInvocation?: unknown } | undefined)?.currentInvocation;
      // Make the data effect a first-class causal node: a provenance point bound to
      // a DataBinding, so `effectKeysByInvocation` resolves its id → this key and
      // the forward-cone reaches it (replay marks the same, so a replayed run's
      // graph matches the original).
      const mark = (): void => {
        if (inv && seam.trace) {
          seam.trace.bindTask(new DataBinding(effect, key), inv as never);
          seam.trace.markProvenancePoint(inv as never);
        }
      };
      const replayed = seam.effectLog?.get(key);
      if (replayed !== undefined) {
        seam.onEffect?.(key);
        seam.onEffectResult?.(key, replayed);
        mark();
        return JSON.parse(replayed) as DataEffectResult;
      }
      seam.onEffect?.(key);
      mark();
      const value = await inner(ctx, effect);
      seam.onEffectResult?.(key, JSON.stringify(value ?? null));
      return value;
    };
  }

  /**
   * Reverse-membrane entry: evaluate a named `(define …)` from `file`
   * with supplied `args`. Mints an apiCall Run under that file's Program,
   * populated with the version snapshot, input, effect references as they
   * fire, and final output. Returns the Run synchronously so the API layer
   * can hand its id back to the client immediately.
   *
   * `data` arms the data-effect verbs with a credentialed host resolver (the
   * host Runner DO supplies one; absent, `(http/*)`/`(sql/query)` are inert).
   * `effectLog` replays a recorded log (zero external hits) — re-invoking a past
   * run deterministically. `onEffectResult` lets the host collect THIS run's
   * effect-log in one pass (feed `effectLogCollector().record`) to persist for a
   * future replay.
   */
  invoke(opts: {
    id: string;
    file: string;
    name: string;
    args: readonly unknown[];
    data?: DataEffectResolver;
    mcp?: McpEffectResolver;
    effectLog?: EffectLog;
    onEffectResult?: (effectKey: string, valueJson: string) => void;
  }): Run {
    const program = this.files.get(opts.file);
    invariant(program, `Project.invoke: file "${opts.file}" not found`);
    invariant(!program.apiCalls.has(opts.id), `Project.invoke: id "${opts.id}" already exists`);

    // Snapshot the WHOLE project's version-set at admission — not just the entry.
    // The run binds this cut for its duration (the loader reads it), so a
    // concurrent edit to a `(require)`d library can't tear the in-flight run and
    // a later hypothesis replays the identical bytes. This is "live draft v1"
    // done right: latest pinned at invoke-start, the minimal stand-in for a
    // frozen projectRelease.
    const versionSet = this.captureVersionSet();
    const run = new Run();
    this.transact(() => {
      program.apiCalls.set(opts.id, run);
      run.versionIndex = program.versions.length - 1;
      run.versionSetJson = JSON.stringify(Object.fromEntries(versionSet));
      run.hasInput = true;
      run.name = opts.name;
      run.argsJson = JSON.stringify(opts.args);
      run.startedAt = Date.now();
      run.status = "pending";
    });

    // Pin the entry body to the snapshot too (the entry IS in versionSet), so the
    // body and every transitive require come from the same cut.
    const body = program.versions[versionSet.get(opts.file)!]?.source ?? "";
    const loader = makeProjectLoader(this, versionSet);
    void this.#executeRun(run, body, opts.name, opts.args, {
      loader,
      data: opts.data,
      mcp: opts.mcp,
      effectLog: opts.effectLog,
      onEffectResult: opts.onEffectResult,
    });
    return run;
  }

  // ── Drafts ─────────────────────────────────────────────────────────
  //
  // `.scm` files are deployed (read-only at rest). Edits go through a
  // Draft — one in-flight mutable head per file. Sandbox runs live
  // under the draft, not under the Program. Promoting a draft appends
  // a new version and clears the draft slot.

  /** Mint a new draft from the program's latest version. Throws if a draft already exists. */
  createDraft(opts: { file: string }): Draft {
    const program = this.files.get(opts.file);
    invariant(program, `Project.createDraft: file "${opts.file}" not found`);
    invariant(!program.draft, `Project.createDraft: draft already exists on "${opts.file}"`);
    const latestIndex = program.versions.length - 1;
    const draft = new Draft();
    this.transact(() => {
      program.draft = draft;
      draft.source = program.versions[latestIndex]?.source ?? "";
      draft.basedOnVersion = latestIndex;
    });
    console.log(`[draft] createDraft "${opts.file}" basedOnVersion=${latestIndex} sourceLen=${draft.source.length}`);
    return draft;
  }

  /** Mutate the draft's source. Auto-creates a draft from latest version if missing. */
  editDraftSource(opts: { file: string; source: string }): Draft {
    const program = this.files.get(opts.file);
    invariant(program, `Project.editDraftSource: file "${opts.file}" not found`);
    const draft = program.draft ?? this.createDraft({ file: opts.file });
    if (draft.source !== opts.source) {
      this.transact(() => { draft.source = opts.source; });
      console.log(`[draft] editDraftSource "${opts.file}" sourceLen=${opts.source.length}`);
    }
    return draft;
  }

  /** Publish the draft's source as a new version; clear the draft slot. */
  promoteDraft(opts: { file: string }): ProgramVersion {
    const program = this.files.get(opts.file);
    invariant(program, `Project.promoteDraft: file "${opts.file}" not found`);
    const draft = program.draft;
    invariant(draft, `Project.promoteDraft: no draft on "${opts.file}"`);
    let version!: ProgramVersion;
    this.transact(() => {
      version = program.publish(draft.source);
      program.draft = null;
    });
    return version;
  }

  /** Throw the draft away, including all its sandbox runs. */
  discardDraft(opts: { file: string }): void {
    const program = this.files.get(opts.file);
    invariant(program, `Project.discardDraft: file "${opts.file}" not found`);
    this.transact(() => { program.draft = null; });
  }

  /**
   * Forward-membrane entry: studio is re-evaluating the draft of a file.
   * Mints a sandbox Run under the file's Draft (auto-creates the draft
   * if missing). Returns the Run + the finished promise.
   */
  sandboxRun(opts: {
    id: string;
    file: string;
    trace?: EvalTrace;
    resolver?: RequireResolver;
  }): { run: Run; finished: Promise<unknown> } {
    const program = this.files.get(opts.file);
    invariant(program, `Project.sandboxRun: file "${opts.file}" not found`);
    const draft = program.draft ?? this.createDraft({ file: opts.file });
    invariant(!draft.sandbox.has(opts.id), `Project.sandboxRun: id "${opts.id}" already exists`);

    const run = new Run();
    this.transact(() => {
      draft.sandbox.set(opts.id, run);
      run.versionIndex = draft.basedOnVersion;
      run.hasInput = false;
      run.startedAt = Date.now();
      run.status = "pending";
    });

    const body = draft.source;
    const finished = this.#executeSandbox(run, body, opts.trace, opts.resolver);
    return { run, finished };
  }

  async #executeRun(
    run: Run,
    body: string,
    name: string,
    args: readonly unknown[],
    opts: {
      loader?: Loader;
      data?: DataEffectResolver;
      mcp?: McpEffectResolver;
      effectLog?: EffectLog;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
    } = {},
  ): Promise<void> {
    // Failure is already recorded on the Run by #runIntoRun; swallow here
    // so the void-call from invoke() doesn't produce an unhandled rejection.
    try {
      await this.#runIntoRun(run, body + "\n" + this.#callForm(name, args), opts);
    } catch {
      /* recorded on run.output */
    }
  }

  async #executeSandbox(
    run: Run,
    body: string,
    trace?: EvalTrace,
    resolver?: RequireResolver,
  ): Promise<unknown> {
    return this.#runIntoRun(run, body, { trace, resolver });
  }

  async #runIntoRun(
    run: Run,
    source: string,
    opts: {
      trace?: EvalTrace;
      resolver?: RequireResolver;
      loader?: Loader;
      tweaks?: Map<string, string>;
      effectLog?: EffectLog;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      data?: DataEffectResolver;
      mcp?: McpEffectResolver;
    } = {},
  ): Promise<unknown> {
    try {
      const value = await this.run(source, {
        ...opts,
        onEffect: (effectKey) => {
          // Each effect key appended in its own micro-transact so peers
          // see the trace grow as it happens (not just on finish).
          this.transact(() => run.effects.push(effectKey));
        },
      });
      this.transact(() => {
        run.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
        run.status = "resolved";
        run.finishedAt = Date.now();
      });
      return value;
    } catch (error) {
      this.transact(() => {
        run.output = new RunError({
          message: formatRunError(error),
        });
        run.status = "failed";
        run.finishedAt = Date.now();
      });
      throw error;
    }
  }

  /**
   * Counterfactual replay. Re-executes the given Run against a tweak map
   * (canonical-tuple-string → override-value-JSON) and records the result
   * as a Hypothesis child of that Run. Source comes from the Run's pinned
   * `versionIndex` snapshot — not the file's latest — AND every `(require)`d
   * file is read at the Run's `versionSet` snapshot, so a MULTI-file hypothesis
   * stays faithful even if any file (entry OR a transitive library) has since
   * been edited. (Without the version-set, the entry was pinned but a required
   * library replayed at latest — the multi-file replay tear A7 closes.)
   *
   * Optional `effectLog` replays the original run's RECORDED effects (zero external
   * hits) while `tweaks` branches chosen ones — together they are deterministic
   * replay + counterfactual in one pass. Pass a FULL log to reproduce exactly; pass
   * `invalidateForwardCone(fullLog, run-trace, [changedNode])` to re-run only the
   * changed node's blast radius and replay the rest (the cheap "what changed if I
   * edit just here" path).
   */
  runHypothesis(opts: {
    id: string;
    run: Run;
    tweaks: Map<string, string>;
    /** Recorded-effect replay log (kind-tagged key → value JSON). See above. */
    effectLog?: EffectLog;
  }): { hypothesis: Hypothesis; finished: Promise<unknown> } {
    const run = opts.run;
    invariant(!run.hypotheses.has(opts.id), `Project.runHypothesis: id "${opts.id}" already exists`);
    // Run.parent is Program (apiCall) or Draft (sandbox). For hypothesis
    // replay we always want the Program so we can address its versions[].
    const parentNode = run.parent;
    invariant(parentNode, "Project.runHypothesis: Run is detached");
    const program: Program = parentNode instanceof Program ? parentNode : parentNode.parent!;
    invariant(program, "Project.runHypothesis: could not resolve owning Program");
    const version = program.versions[run.versionIndex];
    invariant(version, `Project.runHypothesis: version ${run.versionIndex} missing from program`);

    const hypothesis = new Hypothesis();
    this.transact(() => {
      run.hypotheses.set(opts.id, hypothesis);
      hypothesis.tweaksJson = JSON.stringify(Object.fromEntries(opts.tweaks));
      hypothesis.startedAt = Date.now();
      hypothesis.status = "pending";
    });

    const body = version.source;
    const source = run.hasInput
      ? body + "\n" + this.#callForm(run.name, run.args)
      : body;
    // Replay every `(require)` at the Run's pinned version-set, so a transitive
    // library is read at the bytes the original saw. An empty set (a Run minted
    // before A7, or one with no captured files) falls back to the default loader
    // — that Run replays exactly as it did before: entry pinned, requires latest.
    const versionSet = run.versionSet;
    const loader = versionSet.size > 0 ? makeProjectLoader(this, versionSet) : undefined;
    const finished = (async () => {
      try {
        const value = await this.run(source, {
          loader,
          tweaks: opts.tweaks,
          effectLog: opts.effectLog,
          onEffect: (effectKey) => this.transact(() => hypothesis.effects.push(effectKey)),
        });
        this.transact(() => {
          hypothesis.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
          hypothesis.status = "resolved";
          hypothesis.finishedAt = Date.now();
        });
        return value;
      } catch (error) {
        this.transact(() => {
          hypothesis.output = new RunError({
            message: formatRunError(error),
          });
          hypothesis.status = "failed";
          hypothesis.finishedAt = Date.now();
        });
        throw error;
      }
    })();
    return { hypothesis, finished };
  }

  /**
   * Studio sandbox entry that ALSO produces the tap-attached `userForms`
   * (for live counter rendering). Auto-creates a draft if missing, syncs
   * the draft's source to the buffer, then mints a sandbox Run under the
   * draft. The Run's `versionIndex` pins to the draft's `basedOnVersion`
   * — the deployed version this experimentation diverged from.
   */
  async sandboxRunTraced(opts: {
    id: string;
    file: string;
    source: string;
    trace: EvalTrace;
    resolver?: RequireResolver;
  }): Promise<{ run: Run; userForms: unknown[]; finished: Promise<unknown> }> {
    console.log(`[sandbox] sandboxRunTraced enter id=${opts.id} file="${opts.file}" sourceLen=${opts.source.length}`);
    const program = this.files.get(opts.file);
    invariant(program, `Project.sandboxRunTraced: file "${opts.file}" not found`);
    const draft = this.editDraftSource({ file: opts.file, source: opts.source });
    invariant(
      !draft.sandbox.has(opts.id),
      `Project.sandboxRunTraced: id "${opts.id}" already exists`,
    );

    const run = new Run();
    this.transact(() => {
      draft.sandbox.set(opts.id, run);
      run.versionIndex = draft.basedOnVersion;
      run.hasInput = false;
      run.startedAt = Date.now();
      run.status = "pending";
    });
    console.log(`[sandbox] sandboxRunTraced minted run id=${opts.id}, draft.sandbox.size=${draft.sandbox.size}`);

    const { userForms, finished } = await this.runTraced(opts.source, {
      trace: opts.trace,
      resolver: opts.resolver,
      onEffect: (effectKey) => this.transact(() => run.effects.push(effectKey)),
    });

    const tracked = (async () => {
      try {
        const value = await finished;
        this.transact(() => {
          run.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
          run.status = "resolved";
          run.finishedAt = Date.now();
        });
        return value;
      } catch (error) {
        this.transact(() => {
          run.output = new RunError({
            message: formatRunError(error),
          });
          run.status = "failed";
          run.finishedAt = Date.now();
        });
        throw error;
      }
    })();

    return { run, userForms, finished: tracked };
  }

  #callForm(name: string, args: readonly unknown[]): string {
    const argExprs = args.map((a) => `(json/parse ${JSON.stringify(JSON.stringify(a))})`);
    return `(${name}${argExprs.length ? " " + argExprs.join(" ") : ""})`;
  }

  /**
   * Run a program for live inspection: parses the user body separately and
   * returns the parsed top-level forms so callers (the monitor UI) can render
   * the same Pair objects that the evaluator will populate the trace with.
   *
   * The builtin preamble + (require ...) preamble are evaluated tap-free so
   * the trace's records map contains only user-program forms.
   *
   * Returns immediately with `{ userForms, finished }` — `finished` resolves
   * to the program's last value when (and if) all infer cells resolve.
   */
  async runTraced(
    source: string,
    opts: {
      trace: EvalTrace;
      resolver?: RequireResolver;
      /** Override the module loader for `(require …)`. Defaults to the project VFS. */
      loader?: Loader;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Per-run curated `import` registry — `(import "name")` resolves here.
       *  Merged onto the loader's defaults (per-run entries win). */
      imports?: Map<string, unknown>;
      /** Called with the kind-tagged effect key for every external effect (infer/
       *  http/sql) as it fires — the `.effects` recorder, same as `run`. */
      onEffect?: (effectKey: string) => void;
      /** Called when an effect settles with its value: `(taggedKey, valueJson)`
       *  — feed an `effectLogCollector().record` to build the run's log. */
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      /** Counterfactual infer overrides keyed by the UNTAGGED content tuple. */
      tweaks?: Map<string, string>;
      /** Deterministic-replay log (kind-tagged key → value JSON); a hit short-
       *  circuits the external call. See `run`'s `effectLog`. */
      effectLog?: EffectLog;
      /** Host data-effect resolver for `(http/*)` / `(sql/query)`; wrapped with the
       *  same record+replay seam as `run`. Inert when absent. */
      data?: DataEffectResolver;
    } & ExecBudget,
  ): Promise<{ userForms: unknown[]; finished: Promise<unknown> }> {
    // Reuse the same rosetta wiring as run() by going through run() for the
    // preamble half, then parsing and tap-evaluating the user body ourselves.
    // To avoid duplicating the env-setup, we set up the env inline here.
    const inferAndWait: InferFn = async (ctx, model, prompt, schema, cacheKey, tools) => {
      // Same tool-identity fold + record/replay shape as run()'s resolver (see the
      // helpers near InferFn); absent tools ⇒ byte-for-byte the original behaviour.
      const hasTools = tools !== undefined && tools.length > 0;
      const key = hasTools ? toolCacheKey(cacheKey, tools) : cacheKey;
      const tupleKey = JSON.stringify([model, prompt, schema, key]);
      const tweak = opts.tweaks?.get(tupleKey);
      if (tweak !== undefined) return reviveInfer(tweak, hasTools); // buildArrivalEnv wraps to a list
      const effectKeyStr = inferEffectKey(model, prompt, schema, key);
      const replayed = opts.effectLog?.get(effectKeyStr);
      if (replayed !== undefined) {
        opts.onEffect?.(effectKeyStr);
        opts.onEffectResult?.(effectKeyStr, replayed);
        const inv = ctx?.currentInvocation;
        if (inv) {
          opts.trace.markInferCached(inv as never, true);
          opts.trace.markProvenancePoint(inv as never);
        }
        return reviveInfer(replayed, hasTools);
      }
      const cell = this.infer.get({ model, prompt, schema, tools }, key);
      const cached = cell.finished();
      cell.acquire();
      opts.onEffect?.(effectKeyStr);
      const inv = ctx?.currentInvocation;
      let binding: InferBinding | undefined;
      if (inv) {
        binding = new InferBinding(model, prompt, schema, key, cell);
        opts.trace.bindTask(binding, inv as never);
        opts.trace.markInferCached(inv as never, cached);
        opts.trace.markProvenancePoint(inv as never);
      }
      try {
        const completion = await cell.done;
        if (binding) binding.completion = completion;
        opts.onEffectResult?.(effectKeyStr, recordInfer(completion, hasTools));
        return freshInfer(completion, hasTools);
      } finally {
        cell.release();
      }
    };

    const loader = opts.loader ?? (opts.resolver ? loaderFromResolver(opts.resolver) : makeProjectLoader(this));
    if (opts.imports) for (const [name, value] of opts.imports) loader.imports.set(name, value);
    // `require` internals are NOT tapped (tap omitted) so a required library
    // doesn't explode the live trace — the (require …) call still appears as a
    // top-level user form; provenance for library infers rides the plain run().
    const data = opts.data
      ? this.#wrapDataResolver(opts.data, {
          effectLog: opts.effectLog,
          onEffect: opts.onEffect,
          onEffectResult: opts.onEffectResult,
          trace: opts.trace,
        })
      : undefined;
    const env = buildArrivalEnv({
      name: "arrival-chain-traced",
      infer: inferAndWait,
      loader,
      tap: undefined,
      dirname: opts.dirname,
      data,
    });
    // Evaluate the builtin preamble first, tap-free, so the records map starts
    // with only user-program forms.
    await exec(BUILTIN_PREAMBLE, { env, signal: opts.signal, budgetMs: opts.budgetMs });
    // Parse the whole user source — these are the Pair identities the UI renders
    // AND the ones the evaluator taps. A `(require …)` resolves when its form runs.
    const userForms = await parse(source, env);

    // Kick off evaluation of each user form sequentially, with the tap attached.
    // A `(require …)` spills its defines/macros before the next form (eager-seq).
    const finished = (async () => {
      let last: unknown = undefined;
      for (const form of userForms) {
        last = await execExpr(form, { env, tap: opts.trace, signal: opts.signal, budgetMs: opts.budgetMs });
        if (isThenable(last)) last = await last;
      }
      return lipsToJs(last, {});
    })();

    return { userForms, finished };
  }
}

/**
 * Built-in scheme bindings that every Project.run() program gets,
 * before any user (require ...) preambles. Defines the chat-message
 * constructors and the schema-DSL helpers. Keeping these in the
 * runtime (instead of forcing every program to `(require "_lib.scm")`)
 * keeps short programs short and makes the DSL feel native.
 */
export const BUILTIN_PREAMBLE =`
;; ── numeric helpers ────────────────────────────────────────────────
;; (range 3) → (0 1 2)
(define (range n)
  (define (loop i acc) (if (>= i n) (reverse acc) (loop (+ i 1) (cons i acc))))
  (loop 0 '()))

;; ── list helpers (used by fold-based pipelines like the GEPA loop) ─
;; All four are textbook one-liners; live in the preamble so they're
;; available without each program redefining them.
;;
;; (take 3 '(a b c d e))   → (a b c)
;; (drop 2 '(a b c d e))   → (c d e)
;; (count-if odd? '(1 2 3 4)) → 2
;; (max-by car '((1 x) (3 y) (2 z))) → (3 y)
;;
;; LIPS \`reduce\` is element-first: callback signature is (x acc), not (acc x).
(define (take n xs)
  (if (or (= n 0) (null? xs)) '() (cons (car xs) (take (- n 1) (cdr xs)))))
(define (drop n xs)
  (if (or (= n 0) (null? xs)) xs (drop (- n 1) (cdr xs))))
(define (count-if pred xs)
  (reduce (lambda (x acc) (if (pred x) (+ acc 1) acc)) 0 xs))
;; max-by: ties go to the first encountered walking cdr from (car xs).
;; With history that's most-recent-first, that means the most-recent
;; tied-at-max element wins — the "converged here" semantic.
(define (max-by f xs)
  (reduce (lambda (x best) (if (> (f x) (f best)) x best)) (car xs) (cdr xs)))

;; ── dict helpers ───────────────────────────────────────────────────
;;
;; \`(require "x.json")\` produces JS objects (SchemeJSObject) via
;; json/parse. Three equivalent ways to read a field:
;;   (@ obj "key")    explicit accessor, works on variable keys
;;   (:key obj)       keyword as fn, idiomatic for fixed keys
;;   (field obj key)  polymorphic — also walks alists, returns "" on miss
;;                    (useful where the same code reads both shapes)
;;
;; @keys returns a JS array; keys-of converts to a scheme list.
;; values-of and entries-of parallel JS Object.values/.entries.
(define (field container key)
  (cond ((null? container) "")
        ((pair? container)
          (let ((p (assoc key container))) (if (pair? p) (cdr p) "")))
        (else (@ container key))))

(define (keys-of obj)    (vector->list (@keys obj)))
(define (values-of obj)  (map (lambda (k) (@ obj k))          (keys-of obj)))
(define (entries-of obj) (map (lambda (k) (list k (@ obj k))) (keys-of obj)))

;; ── chat message constructors ──────────────────────────────────────
(define (infer/chat/system content)    (list "system"    content))
(define (infer/chat/user content)      (list "user"      content))
(define (infer/chat/assistant content) (list "assistant" content))

;; ── schema DSL ─────────────────────────────────────────────────────
(define (s/object . fields)        (cons "object" fields))
(define (s/array element)          (list "array" element))
(define (s/enum . values)          (cons "enum" values))

(define (s/field name type . desc)
  (if (null? desc) (list name type) (list name type (car desc))))

(define (s/field/string  name . rest) (apply s/field (cons name (cons "string"  rest))))
(define (s/field/number  name . rest) (apply s/field (cons name (cons "number"  rest))))
(define (s/field/integer name . rest) (apply s/field (cons name (cons "integer" rest))))
(define (s/field/boolean name . rest) (apply s/field (cons name (cons "boolean" rest))))

(define (s/field/_composite name . rest)
  (cond ((= (length rest) 1) (s/field name (car rest)))
        ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
        (else (error "s/field/composite: expected (name config) or (name desc config)"))))

(define (s/field/object . args) (apply s/field/_composite args))
(define (s/field/array  . args) (apply s/field/_composite args))
(define (s/field/enum   . args) (apply s/field/_composite args))
`;
