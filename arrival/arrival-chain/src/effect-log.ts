/**
 * effect-log — the per-run record of every EXTERNAL effect a run fired, and the
 * machinery to REPLAY it (zero external hits) or PARTIALLY invalidate it (re-run
 * only the provenance forward-cone, replay the rest).
 *
 * ── what an effect is ────────────────────────────────────────────────────────
 * A run touches the outside world at exactly the host-capability seams:
 *   - `(infer …)` / `(infer/chat …)` / a `.prompt` call → an LLM call
 *   - `(http/get …)` / `(http/post …)` → a fetch                (A3, future)
 *   - `(sql/query …)` → a read against an external DB            (A3, future)
 * Everything else in a run is pure (a fold over the program's files), so the set
 * of effects is the run's ENTIRE contact with non-determinism. Capture them all
 * and a re-execution becomes a pure function — the warrant behind replay.
 *
 * ── why keys are kind-TAGGED ─────────────────────────────────────────────────
 * The infer plane keys content by `[model, prompt, schema, cacheKey]` (the
 * `InferStore` cache key). An http GET keys by URL+query; a sql read by
 * query+params. Across kinds these payloads can coincide as strings — an infer
 * whose prompt is `"select 1"` and a `(sql/query "db" "select 1")` would mint
 * byte-identical keys. The effect-log is a SINGLE map across all kinds, so a
 * collision would let one effect's recorded value short-circuit a different
 * effect. Tagging every key with its `kind` makes the key spaces disjoint by
 * construction — `["infer", …]` can never equal `["sql", …]`. This is the
 * `infer/data collision` the design calls out.
 *
 * ── replay vs counterfactual (the same mechanism, two fill levels) ───────────
 * A run consults a short-circuit map BEFORE every external call:
 *   - REPLAY binds the FULL recorded log → every effect hits the map → zero
 *     external calls, deterministic reproduction.
 *   - A COUNTERFACTUAL (`Project.runHypothesis`'s `tweaks`) binds a PARTIAL map
 *     of chosen overrides → only the branched effects short-circuit; the rest
 *     flow through the live plane.
 *   - PARTIAL INVALIDATION sits between them: take the full log, SUBTRACT the
 *     effects in the changed node's forward-cone, bind the remainder → the cone
 *     re-runs against the live plane, everything upstream/parallel replays.
 *
 * ── partial invalidation = subtract the forward-cone ─────────────────────────
 * Given a prior run's trace and its full effect-log, and a set of CHANGED nodes,
 * the effects that MUST re-run are exactly the changed nodes plus everything
 * causally downstream of them — the provenance forward-cone (`forwardCone`,
 * reused verbatim). Everything else is causally unaffected and replays from the
 * log. `invalidateForwardCone` does this subtraction: it returns the replay log
 * (full log minus the cone's effect keys). Re-running with that log is the
 * minimal recomputation — a cone effect misses the log and hits the plane; a
 * non-cone effect hits the log and costs nothing.
 *
 * This module is pure data + pure functions: no eval engine, no model calls. The
 * `Project.run` seam consults an `EffectLog` (see `opts.effectLog`); this file
 * owns the key algebra and the cone subtraction.
 */
import { InferBinding } from "@here.build/arrival-inference";
import { forwardCone, traceToStatechart, type Statechart, type EvalTrace } from "@here.build/arrival-provenance";

import type { DataEffect } from "./data-effects.js";
import type { McpEffect } from "./mcp-effects.js";

/** Protocol family of an external effect. `infer` is the LLM plane; `http`/`sql`
 *  are the data planes the host-capability builtins (A3) inject; `mcp` is the tool
 *  plane (a client call to an MCP server). The tag is the first element of every
 *  effect key, keeping the per-kind key spaces disjoint. Note `mcp` keys are
 *  POSITIONAL (per inference, per server) where infer/http/sql are CONTENT-keyed —
 *  see {@link mcpEffectKey} for why. */
export type EffectKind = "infer" | "http" | "sql" | "mcp";

/**
 * The recorded effects of one run: kind-tagged effect key → the JSON of the
 * value that effect produced (the same `valueJson` shape the run output uses).
 * Replay binds this whole map; partial invalidation binds a subset of it.
 *
 * A `Map` (not a record) so insertion order = effect order — a run's effect-log
 * read back in order is its causal sequence, and `Run.effects` holds the same
 * keys in the same order.
 */
