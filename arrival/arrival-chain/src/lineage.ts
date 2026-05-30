/**
 * Programmatic lineage queries — PAPER SKETCH.
 *
 * Three public functions, all pure async, all node-testable, no web APIs.
 * The whole module can later be moved to a worker without touching its
 * call sites.
 *
 *   recordSession(config)              → TraceSession
 *   inferencesAt(session, line, col)   → InferenceCallSite[]
 *   traceForOutput(session, site, out) → CodeTrace
 *
 * All implementations throw "paper sketch — not implemented." The types
 * are the design; the .spec.ts file exercises the contract.
 */

import { lipsToJs, type Pair } from "@here.build/arrival-scheme";
import { reaction } from "mobx";

import { ArrivalChain } from "./arrival-chain.js";
import { ArrivalCache, InferenceCache } from "./cache.js";
import { Project } from "./project.js";
import { InferenceError, InferenceResult, type InferenceTask } from "./task.js";
import { EvalTrace, Invocation } from "./trace.js";
import type { ModelRouter } from "./registry.js";
import { startOrchestrator } from "./worker.js";

// ════════════════════════════════════════════════════════════════════
// PUBLIC SURFACE — the three functions everything else exists to serve.
// ════════════════════════════════════════════════════════════════════

/**
 * Configuration = everything required to run the program deterministically.
 * Conceptually the same shape `runPipeline` already takes.
 */
export interface TraceConfig {
  files: Readonly<Record<string, string>>;
  entry: string;
  /**
   * Model-id → backend lookup. Pass a stub for tests via `singletonRouter`,
   * a `StaticRouter({ "gpt-4o-mini": ..., "claude-3-5-sonnet": ... })` for
   * explicit mapping, or any other `ModelRouter` impl.
   */
  router: ModelRouter;
}

/**
 * One recorded execution of `config`. The session is a snapshot:
 * pure data describing what happened, ready to be queried.
 *
 * Sessions are cacheable by (programHash, envHash, configHash); two
 * runs of an identical config produce identical sessions (modulo backend
 * non-determinism, which we expect to be content-addressed-and-stable).
 */
export interface TraceSession {
  version: PathVersion;
  /** Every inference call that fired, with its site, path, and result. */
  inferences: readonly InferenceCallSite[];
  /**
   * Internal: choice-point cache populated during recording. Reused by
   * `traceForOutput` when it needs to blindfold-replay a particular path
   * to materialise args. Not part of the public contract; held opaquely.
   */
  readonly cache: PathCache;
  /** Internal: program source (the entry file), needed for replay. */
  readonly programSource: string;
  /**
   * Internal: the EvalTrace from recording — has every invocation's parent,
   * node, and resolved value. traceForOutput walks it instead of blindfold-
   * replaying in v1 (we already have all the data we need; only iteration-
   * element classification of free symbols requires extra machinery, which
   * is deferred to a follow-up).
   */
  readonly trace: EvalTrace;
  /** Internal: the per-site invocation, indexed by taskId. */
  readonly invByTaskId: ReadonlyMap<string, Invocation>;
}

/** A specific inference call in a specific run. */
export interface InferenceCallSite {
  /** Stable source coordinate (programHash + line + col). */
  ast: AstRef;
  /** Tier + concrete model used. */
  model: { tier: string; concrete: string };
  /** Prompt as the backend saw it. For infer/chat this is the canonical
   *  JSON-stringified message list (matching project.ts upsertTask key). */
  prompt: string;
  schema: string | null;
  /** Cache key (the 4th arg to infer / 5th arg to infer/chat). */
  cacheKey: string | null;
  /** Result, separately resolved or rejected (the backend may have errored). */
  result: SiteResult;
  /** The DNF path that led from program-entry to this call. */
  path: DNFPath;
  /** The InferenceTask id this site resolved to. Multiple sites may
   *  share a task via content-addressed cache merge. */
  taskId: string;
}

export type SiteResult = { kind: "value"; value: unknown } | { kind: "error"; message: string };

/**
 * Query A. Every inference call fired at (line, col) on the entry program.
 * Multiple calls hit when a form is inside a loop / parallel fan-out.
 *
 *   - Pure function of `session`. No replay, just a filter over recorded calls.
 *   - Cheap (linear in #inferences, typical N ≈ 3000).
 */
export function inferencesAt(session: TraceSession, line: number, col: number): readonly InferenceCallSite[] {
  return session.inferences.filter((s) => s.ast.line === line && s.ast.col === col);
}

/**
 * Query B. The code trace that led `site` to produce `site.result`.
 *
 *   - Sites are first-class — distinct sites that share a task (content-
 *     addressed cache merge) have distinct paths and distinct lineage.
 *   - Implementation: blindfold-replay along `site.path` with arg capture
 *     enabled. Walks captures into a `CodeTrace` tree.
 *   - Bounded by path length, not by execution size. Typical: ~20 segments.
 *   - If `site.result.kind === "error"`, the trace still walks the inputs
 *     up to the error point.
 */
export async function traceForOutput(session: TraceSession, site: InferenceCallSite): Promise<CodeTrace> {
  if (site.ast.programHash !== session.version.programHash) {
    throw new Error(
      `traceForOutput: site is from a different program ` +
        `(site=${site.ast.programHash}, session=${session.version.programHash})`,
    );
  }

  const inv = session.invByTaskId.get(site.taskId);
  if (!inv) {
    throw new Error(`traceForOutput: site has no invocation in this session (taskId=${site.taskId})`);
  }

  // (infer tier prompt schema? cacheKey?) — the prompt is the 2nd arg.
  // Walk the AST .cdr.cdr.car to land on the prompt expression.
  const inferPair = inv.node as unknown as PairLike;
  const tierCdr = inferPair.cdr;
  if (!isPair(tierCdr)) {
    return { site, args: [] };
  }
  const promptCdr = tierCdr.cdr;
  if (!isPair(promptCdr)) {
    return { site, args: [] };
  }
  const promptAst = promptCdr.car;

  const childIdx = childrenIndexOf(session.trace);
  const promptNode = buildTraceNode(promptAst, inv, session.version.programHash, session.trace, childIdx);
  return { site, args: [promptNode] };
}

