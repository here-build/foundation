import "@here.build/plexus/mobx/register";
import {
  createRosettaWrapper,
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  sandboxedEnv,
  schemeToJs,
  Nil,
} from "@here.build/arrival-scheme";
import Handlebars from "handlebars";
import invariant from "tiny-invariant";
import { DerivableEntity, InferString, RunSpend } from "@here.build/arrival-inference";

import type { OnApprovalRequest, ResolveApproval } from "./approval.js";
import type { ChatMessage, Completion, LlmParams, ToolCall, ToolDescriptor } from "@here.build/arrival-inference";

import { type DataEffectResolver } from "./data-effects.js";
import { stableJson } from "./effect-log.js";
import { type EnvPack, type RuntimeAssembler } from "@here.build/arrival-scheme/env";
import type { OnExpose } from "./expose.js";
import { type Loader, type PromptUnit } from "./loader.js";
import { type McpEffectResolver } from "./mcp-effects.js";
// The infer-verb toolkit + agentic driver now live in the env-infer package. Imported for
// internal use (makeCompileInferUnit) and re-exported below for back-compat.
import {
  asLlmModel,
  canonicalizeMessages,
  type InferFn,
  inertMcpResolver,
  nullable,
  runAgenticInfer,
  schemaSlot,
} from "@here.build/arrival-scheme-env-infer";
import type { OnOverridable, ResolveOverride } from "./overridable.js";
import { analyzeTemplate, coerceShape, type TemplateInfo, validateShape } from "./template-analyze.js";
import type { EvalTrace } from "@here.build/arrival-provenance";

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
export function dictKey(k: unknown): string {
  if (typeof k === "function") {
    const field = (k as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(k);
}

/** Fold alternating key/value call args into a dict — the `dict` rosetta body,
 *  reused by the `.prompt` proc to build its `:k v …` kwargs dict at JS level
 *  (so `(run-x key :k v)` folds exactly as the old `(apply dict kv)` did). */
export function buildDict(args: unknown[]): Record<string, unknown> {
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
export function buildInputsProvenance(kv: unknown[], kvProv: readonly ReadonlySet<number>[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (let i = 0; i < kv.length; i += 2) out[dictKey(kv[i])] = [...(kvProv[i + 1] ?? [])];
  return out;
}

/** Canonicalise a `(role content)` message list to the single prompt string used
 *  as a task's content key (the cache/dedup identity). Shared by `infer/chat` and
 *  the `.prompt` proc, so both mint IDENTICAL task keys for the same messages —
 *  the property that keeps a `.prompt` run replayable against the same cache. */
// canonicalizeMessages + parseSchemeChatMessages moved to the env-infer package (imported
// + re-exported at the top of this module).

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
  /** Per-run allocation bound (cumulative list cells materialized through `to_array`) — the memory
   *  analogue of `budgetMs`, catching the native-collection-op runaway the TICK-cadence wall-clock
   *  can't preempt. Undefined ⇒ unbounded. See `arrival-scheme/heap-budget.ts`. */
  heapBudget?: number;
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
export function templateReads(sections: { source: string }[]): Record<string, string[]> {
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
          add(scope, parts.length > 0 ? parts[0]! : null);
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
  if (n?.type !== "PathExpression") return [];
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
  invariant(args.length > 0, "template: expected at least one argument");
  if (args.length === 1) {
    const a = args[0];
    if (isDictLike(a)) return a;
    if (isPrimitiveLike(a)) {
      invariant(
        !!info.singleVarName,
        () =>
          `template: single primitive arg passed to a template with ${info.rootFields.length} fields ` +
          `(${info.rootFields.join(", ")}); either pass a dict, or use alternating keyword/value args`,
      );
      return { [info.singleVarName]: a };
    }
    throw new Error(`template: unsupported single-arg type ${typeName(a)}`);
  }
  // Multi-arg: alternating string-key / value pairs.
  invariant(
    args.length % 2 === 0,
    () => `template: expected even number of args (alternating key/value), got ${args.length}`,
  );
  const fieldSet = new Set(info.rootFields);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (typeof k !== "string") {
      throw new TypeError(`template: key at position ${i} is not a string (got ${typeName(k)})`);
    }
    invariant(
      info.rootFields.length === 0 || fieldSet.has(k),
      () => `template: unknown field "${k}"; template root fields are: ${info.rootFields.join(", ")}`,
    );
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

export function renderTemplateCall(source: string, args: unknown[]): string {
  const tm = compileTemplate(source);
  // Coerce array-shaped fields that arrived nil (empty scheme list) to `[]` before
  // validating, so `{{#each}}` over an empty collection renders nothing rather than
  // tripping the array check — the cross-lang membrane can't make an empty list a
  // JS array on its own (see coerceShape).
  const data = coerceShape(tm.info.shape, resolveTemplateInput(args, tm.info), isNilLike);
  const ok = validateShape(tm.info.shape, data);
  // Not an invariant: the message reads `ok.message`, which only exists once `ok` is narrowed
  // to the error arm — a narrowing the if-guard gives but an invariant thunk can't.
  if (!ok.ok) throw new Error(`template input mismatch: ${ok.message}`);
  return tm.render(data);
}

// nullable + schemaSlot moved to the env-infer package (imported + re-exported above).

/** A `(dict …)` folds to a plain JS record; the `:meta` config slot must be one. */
const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// The InferFn seam type moved to the env-infer package (imported + re-exported above).

// ── tool-enabled inference: identity folding + record/replay shape ─────────────
//
// A tool-enabled inference (the `infer/agentic/end-to-end` per-turn call) keeps the
// SAME cell/effect-log/binding/cache machinery as a plain `(infer …)` — these three
// helpers are the only deltas, all gated on whether tools were passed, so a plain infer
// is byte-for-byte unchanged.

/** Fold the extra inference-identity dimensions (tools + content params) into the cacheKey.
 *  Both CHANGE the completion (a different toolset / a different temperature = a different
 *  result), so folding them into the cacheKey reuses the (model,prompt,schema,cacheKey) key
 *  machinery — cell, effect-log, binding, AND disk cache — with no new key dimension. This
 *  is the SOLE mechanism keeping a content param cache-honest: `keyOf` (infer-store) only
 *  whitelists [model,prompt,schema,cacheKey], so a param NOT folded here would silently
 *  serve a stale completion. Gated to byte-identity: no tools AND no params ⇒ the cacheKey
 *  is returned untouched, so plain `(infer …)` and every existing cache entry are unchanged.
 *  Tools stay an ORDERED array (order is semantically meaningful); params is a record
 *  (`stableJson` sorts its keys, so the same params key identically regardless of literal order). */
export function inferIdentityKey(
  cacheKey: string | null,
  tools?: readonly ToolDescriptor[],
  params?: LlmParams,
): string | null {
  const hasTools = tools !== undefined && tools.length > 0;
  const hasParams = params !== undefined && Object.keys(params).length > 0;
  if (!hasTools && !hasParams) return cacheKey;
  // When only tools are present this is byte-identical to the prior `toolCacheKey`
  // (`{ cacheKey, tools }`), so existing tool-cached entries survive.
  return stableJson({ cacheKey, ...(hasTools ? { tools } : {}), ...(hasParams ? { params } : {}) });
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

// The infer-verb toolkit (asLlmModel / inferThroughChain / BREAK_ON_SINGLE_INFER) and the
// agentic loop driver (runAgenticInfer) moved to `@here.build/arrival-scheme-env-infer`
// (the inference package). Imported + re-exported at the top of this module so existing
// arrival-chain import paths (and makeCompileInferUnit below) keep resolving.

/**
 * Build a sandboxed arrival-chain environment with the standard rosettas —
 * `infer`, `infer/chat`, `json/parse`, `template/handlebars`, plus
 * `require`/`import` — EXCEPT inference resolution, which is injected via `infer`.
 * (`dict` is a native arrival-scheme builtin, inherited via `sandboxedEnv`.)
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
export interface BuildArrivalEnvOpts {
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
  /**
   * Host sink for `(define/overridable …)`. Each declaration registers an
   * {@link OnOverridable} descriptor (name + schema + default). Absent,
   * the form still evaluates and resolves to its default — same optional posture
   * as `onExpose`.
   */
  onOverridable?: OnOverridable;
  /**
   * Host override channel for `define/overridable`: name → externally-supplied
   * value (deployment env / caller args). A matching, schema-valid value
   * replaces the default; absent or invalid ⇒ the default. v1 per-name; a
   * per-key in-program table is deferred.
   */
  resolveOverride?: ResolveOverride;
  /**
   * Receiver for the `require` cache-clearer (see `defineRequireRosetta`). A shared-env
   * host (a notebook kernel) keeps this fn and calls it before each run, so a
   * `(require …)` re-evaluates against the CURRENT overrides + source instead of a value
   * cached at first load. Absent ⇒ the cache persists for the env's life (the one-shot
   * default, where there is no "next run" to stale against).
   */
  onRequireCache?: (clearRequireCache: () => void) => void;
  /**
   * Host sink for `(run/continue-after-approval …)`. Each pending approval is
   * handed over as a {@link FunctionRunApprovalRequest}; a human surfaces it,
   * may edit the proposed value, and flips `approved`/`rejected`. Absent (and
   * `resolveApproval` absent), the request AUTO-APPROVES immediately (local /
   * sandbox: runs never block) — same optional posture as `onExpose`.
   */
  onApprovalRequest?: OnApprovalRequest;
  /**
   * Host hook that decides an approval verdict directly: return `true`/`false`
   * to approve/reject synchronously, `undefined` to leave it to the async
   * channel. When both this and `onApprovalRequest` are absent, requests
   * auto-approve.
   */
  resolveApproval?: ResolveApproval;
  /**
   * Host-armed registry of named extension packs for `(require/extension :name)`. The program reaches
   * a capability by NAME (intent); the host decides what each name resolves to (materialization) —
   * never an `await import()` of a program-named file. Absent ⇒ `require/extension` is unregistered
   * (calling it is an unbound-symbol error, same as any unarmed verb).
   */
  extensionRegistry?: ReadonlyMap<string, EnvPack<ReturnType<typeof sandboxedEnv.inherit>>>;
  /**
   * Receiver for the runtime assembler backing `(require/extension …)` — its `dispose()` tears down
   * any runtime-applied extension's resources. A lifecycle owner (ChainEnvironment) keeps it and
   * folds it into its own `dispose()`. Absent ⇒ runtime extension disposers are not tied to teardown
   * (fine for pure registrar extensions; a resource-allocating one needs the owner to wire this).
   */
  onExtensionAssembler?: (assembler: RuntimeAssembler<ReturnType<typeof sandboxedEnv.inherit>>) => void;
}

/**
 * Seal a `.prompt` PromptUnit into a provenance-point native proc — module-level so the loader-core
 * pack's `apply` stays shallow (the prompt-fn's inner thunks would otherwise nest >4 deep under the
 * pack wrapper). The output schema is evaluated ONCE here (the `s/…` rosettas live on `env`) and
 * slotted exactly as `infer/chat` would. Calling the proc `(run-x key :k v …)` folds the kwargs,
 * renders its sections, and infers AT JS LEVEL — and because it's a `provenancePoint`, ITS OWN
 * call-site invocation becomes the provenance point. So a `.prompt` traces as ONE node at the real
 * `(run-x …)` site with the infer sealed inside it — no unwrapped line-1 `(infer/chat …)` lambda. The
 * task it mints is byte-identical to the equivalent `infer/chat` (shared canonicalize + schemaSlot +
 * nullable), so cache + replay are preserved.
 */
export function makeCompileInferUnit(
  env: ReturnType<typeof sandboxedEnv.inherit>,
  opts: Pick<BuildArrivalEnvOpts, "infer" | "mcp">,
): (unit: PromptUnit) => Promise<unknown> {
  return async (unit: PromptUnit): Promise<unknown> => {
    let schemaSlotStr: string | null = null;
    if (unit.schemaSrc !== null) {
      const [form] = await parse(unit.schemaSrc);
      schemaSlotStr = schemaSlot(schemeToJs(await execExpr(form, { env })));
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
        // frontmatter default, else a hard error (nothing to route to). `meta.model`
        // may be a bare string OR an `(llm …)` entity (so a program can `(define ideator
        // (llm "id"))` and pass `:meta (dict :model ideator)`) — `asLlmModel` extracts the
        // routing name and any `llm/with` content params either way.
        const metaModel = meta.model === undefined ? null : asLlmModel(meta.model);
        const model = metaModel ? metaModel.name : unit.model;
        const metaParams = metaModel?.params;
        invariant(
          model !== null,
          () =>
            `.prompt: "${unit.path}" has no model — set frontmatter \`model:\` or pass \`:meta (dict :model "…")\` at the call site`,
        );
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
          const nodeMeta = {
            kind: "prompt",
            path: unit.path,
            model,
            inputs,
            inputsProvenance,
            reads: templateReads(unit.sections),
          };
          if (typeof inv.setMetadata === "function") inv.setMetadata(nodeMeta);
          else inv.metadata = nodeMeta;
        }
        const messages = unit.sections.map((s) => [s.role, renderTemplateCall(s.source, [inputs])]);
        // `mcp:` frontmatter ⇒ an AGENTIC prompt: list those servers' tools and loop
        // infer↔dispatch through the shared engine, returning the final answer. (Schema'd
        // agentic output isn't supported in v1 — error rather than silently drop the schema.)
        if (unit.mcpServers) {
          invariant(
            schemaSlotStr === null,
            () =>
              `.prompt: "${unit.path}" combines \`mcp:\` (agentic) with \`output:\` (schema) — structured agentic output is not supported in v1`,
          );
          const servers = unit.mcpServers.map((name) => new DerivableEntity("mcp", name));
          const chatMessages: ChatMessage[] = messages.map(([role, content]) => ({
            role: String(role) as ChatMessage["role"],
            content: String(content),
          }));
          return runAgenticInfer(opts.infer, opts.mcp ?? inertMcpResolver, ctx, model, chatMessages, servers);
        }
        return opts.infer(
          ctx,
          model,
          canonicalizeMessages(messages),
          schemaSlotStr,
          nullable(key),
          undefined,
          metaParams,
        );
      },
    });
  };
}

/** The arrival env handle — a sandbox-inherited Environment the packs contribute rosettas to. */
export type ArrivalEnv = ReturnType<typeof sandboxedEnv.inherit>;

// inferList moved to the env-infer package (imported + re-exported above).

// ── shared rosetta-coercion helpers ───────────────────────────────────────────
// isPlainRecord stays here (a `(dict …)` helper, not an infer-verb coercion).
export { isPlainRecord };

// InferFn is the one relocated symbol consumed outside arrival-chain (host's run-traced
// imports it from the chain barrel). Re-exported so project.ts's `export *` keeps surfacing
// it. The rest of the toolkit stays internal — chain only imports what makeCompileInferUnit
// uses, and that whole reach goes away when the `.prompt` seal moves into env-infer.
export type { InferFn };