export type EffectLog = Map<string, string>;

/**
 * Canonical kind-tagged effect key: `JSON.stringify([kind, ...payload])`.
 *
 * The payload is the kind's own content identity:
 *   - infer → `[model, prompt, schema, cacheKey]` (the `InferStore` cache key)
 *   - http  → `[method, label, path, bodyOrQueryJson]`
 *   - sql   → `[label, query, paramsJson]`
 *
 * Callers should prefer the typed constructors below so the payload shape stays
 * consistent across the record site and the replay-lookup site (a mismatch would
 * silently miss the log). `effectKey` is the shared lowering they all funnel
 * through.
 */
export const effectKey = (kind: EffectKind, payload: readonly unknown[]): string => JSON.stringify([kind, ...payload]);

/** The infer effect key — tags the `InferStore` content tuple with `"infer"`.
 *  This is the kind-tagged twin of the untagged tuple `Run` used to store under
 *  `inferences` and that `tweaks` still keys by (tweaks is the infer-only
 *  counterfactual surface; the effect-log is the all-kinds replay surface). */
export const inferEffectKey = (model: string, prompt: string, schema: string | null, cacheKey: string | null): string =>
  effectKey("infer", [model, prompt, schema, cacheKey]);

/** The http effect key. `bodyOrQuery` is the request's content-bearing payload
 *  (query for GET, body for POST) canonicalised to JSON by the caller. Method is
 *  part of the identity so a GET and a POST to one path never alias. (A3 will
 *  mint these from the `(http/*)` rosettas; defined here so the key algebra is
 *  in one place.) */
export const httpEffectKey = (method: string, label: string, path: string, bodyOrQueryJson: string): string =>
  effectKey("http", [method.toUpperCase(), label, path, bodyOrQueryJson]);

/** The sql effect key. `paramsJson` is the positional-parameter list canonicalised
 *  to JSON (parameters are SEPARATE from the query string — injection-safe by
 *  construction, and part of the identity so the same query with different params
 *  is a distinct effect). */
export const sqlEffectKey = (label: string, query: string, paramsJson: string): string =>
  effectKey("sql", [label, query, paramsJson]);

/** The mcp effect key — POSITIONAL per (inference, server, nth-call), NOT content-keyed.
 *  Unlike infer/http/sql (whose result is a pure function of their content), an MCP
 *  call's result depends on the server's hidden mutable state: the same `{tool,args}`
 *  read returns different values before vs after an intervening write, and that
 *  read↔write coupling runs through the server (not the dataflow graph), so it is
 *  invisible to the content key + the forward-cone. Keying by POSITION within a
 *  per-(inference, server) tape captures the ordering; the recorded tuple carries the
 *  `{server,method,request}` so replay can VERIFY alignment and stop on divergence
 *  rather than silently serve a stale value (see `wrapMcpResolver` in mcp-effects). */
export const mcpEffectKey = (inferenceId: string, server: string, n: number): string =>
  effectKey("mcp", [inferenceId, server, n]);

/** Deterministic JSON of a value with object keys sorted recursively — so two
 *  descriptors that differ only in key insertion order mint the SAME key (a
 *  `{city, units}` query equals a `{units, city}` one). Arrays keep order (it is
 *  significant — `params` is positional). Primitives stringify as-is; `undefined`
 *  (a field never set) folds to `null` so a present-but-undefined slot is stable. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The kind-tagged effect key for a DATA effect — the bridge node A3's `(http/*)`
 * / `(sql/query)` verbs use to RECORD into and REPLAY from the effect-log. Derived
 * from the FULL canonical descriptor (method/label/path/query/headers/body for
 * http; label/query/params for sql) so the identity captures everything that
 * affects the result — the design's "effect-log derives the content key from the
 * full canonical descriptor". Headers participate so an auth-varied request isn't
 * aliased; the resolver binds creds host-side, so the program-visible headers are
 * the only caller-controlled ones.
 *
 * Routed through the SAME `effectKey` lowering as infer, so http/sql/infer keys
 * share one disjoint-by-tag space — the single-map effect-log can hold all three
 * without collision (an infer whose prompt is `"select 1"` and a `(sql/query …
 * "select 1")` mint different keys because the tag differs).
 */