/**
 * Recursively build a TraceNode from an AST node.
 *
 * - Atom (string/number/boolean): `{ kind: "literal" }`.
 * - Pair with __location__: find the child invocation under `parentInv` whose
 *   node === this pair, recurse on its inputs. `{ kind: "call", ast }`.
 * - SchemeSymbol: look up the resolved value via the trace's per-invocation
 *   symbol map, then classify origin:
 *     - `iteration-element` if the symbol is a HOF lambda parameter (walks
 *       up the parent chain to find map/filter/for-each/find, matches the
 *       symbol against the HOF lambda's __params__).
 *     - `env-read` if the symbol resolves via `project/<…>` fallback.
 *     - `literal` otherwise (free symbol, captured value, unknown binding).
 */
/**
 * Unwrap Scheme wrapper objects to JS primitives. Defers to arrival-scheme's
 * canonical `lipsToJs` so SchemeString, SchemeNumeric, Pair-as-list,
 * SchemeJSObject all round-trip correctly — a hand-rolled unwrapper would
 * leak wrapper types through to consumers comparing values structurally.
 */
function jsValueOf(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (typeof v !== "object" && typeof v !== "function") return v;
  return lipsToJs(v, {});
}

function buildTraceNode(
  ast: unknown,
  parentInv: Invocation,
  programHash: string,
  trace: EvalTrace,
  childIdx: Map<Invocation, Invocation[]>,
): TraceNode {
  if (typeof ast === "string" || typeof ast === "number" || typeof ast === "boolean") {
    return { value: ast, origin: { kind: "literal" }, inputs: [] };
  }
  // SchemeString wraps string literals; surface the underlying value.
  if (ast && typeof ast === "object" && "__string__" in ast) {
    return { value: jsValueOf(ast), origin: { kind: "literal" }, inputs: [] };
  }
  if (isPair(ast)) {
    const childInv = findChildInvByNode(parentInv, ast, childIdx);
    if (!childInv) {
      // Macro-expanded or untraced — treat as literal at this depth.
      return { value: undefined, origin: { kind: "literal" }, inputs: [] };
    }
    const loc = locationOf(ast as unknown as object);
    const origin: TraceOrigin = loc
      ? { kind: "call", ast: { programHash, line: loc.line, col: loc.col } }
      : { kind: "literal" };
    const inputs: TraceNode[] = [];
    let cur: unknown = ast.cdr;
    while (isPair(cur)) {
      inputs.push(buildTraceNode(cur.car, childInv, programHash, trace, childIdx));
      cur = cur.cdr;
    }
    return { value: jsValueOf(childInv.value), origin, inputs };
  }
  if (ast && typeof ast === "object" && "__name__" in ast) {
    const rawName = (ast as { __name__: unknown }).__name__;
    const symbolName = typeof rawName === "string" ? rawName : undefined;
    const value = symbolName ? jsValueOf(trace.symbolValueIn(parentInv, symbolName)) : undefined;
    const origin = symbolName
      ? classifySymbolOrigin(symbolName, parentInv, programHash, trace, childIdx)
      : { kind: "literal" as const };
    return { value, origin, inputs: [] };
  }
  return { value: undefined, origin: { kind: "literal" }, inputs: [] };
}

function findChildInvByNode(
  parent: Invocation,
  node: unknown,
  childIdx: Map<Invocation, Invocation[]>,
): Invocation | null {
  const children = childIdx.get(parent);
  if (!children) return null;
  for (const c of children) {
    if (c.node === node) return c;
  }
  return null;
}

/**
 * Classify a symbol reference's origin. Walks the parent invocation chain
 * looking for a HOF (map/filter/for-each/find) whose lambda first-parameter
 * matches the symbol — when found, returns iteration-element. Falls back to
 * env-read for `project/<…>` symbols, else literal.
 */
function classifySymbolOrigin(
  symbolName: string,
  parentInv: Invocation,
  programHash: string,
  trace: EvalTrace,
  childIdx: Map<Invocation, Invocation[]>,
): TraceOrigin {
  let walker: Invocation | null = parentInv;
  while (walker) {
    const head = headSymbolName(walker.node);
    if (head === "map" || head === "filter" || head === "for-each" || head === "find") {
      const argsCdr = (walker.node as unknown as PairLike).cdr;
      if (isPair(argsCdr)) {
        const lambdaArg = argsCdr.car;
        const lambdaFn = resolveLambdaArg(lambdaArg, walker, trace, childIdx);
        // lambdaFn is a JS function — typeof returns "function" not "object".
        const params =
          lambdaFn && (typeof lambdaFn === "object" || typeof lambdaFn === "function")
            ? (lambdaFn as { __params__?: readonly string[] }).__params__
            : undefined;
        if (params && params.length > 0 && params[0] === symbolName) {
          const child = findDirectChildOfInChain(parentInv, walker);
          const sibs = childIdx.get(walker);
          const index = sibs && child ? sibs.indexOf(child) : -1;
          const hofLoc = locationOf(walker.node);
          if (hofLoc && index >= 0) {
            return {
              kind: "iteration-element",
              sourcePath: { programHash, line: hofLoc.line, col: hofLoc.col },
              index,
            };
          }
        }
      }
    }
    walker = walker.parent;
  }
  // Config-as-code: `config/<name>` references are ordinary spilled bindings
  // (from `(require "config.scm")`), so they classify as `literal` like any
  // other free symbol resolving to a captured value — there is no env-resolver
  // fallback to detect anymore. (The `env-read` TraceOrigin variant is retained
  // for back-compat with any external consumer but is no longer produced.)
  return { kind: "literal" };
}

/**
 * Resolve a lambda-or-symbol arg to its function value.
 *
 *   - SchemeSymbol: look up via the trace's per-invocation symbol map
 *     (captured by onSymbolResolved when evaluateArgs evaluated the symbol).
 *   - Pair (inline `(lambda …)` form): the (lambda …) Pair has a child
 *     invocation under the HOF whose `.value` is the constructed lambda
 *     function. Walk the HOF's children index.
 */
function resolveLambdaArg(
  arg: unknown,
  parentInv: Invocation,
  trace: EvalTrace,
  childIdx: Map<Invocation, Invocation[]>,
): unknown {
  if (arg && typeof arg === "object" && "__name__" in arg) {
    const name = (arg as { __name__: unknown }).__name__;
    if (typeof name === "string") return trace.symbolValueIn(parentInv, name);
  }
  if (isPair(arg)) {
    // Inline lambda: find the child invocation of the HOF whose node is this Pair.
    const sibs = childIdx.get(parentInv);
    if (sibs) {
      for (const c of sibs) {
        if (c.node === arg) return c.value;
      }
    }
  }
  return null;
}

/** Walk from `leaf` toward the root and return the direct child of `target` along the way. */
function findDirectChildOfInChain(leaf: Invocation, target: Invocation): Invocation | null {
  let cur: Invocation | null = leaf;
  while (cur) {
    if (cur.parent === target) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Record a session by running the program. The session is fully reusable —
 * subsequent queries don't re-run the program.
 *
 *   - Pure async function. No global state. Identical config → identical
 *     session (modulo backend non-determinism).
 *   - Step 2 implementation: paths come back EMPTY. DNF reconstruction
 *     lands in step 3 (task #73). The site shape, ast-coord lookup, and
 *     task-to-site fan-out work today.
 */
export async function recordSession(config: TraceConfig): Promise<TraceSession> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
  project.bindCache(cache);

  for (const [path, content] of Object.entries(config.files)) {
    project.addFile(path, content);
  }

  const entryFile = project.files.get(config.entry);
  if (!entryFile) throw new Error(`recordSession: entry "${config.entry}" not in files`);
  const source = entryFile.versions.at(-1)?.source ?? "";
  const programHash = programHashOf(source);

  const trace = new EvalTrace();
  const ac = new AbortController();
  const orch = startOrchestrator({ cache, router: config.router, signal: ac.signal });
  const draining = orch.done;

  // Swallow program-eval errors so a recordSession over a program that
  // raises (e.g., backend throws mid-run) still returns a partial session
  // with whatever sites were produced. Each task carries its own
  // resolved/rejected state on `result` — the per-site error markers come
  // from there. We log via the trace's existing channels; the caller can
  // inspect `inferences[].result.kind === "error"`.
  try {
    const { finished } = await project.runTraced(source, { trace });
    try {
      await finished;
    } catch {
      // Eval-time error: program rejected. Sites observed before the throw
      // are still on the trace; tasks that errored have InferenceError
      // results. recordSession returns the partial session.
    }
  } finally {
    ac.abort();
    await draining;
  }

  // Build sites from tasks-with-invocations. The trace's invocationByTask
  // is a WeakMap (not iterable); we enumerate project.tasks and look up
  // bindings, which yields one site per task that this run touched.
  // Path reconstruction: classify each parent in the invocation chain by
  // its head symbol, emit a DNFEntry where applicable.
  const idx = childrenIndexOf(trace);
  const inferences: InferenceCallSite[] = [];
  const invByTaskId = new Map<string, Invocation>();
  for (const task of cache.tasks.values()) {
    const invs = trace.invocationsFor(task);
    if (invs.length === 0) continue;
    const result: SiteResult =
      task.result instanceof InferenceResult
        ? { kind: "value", value: task.result.value }
        : task.result instanceof InferenceError
          ? { kind: "error", message: task.result.message }
          : { kind: "error", message: "task did not resolve before recordSession returned" };
    const taskId = taskIdOf(task);
    // Map taskId → canonical (first) invocation for traceForOutput.
    invByTaskId.set(taskId, invs[0]!);
    // Emit one site per invocation — same task can have many sites when
    // the same prompt fires from different HOF iterations.
    for (const inv of invs) {
      const loc = locationOf(inv.node);
      if (!loc) continue;
      inferences.push({
        ast: { programHash, line: loc.line, col: loc.col },
        // Under the new model, the task.model string IS the concrete model id
        // — no tier indirection. Keep the same shape for downstream consumers
        // (they get `concrete` directly; `tier` is the same string for now).
        model: { tier: task.model, concrete: task.model },
        prompt: task.prompt,
        schema: task.schema,
        cacheKey: task.cacheKey,
        result,
        path: pathFromInvocation(inv, programHash, idx),
        taskId,
      });
    }
  }

  return {
    version: { programHash, filesHash: filesHashOf(sourcesByPath(project), { exclude: config.entry }) },
    inferences,
    cache: createPathCache(),
    programSource: source,
    trace,
    invByTaskId,
  };
}

/**
 * Project a Project's VFS into a plain `path → latest-source` map — the input
 * shape `filesHashOf` and the cache-invalidation reaction both consume. Reads
 * each Program's latest version source (the form `require` would load).
 */
function sourcesByPath(project: { files: ReadonlyMap<string, { versions: ReadonlyArray<{ source: string }> }> }): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, program] of project.files) {
    out.set(path, program.versions.at(-1)?.source ?? "");
  }
  return out;
}

/** Pull __location__ off a Pair without exposing the symbol-key dance. */
function locationOf(pair: object): { line: number; col: number } | null {
  for (const s of Object.getOwnPropertySymbols(pair)) {
    if (s.description === "__location__") {
      return (pair as Record<symbol, unknown>)[s] as { line: number; col: number };
    }
  }
  return null;
}

/**
 * Stable id for a task. The underlying Project.tasks Map is keyed by the
 * (model, prompt, schema, cacheKey) tuple — we synthesise a string id from
 * the same components so sites can reference tasks even after the project
 * is gone.
 */
function taskIdOf(task: InferenceTask): string {
  return `${task.model} ${task.prompt} ${task.schema ?? ""} ${task.cacheKey ?? ""}`;
}