export function dataEffectKey(effect: DataEffect): string {
  switch (effect.kind) {
    case "http":
      return httpEffectKey(
        effect.method,
        effect.label,
        effect.path,
        stableJson({ query: effect.query, headers: effect.headers, body: effect.body }),
      );
    case "sql":
      return sqlEffectKey(effect.label, effect.query, stableJson(effect.params));
  }
}

/**
 * The trace-side record of ONE data effect (`(http/*)` / `(sql/query)`), bound to
 * its invocation(s) via `trace.bindTask` exactly as `InferBinding` is for infer.
 * It carries the kind-tagged effect key so the cone/effect-key machinery resolves
 * a data invocation → its effect key the same way it does an infer one — keeping
 * partial-invalidation uniform across all three effect kinds (the design's "the
 * effect-log / replay machinery treats data effects exactly as it treats infer").
 */
export class DataBinding {
  constructor(
    readonly effect: DataEffect,
    /** The kind-tagged effect key (`dataEffectKey(effect)`) — precomputed so the
     *  inverse map below reads it without re-canonicalising. */
    readonly key: string,
  ) {}
}

/**
 * The trace-side record of ONE mcp call (`(mcp …)` / a model-emitted tool call),
 * bound to its invocation via `trace.bindTask` exactly as `DataBinding`/`InferBinding`
 * are. Carries the POSITIONAL effect key (`mcpEffectKey`) so the cone/effect-key
 * machinery resolves an mcp invocation → its key uniformly with the other kinds —
 * keeping partial-invalidation kind-agnostic. (The binding is created where mcp calls
 * are dispatched — the agentic loop / `(mcp …)` verb — and consumed here.)
 */
export class McpBinding {
  constructor(
    readonly effect: McpEffect,
    /** The positional effect key (`mcpEffectKey(inferenceId, server, n)`). */
    readonly key: string,
  ) {}
}

/**
 * Map every effect-producing invocation id to the kind-tagged effect key it fired
 * — the bridge from cone node ids (invocation ids) to effect-log keys. The link is
 * the trace's `invocationByTask`: each effect binding carries its key AND the list
 * of invocations that produced it (one per call site / HOF iteration, before
 * single-flight dedup). Inverting gives `invocation id → effect key`, across BOTH
 * infer (`InferBinding`) and data (`DataBinding`) bindings.
 *
 * One key may map from MANY invocation ids — a content-addressed cell / replayed
 * effect serves every site that minted the same key — which is exactly right:
 * invalidating any one of those sites invalidates that shared effect.
 */
export function effectKeysByInvocation(trace: EvalTrace): Map<number, string> {
  const out = new Map<number, string>();
  for (const [binding, invs] of trace.invocationByTask) {
    const key = bindingKey(binding);
    if (key === undefined) continue;
    for (const inv of invs) out.set(inv.id, key);
  }
  return out;
}

/** The kind-tagged key of an effect binding (`InferBinding`, `DataBinding`, or
 *  `McpBinding`), or undefined for any other bound object (a non-effect task). */
function bindingKey(binding: object): string | undefined {
  if (binding instanceof InferBinding)
    return inferEffectKey(binding.model, binding.prompt, binding.schema, binding.cacheKey);
  if (binding instanceof DataBinding) return binding.key;
  if (binding instanceof McpBinding) return binding.key;
  return undefined;
}

/**
 * Group every effect invocation by its AST node (Pair identity) into the CELL the
 * statechart collapses it to — representative id (min id in the group) → the set of
 * ALL effect keys that cell produced across its fires. This is the cell-grain the
 * forward-cone speaks: a `(infer …)` inside a loop is ONE cell whose representative
 * `forwardCone` returns, but it fired N times with N distinct content keys, so
 * invalidating that cell must invalidate ALL N keys — not just the representative
 * iteration's. The grouping rule (by Pair, min id = representative) MIRRORS
 * `traceToStatechart` exactly (every effect invocation is a provenance point, and
 * the statechart groups provenance points the same way), so a cone id is always one
 * of these representatives and resolves to its full key set.
 */