// ════════════════════════════════════════════════════════════════════
// PATH CACHE — step 4
// ════════════════════════════════════════════════════════════════════
//
// Key = serialised DNFPath prefix. Map-based with LRU eviction (Maps
// preserve insertion order; on hit, delete + reinsert moves to MRU end;
// on overflow, drop the oldest until under cap). Optional hit/miss
// counters for the path-cache benchmark.
//
// The cache is per-(programHash, envHash) by convention — recordSession
// owns one, and the session's `version` carries the matching hashes.
// Invalidation is wholesale: programHash mismatch happens at a higher
// layer (new recordSession), envHash mismatch is handled by the optional
// mobx-reaction binding (bindCacheToProjectEnv). See ADR 0019 §"Cache
// invalidation".

/**
 * Serialise a DNF path prefix into a deterministic cache key.
 * Format: pipe-separated entries; per-entry `kind:line:col:detail`.
 * detail = arm | index | fnHash, depending on kind.
 * (programHash omitted — it's invariant for the cache's lifetime.)
 */
export function serializePrefix(prefix: DNFPath): string {
  return prefix.map(serializeEntry).join("|");
}

function serializeEntry(e: DNFEntry): string {
  switch (e.kind) {
    case "branch":
      return `b:${e.point.line}:${e.point.col}:${e.arm}`;
    case "iterate":
      return `i:${e.point.line}:${e.point.col}:${e.index}`;
    case "fold-step":
      return `f:${e.point.line}:${e.point.col}:${e.index}`;
    case "dispatch":
      return `d:${e.point.line}:${e.point.col}:${e.fnHash}`;
  }
}

class MapPathCache implements PathCache {
  readonly #entries = new Map<string, PathCacheEntry>();
  readonly #capacity: number;
  #hits = 0;
  #misses = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get(prefix: DNFPath): PathCacheEntry | undefined {
    const key = serializePrefix(prefix);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses++;
      return undefined;
    }
    // LRU: move to end on hit.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits++;
    return entry;
  }

  set(prefix: DNFPath, entry: PathCacheEntry): void {
    const key = serializePrefix(prefix);
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  size(): number {
    return this.#entries.size;
  }

  get hits(): number {
    return this.#hits;
  }
  get misses(): number {
    return this.#misses;
  }
}

/**
 * Create a PathCache with the given capacity (defaults to 50_000 entries —
 * ADR 0019 budgets ~10k choice points at ~800B each ≈ 8MB; LRU keeps a
 * 5× headroom before eviction kicks in).
 */
export function createPathCache(capacity = 50_000): PathCache {
  return new MapPathCache(capacity);
}

/**
 * Wire a cache to a project's files so the cache clears when any file mutates.
 * Returns a disposer; call it to detach the reaction. Use this when the cache
 * outlives a single recordSession and shares lifetime with a live project
 * (e.g., monitor-chain UI editing flow).
 *
 * Config-as-code: per-run knobs live in a `config.scm` file the entry
 * requires, so the cache-relevant project state IS the file set. Editing a
 * file (config or otherwise), adding one, or publishing a new version shifts
 * `filesHashOf` and clears the cache — the same wholesale invalidation the
 * env-mutation reaction used to provide.
 *
 * recordSession does NOT call this — its project is ephemeral and its files
 * are frozen for the session's lifetime.
 */
export function bindCacheToProjectFiles(
  cache: PathCache,
  project: { files: ReadonlyMap<string, { versions: ReadonlyArray<{ source: string }> }> },
): () => void {
  return reaction(
    () => filesHashOf(sourcesByPath(project)),
    () => cache.clear(),
  );
}

// ════════════════════════════════════════════════════════════════════
// RETURN SHAPES — what queries hand back
// ════════════════════════════════════════════════════════════════════

/**
 * The lineage tree for one inference output. Each node has an origin
 * (where its value came from) and inputs (the values that fed in).
 *
 * Pure-chain segments between meaningful producers fold into a single
 * edge with `collapsedChain` populated for the UI's "expand" affordance.
 */
export interface CodeTrace {
  /** The inference call this trace is rooted at. */
  site: InferenceCallSite;
  /** Per-argument lineage. */
  args: readonly TraceNode[];
}

export interface TraceNode {
  value: unknown;
  origin: TraceOrigin;
  /** Args that fed into `origin`, when origin is a call. */
  inputs: readonly TraceNode[];
  /** Pure-chain collapse: AST refs of intermediate transformations skipped in the inputs walk. */
  collapsedChain?: readonly AstRef[];
}

export type TraceOrigin =
  | { kind: "literal" } // (e.g. "fast", 0.5)
  | { kind: "env-read"; path: readonly string[] } // project/<name>
  | { kind: "call"; ast: AstRef } // (foo a b)
  | { kind: "inference"; site: InferenceCallSite } // value was produced by another infer call
  | { kind: "iteration-element"; sourcePath: AstRef; index: number }; // element drawn from a list at runtime

// ════════════════════════════════════════════════════════════════════
// INTERNAL SCAFFOLDING — types the public functions need, hidden from
// consumers but exported for tests / introspection.
// ════════════════════════════════════════════════════════════════════

/**
 * Stable cross-run reference to an AST node. We can't use the live Pair —
 * it's a fresh object on every parse. (programHash, line, col) is the
 * stable identity.
 */
export interface AstRef {
  programHash: string;
  line: number;
  col: number;
}

/** One step along the recorded execution path. Emitted only at choice points. */
export type DNFEntry =
  | { kind: "branch"; point: AstRef; arm: number }
  | { kind: "iterate"; point: AstRef; index: number }
  | { kind: "fold-step"; point: AstRef; index: number }
  | { kind: "dispatch"; point: AstRef; fnHash: string };

export type DNFPath = readonly DNFEntry[];

export interface PathVersion {
  programHash: string;
  /** Hash over the non-entry files (config-as-code + data) the entry requires. */
  filesHash: string;
}

/**
 * DNF cache. Keyed by (program, env, prefix); invalidated wholesale on
 * env or program change via a mobx reaction on the project.env map.
 */
export interface PathCache {
  get(prefix: DNFPath): PathCacheEntry | undefined;
  set(prefix: DNFPath, entry: PathCacheEntry): void;
  clear(): void;
  size(): number;
}

export interface PathCacheEntry {
  value: unknown;
  /** Tasks created by the segment leading to this prefix (by id). */
  tasksCreated: readonly string[];
}

/** Choice-point emitter — sits next to existing EvalTap on arrival-scheme. */
export interface DNFTap {
  onBranch(point: Pair, arm: number): void;
  onIterate(point: Pair, index: number): void;
  onFoldStep(point: Pair, index: number): void;
  onDispatch(point: Pair, fnHash: string): void;
}

// ════════════════════════════════════════════════════════════════════
// HASH UTILITIES — implemented (step 1)
// ════════════════════════════════════════════════════════════════════
//
// FNV-1a is sufficient: content-addressing equality (did this change?),
// not cryptographic strength. 32-bit output, ~3000 hashes per session,
// collision probability ≈ 1 in 2^16 ≈ 0.001%. Sync, dep-free, portable.

function fnv1a(input: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable across runs of identical source; differs on any text edit. */
export function programHashOf(source: string): string {
  return fnv1a(source);
}

/**
 * Hash over the project's files (config-as-code: config + data live in the VFS,
 * not in a separate env map). Deterministic across iteration order — entries
 * sorted by path. `exclude` drops one path (the entry program, whose source is
 * already captured by `programHash`) so the two version axes stay orthogonal:
 * `programHash` = the entry, `filesHash` = everything it requires.
 */
export function filesHashOf(
  sourcesByPath: ReadonlyMap<string, string>,
  opts: { exclude?: string } = {},
): string {
  const entries: Array<readonly [string, string]> = [];
  for (const [path, source] of sourcesByPath) {
    if (path === opts.exclude) continue;
    entries.push([path, source] as const);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return fnv1a(JSON.stringify(entries));
}

/**
 * Dispatch identity for a lambda. Stable across runs of the same program
 * via (programHash, line, col). Macro-expanded lambdas without
 * __location__ fall back to a sentinel — replay through them is best
 * effort (see L1, L4 in REVIEW FINDINGS).
 */
export function fnHashOf(lambda: Pair, programHash: string): string {
  const loc = locationOf(lambda as unknown as object);
  if (loc) return `${programHash}@${loc.line}:${loc.col}`;
  return `${programHash}@anon`;
}

// ════════════════════════════════════════════════════════════════════
// PATH RECONSTRUCTION — step 3 (C2 from REVIEW FINDINGS)
// ════════════════════════════════════════════════════════════════════
//
// Approach: classify each invocation by its parent's head symbol. For
// each parent in the chain that's a choice-point form, emit a DNFEntry.
// Plain function calls (head is a non-special symbol) contribute nothing.
//
// Coverage in step 3 (works in conjunction with C1a — see L6):
//   if / when / unless          → branch (which arm fired)
//   map / for-each / find       → iterate (position among parent's children)
//   and / or                    → branch (short-circuit position)
//
// Deferred (G7/L4 in REVIEW FINDINGS):
//   cond / case                 → multi-clause, needs clause-pair walking
//   filter                      → input-index requires recorded survivors
//   reduce / fold               → replay-prefix semantics
//   dispatch (anon lambdas)     → fnHash requires extra eval-side tap

interface PairLike {
  car: unknown;
  cdr: unknown;
}

function isPair(x: unknown): x is PairLike {
  return typeof x === "object" && x !== null && "car" in x && "cdr" in x;
}

function headSymbolName(node: unknown): string | null {
  if (!isPair(node)) return null;
  const head = node.car;
  if (head && typeof head === "object" && "__name__" in head) {
    const n = (head as { __name__: unknown }).__name__;
    return typeof n === "string" ? n : null;
  }
  return null;
}

/** Pre-build parent → children-sorted-by-id index for fast classification. */
function childrenIndexOf(trace: EvalTrace): Map<Invocation, Invocation[]> {
  const map = new Map<Invocation, Invocation[]>();
  for (const record of trace.records.values()) {
    for (const inv of record.bindings) {
      if (!inv.parent) continue;
      const list = map.get(inv.parent);
      if (list) list.push(inv);
      else map.set(inv.parent, [inv]);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.id - b.id);
  return map;
}

/** Position of `child` among invocations sharing the same parent (sorted by id). */
function positionAmongSiblings(child: Invocation, parent: Invocation, idx: Map<Invocation, Invocation[]>): number {
  const sibs = idx.get(parent);
  if (!sibs) return -1;
  return sibs.indexOf(child);
}

/**
 * Walk the if's structure to find which arm `child.node` corresponds to.
 *   (if test then else) — test is .cdr.car, then is .cdr.cdr.car, else is .cdr.cdr.cdr.car
 *   (when test body...) — body forms are .cdr.cdr.car onward; only fires the body
 *   (unless test body...) — same as when, complementary semantics
 *
 * Returns arm (0=then/taken, 1=else/skipped), or null if child is the test
 * eval (not a choice — bookkeeping) or we can't tell (e.g., literal arm
 * that didn't fire its own Pair invocation).
 */
function ifLikeArm(child: Invocation, parent: Invocation, head: string): number | null {
  const node = parent.node as unknown as PairLike;
  if (!isPair(node.cdr)) return null;
  const testPair = node.cdr.car;
  if (child.node === testPair) return null; // test eval, not a choice

  if (head === "if") {
    if (!isPair(node.cdr.cdr)) return null;
    const thenPair = node.cdr.cdr.car;
    if (child.node === thenPair) return 0;
    if (isPair(node.cdr.cdr.cdr) && child.node === node.cdr.cdr.cdr.car) return 1;
    return null;
  }
  // when / unless: body is everything after the test. If child is anywhere
  // in that body's first form, treat as arm 0 (body fired).
  if (head === "when" || head === "unless") {
    if (!isPair(node.cdr.cdr)) return null;
    const bodyFirst = node.cdr.cdr.car;
    if (child.node === bodyFirst) return 0;
    return null;
  }
  return null;
}

/**
 * For (and a b c) / (or a b c) walk the variadic chain: the i-th form is
 * .cdr...cdr.car at depth i+1 from head. Return the position where our
 * chain entered; that's the arm the short-circuit landed on.
 */
function shortCircuitPosition(child: Invocation, parent: Invocation): number | null {
  let node: unknown = (parent.node as unknown as PairLike).cdr;
  let i = 0;
  while (isPair(node)) {
    if (child.node === node.car) return i;
    node = node.cdr;
    i++;
  }
  return null;
}

function astRefFor(programHash: string, node: object): AstRef | null {
  const loc = locationOf(node);
  if (!loc) return null;
  return { programHash, line: loc.line, col: loc.col };
}

function classifyChoice(
  child: Invocation,
  parent: Invocation,
  programHash: string,
  idx: Map<Invocation, Invocation[]>,
): DNFEntry | null {
  const head = headSymbolName(parent.node);
  if (head === null) return null;
  const point = astRefFor(programHash, parent.node as unknown as object);
  if (!point) return null;

  switch (head) {
    case "if":
    case "when":
    case "unless": {
      const arm = ifLikeArm(child, parent, head);
      return arm === null ? null : { kind: "branch", point, arm };
    }
    case "and":
    case "or": {
      const pos = shortCircuitPosition(child, parent);
      return pos === null ? null : { kind: "branch", point, arm: pos };
    }
    case "map":
    case "for-each":
    case "find": {
      // Iteration index = position among parent's children. For single-form
      // lambda bodies this equals the iteration; multi-form bodies count
      // each form as one step (acceptable for v1 — index disambiguates
      // distinct iterations, exact value not load-bearing).
      const pos = positionAmongSiblings(child, parent, idx);
      return pos < 0 ? null : { kind: "iterate", point, index: pos };
    }
    // cond / case / reduce / filter: TODO (see header comment)
    default:
      return null;
  }
}

/** Walk parent chain leaf→root and emit DNF entries; result is root→leaf order. */
function pathFromInvocation(inv: Invocation, programHash: string, idx: Map<Invocation, Invocation[]>): DNFPath {
  const out: DNFEntry[] = [];
  let cur: Invocation | null = inv;
  while (cur && cur.parent) {
    const entry = classifyChoice(cur, cur.parent, programHash, idx);
    if (entry) out.unshift(entry);
    cur = cur.parent;
  }
  return out;
}

/** Debug: dump the head-symbol chain of an invocation, root→leaf. */
export function debugChainOf(inv: Invocation): Array<{ head: string | null; line: number; col: number }> {
  const chain: Array<{ head: string | null; line: number; col: number }> = [];
  let cur: Invocation | null = inv;
  while (cur) {
    const loc = locationOf(cur.node as unknown as object);
    chain.unshift({
      head: headSymbolName(cur.node),
      line: loc?.line ?? -1,
      col: loc?.col ?? -1,
    });
    cur = cur.parent;
  }
  return chain;
}

// ════════════════════════════════════════════════════════════════════
// WHAT BREAKS — issues that surfaced sketching the surface
// ════════════════════════════════════════════════════════════════════
//
// 1. Output disambiguation when content-addressed cache merges sites.
//    `(infer "fast" "hello")` called from two call sites both resolve to
//    the same task (same prompt, same model). traceForOutput needs to
//    know which call site to start from — passing the InferenceCallSite
//    object (not just the task) gives us that, but the user clicked a
//    value, and the value is held by the task. Need: InferenceCallSite[]
//    keyed by (line, col) from inferencesAt, then user picks one.
//
// 2. Output identity for non-primitive results.
//    `output: unknown` — for strings/numbers, value equality. For dicts/
//    arrays, the InferenceTask's `value` getter returns a fresh
//    JSON-parsed object each call. Comparing by reference fails. We need
//    structural equality, or — easier — pass `task.id` (or its valueJson
//    string) as the disambiguator instead of the live value.
//
// 3. recordSession ↔ existing runPipeline.
//    runPipeline returns the program's result, not a session. recordSession
//    needs to also expose the trace + paths. Either: (a) recordSession is
//    a parallel entry point that uses Project.runTraced internally; (b)
//    runPipeline grows an opt-in `recordPaths: true` flag. (a) is cleaner.
//
// 4. AST stability across re-record.
//    AstRef = (programHash, line, col). If the user edits the program
//    between record and query, programHash changes and the session is
//    stale. recordSession would need to be re-run. That's expected — the
//    session is bound to a specific (program, env) snapshot. The query
//    functions validate version on every call.
//
// 5. Backend determinism inside recordSession.
//    For tests, backends are stubs — fully deterministic. For live runs
//    via LM Studio / Anthropic, the same (prompt, model) tuple SHOULD
//    return the same result because of our content-addressed cache; but
//    the FIRST run uses a non-deterministic LM. The recording semantics
//    are: "this is what the LM said this time." Re-recording on a
//    different day might capture different inference outputs. Sessions
//    are not idempotent across non-cached LM calls.
//
// 6. Worker offload friction.
//    The whole module is pure data + async. To run in a worker we ship
//    the config, the worker calls recordSession, returns the session.
//    Two snags: (a) `backends: ModelBackend` — closures over network
//    state aren't serialisable across the worker boundary. Solution:
//    `backends` in the worker config is a registry name; worker
//    instantiates the real backend by name. (b) The cache lives on the
//    session; if the worker hands the session back to the main thread,
//    the cache must serialise. PathCache as `Map<string, PathCacheEntry>`
//    serialises fine.
//
// 7. traceForOutput on a session from a different program.
//    `site.ast.programHash` mismatching `session.version.programHash` is
//    a bug. Functions should guard with a clear error: "site is from
//    program X, session is from program Y."
//
// 8. The "where did this value come from inside (map f xs)" question.
//    If the inference call is inside `(map (lambda (p) (infer p)) personas)`,
//    the path includes `iterate i` for some i. The trace's `args[0]` (the
//    persona) is element i of `personas`. Origin: `{ kind: "iteration-element",
//    sourcePath: ast-of-personas, index: i }`. The UI then traces the
//    sourcePath recursively. That kind already in TraceOrigin; just
//    flagging it as the critical case for our actual programs.
//
// 9. recordSession cost vs subsequent query cost.
//    First call: full program eval. ~seconds for 100k invocations against
//    LM Studio. Subsequent queries: in-memory walks, ~ms. The session is
//    the cache-warm artifact. If a worker holds the session, the main
//    thread does only ms-cost queries.
//
// 10. Choice-point granularity — open design call.
//     Sketch lists 4 kinds: branch / iterate / fold-step / dispatch.
//     Real evaluator has more nuance — `(case ...)`, `(when ...)`,
//     `(unless ...)`, lambda destructuring of varargs, named-let recursive
//     calls. Most fold cleanly into the 4 kinds; some (named-let recursion)
//     are technically dispatches but feel like branches semantically. Need
//     to pick a model and stick with it; mismatched kinds break the
//     replay-evaluator's case analysis.
//
// ════════════════════════════════════════════════════════════════════
// REVIEW FINDINGS — design adjustments after pre-impl inconsistency review
// (background agent run 2026-05-21)
// ════════════════════════════════════════════════════════════════════
//
// The review surfaced issues across types/spec, missing coverage, and
// cross-references to the existing codebase. Captured here so the
// implementation lands with them in mind.
//
// CRITICAL — changes the contract:
//
// A. Site-first, not task-tagged. The content-addressed task cache
//    (Project.upsertTask) merges multiple call sites onto one task.
//    Sketch said tasks carry one path; that's wrong — same task can be
//    referenced by many sites, each with its own path. Already partially
//    correct: InferenceCallSite holds the path; sites enumerate per call,
//    not per task. Codify: bindTask in trace.ts becomes bindSite —
//    we track (site → invocation, site → path), not (task → path). One
//    task can have many sites; lineage queries take a site and the
//    output, returning the trace for that specific site's invocation.
//
// B. Result shape must encode errors. Sketch's `result: unknown` doesn't
//    distinguish resolved from rejected. Bring in:
//      `result: { kind: "value"; value: unknown } | { kind: "error"; message: string }`
//    Backend errors land here; lineage queries on errored sites trace
//    inputs but stop at the error point.
//
// C. DNFTap doesn't exist in arrival-scheme. Sketch implied a clean
//    plug-in; reality is the evaluator exposes only EvalTap (enter/exit
//    per Pair). Two paths forward (decide before step 3):
//      C1. Extend arrival-scheme — add a DNFTap surface to the evaluator,
//          modify ~12 special-form sites + the map/filter/reduce LIPS
//          implementations to emit choice-point events. Cleanest, but
//          touches the upstream package.
//      C2. Reconstruct paths post-hoc from existing trace. EvalTrace
//          captures every Pair invocation with parent chain. We can
//          classify each Pair by inspecting its head symbol (`if`,
//          `cond`, `map`, `reduce`, `apply`) and infer the choice taken
//          from the captured invocation order + return values. No
//          upstream changes; more code on our side; some kinds aren't
//          reconstructible (lambda dispatch identity, fold-step ordering
//          in async fans). Probably enough for v1.
//
//    Recommendation: start with C2 to keep things in-repo, switch to
//    C1 if the reconstruction gaps bite.
//
// D. Short-circuit `and`/`or` are branches. Not in sketch's branch
//    enumeration but should be. Each (and a b c) decision point is a
//    branch with arm = position where the chain short-circuited (or =
//    length-1 if all evaluated). Same model for `or`.
//
// E. Backends key. The sketch's TraceConfig.backends is provider-keyed
//    (matches runner.ts:65), not tier-keyed. Spec was wrong; updated
//    expectation: `backends: { stub: stubBackend() }` paired with
//    `models: { fast: "stub:fast" }`. Tier→provider lookup goes through
//    the existing Project.resolveTier logic.
//
// ACCEPTED v1 LIMITATIONS — document, don't fix:
//
// L1. Macro-expanded forms invisible. arrival-scheme's evaluator skips
//     Pairs without `__location__`; the existing trace inherits this.
//     Lineage inherits it too — inferences fired from inside a macro
//     expansion don't get path-tagged.
//
// L2. `set!` and other mutating primitives break "pure function of
//     (program, env)." Programs in our substrate are mostly let-bound;
//     set! is rare. v1 ignores it (replay reads post-mutation values).
//     If a program uses set!, the lineage replay value at a node may
//     differ from the original-run value at that node. Worth a runtime
//     warning when set! is used in a traced program.
//
// L3. `call/cc` and other delimited continuations. Rare in our programs.
//     If captured-and-re-invoked-later, the DNFPath sketch is invalid
//     (it assumes linear append-only history). v1 doesn't support;
//     document.
//
// L4. fnHash for env-capturing closures. Stable for parsed-once-reused
//     lambdas (the common case in our scheme). Closures that capture
//     different bindings per call get distinct fnHashes — semantically
//     unique-but-collidable on cache. Accept; revisit if it bites.
//
// L5. Promise-parallel `currentInvocation` race. project.ts:307 — map
//     fans out infer calls; whichever invocation is "current" when
//     upsertTask fires depends on promise resolution order. Sites still
//     resolve correctly (each invocation's node is right), but the
//     parent-chain reads may be racy on simultaneous resolutions. Trace
//     test cases will surface this; mitigate by capturing parent chain
//     synchronously inside enter, not at upsertTask time.
//
// L6. (RESOLVED 2026-05-21 by C1a) Was: LIPS evaluator captured LEXICAL
//     parent across function boundaries — `(map fn xs)` left fn's body
//     Pairs parented to fn's define site, not to the map call. C1a fixed
//     this in the evaluator by threading a dynamic-call-site holder
//     (_dynamicCallSite set in evaluatePair around fn.apply, read in
//     evalLambda / named-let loopFn when building body ctx). Parent
//     walking now surfaces the enclosing HOF; `map` shows up as an
//     `iterate` entry with index = position-among-siblings under that
//     map invocation. Remaining caveat: index counts Pair-invocation
//     siblings under the parent, which for single-form lambda bodies
//     equals the iteration index but for multi-form bodies counts each
//     form. That's acceptable for v1 — the index disambiguates
//     iterations even if its exact value isn't load-bearing.
//
// SPEC GAPS — add to lineage.spec.ts before activating:
//
// G1. Nested map. `(map outer (map inner xs))`. Inner iterate is a
//     SEPARATE choice point from outer; the path naturally accumulates
//     both. Spec should assert this (sketch's path-is-flat-list shape
//     already supports it — just no test).
// G2. Short-circuit and/or — see D above.
// G3. Exception thrown mid-eval (raise, error). recordSession returns
//     a partial session with error markers on the failed sites.
// G4. delay/lazy — the force-time call site differs from the delay-time
//     site. Path is the force-time site's path.
// G5. cacheKey collisions — two infer calls with same prompt but
//     different cacheKey produce two distinct tasks; sites must reflect
//     this.
// G6. infer/chat — the canonical prompt is a JSON-stringified message
//     list. Site.prompt should carry the JSON form (what the backend
//     saw), not the original (list ...) scheme expression.
// G7. filter index semantics — recorded "iterate" indices are against
//     the INPUT list (positions 0..N-1), not the output (0..M-1).
//     Doable, just needs the filter LIPS implementation to count input
//     positions.
// G8. when/unless/case fold into branch (when/unless → arm 0/1; case
//     → arm = matched clause index). Already accepted; spec should
//     have one test exercising each.
//
// PRE-EXISTING ISSUES (orthogonal to this work, but flagged):
//
// P1. schemaSlot canonicalisation is duplicated in Project.run and
//     Project.runTraced. Drift risk; clean up separately.
// P2. project.ts:242 transact wraps mutations in Plexus transactions;
//     observers may see inconsistent state mid-transact. Not unique to
//     lineage but should be exercised in benchmark/stress tests.
//
// ════════════════════════════════════════════════════════════════════
// AUDIT FINDINGS (2026-05-21) — addressed + deferred items
// ════════════════════════════════════════════════════════════════════
//
// Addressed in this commit cycle:
//   #1 (P1) async-recursive HOFs — wrapLambdaArgs in arrival-scheme
//     evaluatePair re-installs _dynamicCallSite per call. Regression
//     test exists in lineage.spec.ts ("async-recursive HOFs (audit #1)").
//   #2 (P0) head-symbol fast-path tap bypass — fire onSymbolResolved
//     in the call-head branch too (arrival-scheme commit 1efbe45c6).
//   #3 (P1) inline lambdas — resolveLambdaArg now finds the child
//     invocation under the HOF whose node is the (lambda …) Pair and
//     reads its .value for __params__.
//   #6 (P2) jsValueOf via lipsToJs — defers to arrival-scheme's
//     canonical unwrap so SchemeNumeric / Pair-lists / SchemeJSObject
//     round-trip correctly.
//   #15 (P3) named-let loopFn __params__ — mirrored from evalLambda.
//   #17 (P3) tap exception logging — EvalTrace warns once per session.
//
// Deferred (documented limitations; revisit when workloads demand):
//   #4 (P2) classifySymbolOrigin only matches params[0]. Multi-arg
//     lambdas (`(map (lambda (k v) …) ks vs)`) won't distinguish k
//     from v. Fix: iterate params, emit matched index in TraceOrigin.
//   #5 (P2) Shallow HOF set (map/filter/for-each/find only). No
//     apply, fold/reduce, named-let recursion. Combined with #1's
//     wrapping these now thread parent correctly, but path entries
//     are still missing for those forms.
//   #7 (P2) PathCache key omits programHash. Safe in the per-session
//     model (recordSession owns one), but createPathCache is exported
//     and bindCacheToProjectEnv binds only env. If a long-lived cache
//     spans program edits, (line,col) collisions across programs would
//     produce false hits. Either add programHash to the key or
//     bindCacheToProgramSource (analogous to env reaction).
//   #8 (P2) envHashOf is O(N log N) per mobx reaction tick. Materialises
//     entries, sorts, JSON-stringifies. Negligible <100 entries; ~ms
//     per write at 1000+. Alternative: plexus monotonic version
//     counter, or incremental hash maintained per set.
//   #10 (P1) TraceSession.trace / invByTaskId don't survive
//     postMessage / structuredClone — WeakMaps drop silently. For
//     worker-side use, either ship pure data (inferences[] + version
//     + programSource) and keep traceForOutput main-thread, or
//     serialize a parallel Map<invId, Map<name, value>>.
//   #11 (P2) programHash is whitespace-sensitive. Reformat
//     invalidates every site. Acceptable for snapshot artifacts.
//     If users edit programs in a pretty-printer, normalize before
//     hash.
//   #12 (P2) CodeTrace.args carries only the prompt. Schema and
//     cacheKey args (slot 2/3 of infer) don't appear. Matters for
//     advanced templating where cacheKey is computed.
//   #13 (P2) cond / case forms not classified. ifLikeArm handles
//     if/when/unless only. Spec has when test (G8); cond is common
//     in real programs — add at least a smoke test.
//   #14 (P3) Stub-backend coupling in tests — stubBackend throws on
//     unknown prompts, version-check test had to introduce a separate
//     stub. echoBackend now covers G-tests; could become the default.
//   #16 (P2) _dynamicCallSite doesn't reach Rosetta callbacks. A
//     user-defined Rosetta with withContext: true that calls a scheme
//     lambda back won't have _dynamicCallSite set (it's only set
//     inside evaluatePair.apply). Document at the holder declaration;
//     consider explicit setDynamicCallSite API for Rosetta authors.

// ════════════════════════════════════════════════════════════════════
// BYTE BUDGET — same as before, recap
// ════════════════════════════════════════════════════════════════════
//
//   DNFEntry           ~32B
//   Path per task      ~700B (20 entries + version)
//   3000 tasks         ~2.1MB
//   PathCache          ~8MB at 10k choice points (LRU if needed)
//   Capture per query  ~100KB (path × ~5KB args)
//   Live storage @100k ~10MB total
//
// Worker-side: the session ships back as ~10MB structured data. JSON-able
// or via structured-clone. Acceptable for ws-tunneled use too — we'd
// likely strip the cache before shipping to a peer (the peer doesn't
// need the cache, they just need inferences[] + version + programSource
// to run their own queries).