function effectKeysByCell(trace: EvalTrace): Map<number, Set<string>> {
  // node (Pair) → { rep id, keys } ; then re-key by rep id at the end.
  const byNode = new Map<object, { rep: number; keys: Set<string> }>();
  for (const [binding, invs] of trace.invocationByTask) {
    const key = bindingKey(binding);
    if (key === undefined) continue;
    for (const inv of invs) {
      const node = inv.node as object;
      let cell = byNode.get(node);
      if (!cell) {
        cell = { rep: inv.id, keys: new Set() };
        byNode.set(node, cell);
      }
      cell.keys.add(key);
      if (inv.id < cell.rep) cell.rep = inv.id;
    }
  }
  const out = new Map<number, Set<string>>();
  for (const cell of byNode.values()) out.set(cell.rep, cell.keys);
  return out;
}

/**
 * The set of effect keys to INVALIDATE when `changedNodeIds` change: every effect
 * key produced by each changed CELL plus every cell causally downstream of it (its
 * forward-cone). Returned as effect keys (the effect-log's currency), ready to
 * subtract.
 *
 * `changedNodeIds` are statechart node ids (representative invocation ids — the ids
 * `forwardCone` and the flow-graph speak). A changed node need not itself be an
 * effect cell (it may be a pure node the human edited); its forward-cone is still
 * walked, and only cone cells that HAVE effect keys contribute. Loop/fan-out
 * cells contribute ALL their per-fire keys (see `effectKeysByCell`), so re-running a
 * cell re-runs every iteration of it, not just one.
 */
export function invalidatedEffectKeys(
  trace: EvalTrace,
  statechart: Statechart,
  changedNodeIds: Iterable<number>,
): Set<string> {
  const keysByCell = effectKeysByCell(trace);
  const invalidCells = new Set<number>();
  for (const id of changedNodeIds) {
    invalidCells.add(id); // the changed cell's own effects re-run
    for (const downstream of forwardCone(statechart, id)) invalidCells.add(downstream);
  }
  const keys = new Set<string>();
  for (const cellId of invalidCells) {
    const cellKeys = keysByCell.get(cellId);
    if (cellKeys) for (const k of cellKeys) keys.add(k);
  }
  return keys;
}

/**
 * Build the REPLAY log for a partial re-execution: the full recorded log with the
 * forward-cone of the changed nodes subtracted. Binding this as `opts.effectLog`
 * re-runs exactly the invalidated effects against the live plane (they miss the
 * log) while every causally-unaffected effect replays for free (it hits the log).
 *
 * Pure: takes the prior run's `fullLog` + its `trace`, derives the cone, returns
 * a new map (the inputs are untouched). The statechart is derived from the trace
 * here so callers pass only what they have (the trace from the original run); a
 * caller that already holds a statechart can use `invalidatedEffectKeys` +
 * `subtractKeys` directly.
 */
export function invalidateForwardCone(
  fullLog: EffectLog,
  trace: EvalTrace,
  changedNodeIds: Iterable<number>,
): EffectLog {
  const statechart = traceToStatechart(trace);
  const invalid = invalidatedEffectKeys(trace, statechart, changedNodeIds);
  return subtractKeys(fullLog, invalid);
}

/** The full log minus a set of effect keys — the replay log for a partial
 *  invalidation. Insertion order of the surviving entries is preserved. */
export function subtractKeys(fullLog: EffectLog, remove: ReadonlySet<string>): EffectLog {
  const out: EffectLog = new Map();
  for (const [k, v] of fullLog) if (!remove.has(k)) out.set(k, v);
  return out;
}

/**
 * An effect-log accumulator — the sink a run feeds as each effect SETTLES with its
 * value, so the full log is built in ONE pass during the run (no post-hoc walk of
 * the `InferStore` cells). Pass `collector.record` as `opts.onEffectResult` to
 * `Project.run`; `collector.log` is the resulting `EffectLog`, ready to replay or
 * to persist (host's per-run R2 `effects.json`).
 *
 * Content-addressed: the same key settling twice (single-flight dedup across HOF
 * iterations, or a replayed effect re-recording) overwrites with the identical
 * value — idempotent, so the log holds one entry per distinct effect.
 */
export function effectLogCollector(): { log: EffectLog; record: (key: string, valueJson: string) => void } {
  const log: EffectLog = new Map();
  return { log, record: (key, valueJson) => void log.set(key, valueJson) };
}
