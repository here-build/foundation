/**
 * trace → causal statechart model (pure; no React, no layout engine).
 *
 * This is the data behind the flows-debugging view: the dataflow DAG the two
 * existing trace views never draw. `trace-view`/`trace-editor` render
 * `Invocation.ancestors()` — the dynamic CALL STACK ("how the interpreter got
 * here"). This renders `Invocation.provenance` — the CAUSALITY ("what caused
 * this"). Different graph entirely.
 *
 * Operates on a plain `PlainTrace` snapshot (see trace-snapshot.ts), not the live
 * observable trace — the O(n²) traversal below reads children/provenance far too
 * many times to pay MobX proxy + tracking on each. `traceToStatechart` keeps its
 * `EvalTrace` signature and snapshots internally, so callers are unaffected.
 *
 * ── why the edge rule looks indirect ────────────────────────────────────────
 * Every `(infer …)` invocation is a provenance point, so its OWN `.provenance`
 * is the singleton `{self.id}` (the §5.1 override) — that tells you nothing
 * about what flowed IN. The inputs live one level down: an infer's argument
 * sub-expressions are its `.children`, and each child's `.provenance` already
 * encodes its whole subtree (the union rule propagates upward at every exit).
 * So the set of upstream infers feeding X is `⋃ child.provenance` over X's
 * direct children. Every id in that union is necessarily another provenance
 * point's id — non-points never put their own id into a provenance set — so the
 * union is exactly X's upstream-infer set. (Verified in statechart.test.ts
 * against a real gepa-loop trace; if the propagation model were wrong the
 * react→reflect edges wouldn't appear.)
 *
 * ── why the loop falls out for free ─────────────────────────────────────────
 * Collapsing invocations by Pair identity (the same AST node entered N times)
 * gives the ×N iteration/fan-out stack. Across a tail-recursive loop, iter-k's
 * reflect feeds iter-(k+1)'s react, so the collapsed react/reflect cells form a
 * 2-cycle: the layer-increasing edge is the within-iteration flow, the
 * layer-non-increasing edge is the `↺` loop-back. We classify edges by that
 * layer comparison instead of detecting "this is a loop" structurally.
 *
 * NOT YET MODELLED (v0): region NESTING. A ×3 persona fan-out sitting inside a
 * ×K loop collapses to one cell with count 3K — the two axes are conflated.
 * Distinguishing parallel-region-within-loop-region needs the §5.4 mark
 * hierarchy and is the v1 follow-up; this v0 is the flat collapsed causal DAG.
 */
import type { Pair, SchemeSymbol } from "@here.build/arrival";

import { snapshotTrace, type PlainInv, type PlainTrace } from "./trace-snapshot.js";
import type { EvalTrace } from "./trace.js";

export type EdgeKind = "forward" | "loopback";

export interface ChartNode {
  /** Representative invocation id (the lowest id among the collapsed group). */
  id: number;
  /** Iteration/fan-out count — how many invocations share this AST node. */
  count: number;
  /** Lamport causal depth: longest upstream infer chain. 0 = source. */
  layer: number;
  /** Display label — the form's leading symbol, e.g. `infer/chat`. */
  label: string;
}

export interface ChartEdge {
  from: number;
  to: number;
  /** `forward` = within-iteration dataflow; `loopback` = the `↺` back-edge. */
  kind: EdgeKind;
  /**
   * Field-qualified provenance: the producer's output fields the consumer
   * actually plucked off this edge — `["verdict"]` for an edge whose consumer
   * read `(:verdict producer-result)`. Absent when the whole value flowed
   * unprojected (no keyword accessor between producer and consumer). This is
   * the per-property "pin" of the blueprint wire — read FORWARD it is which
   * output of the producer feeds the consumer; read BACKWARD it is the field
   * whose declaration a go-to-source jump should land on.
   *
   * Spec-derived, not editorial: a field appears here ONLY where it was
   * genuinely projected (a pluck site exists), so the graph can never claim a
   * property was used that the source never touched. v0 captures accessors
   * LEXICALLY NESTED in the consumer's argument subtree (the dominant pattern,
   * incl. `(infer … (:verdict (other-infer)))`); projection routed through an
   * intermediate `define`/`let` binding is not yet attributed (needs the field
   * to ride on the value, parallel to provenance — the v1 follow-up).
   */
  fields?: string[];
}

export interface Statechart {
  nodes: ChartNode[];
  edges: ChartEdge[];
  /** Number of Lamport layers (max layer + 1); 0 if empty. */
  layerCount: number;
}

const isPair = (v: unknown): v is Pair => v !== null && typeof v === "object" && "car" in v && "cdr" in v;

/** Leading symbol of a form, e.g. `(infer/chat …)` → `"infer/chat"`. Falls back
 *  to `"?"` for shapes without a symbol head (rare for tracked infer nodes). */
function leadingSymbol(node: Pair): string {
  const head = (node as { car: unknown }).car;
  if (head !== null && typeof head === "object" && "__name__" in head) {
    const name = (head as SchemeSymbol as { __name__: unknown }).__name__;
    if (typeof name === "string") return name;
  }
  return "?";
}

/**
 * Resolve a provenance id to its real producer point + (if it arrived via a
 * keyword pluck) the field that was projected. A field-point's id isn't a real
 * point — it lives in `fieldPointMeta`, possibly chained (nested `(:a (:b x))`).
 * Walk the chain to the real producer point; the pin is the key closest to that
 * point (its actual output field — the OUTER key of a chain is a projection of an
 * already-projected field, so the inner one names the producer's port). Returns
 * null if the chain bottoms out at a non-point.
 */
function resolvePoint(
  fieldPointMeta: PlainTrace["fieldPointMeta"],
  points: Map<number, PlainInv>,
  u: number,
  memo: Map<number, { origin: number; field?: string } | null>,
): { origin: number; field?: string } | null {
  // Resolution is a pure function of `u` within one build, and the same upstream
  // id recurs across many points' input-provenance sets (a popular producer; a
  // repeatedly-plucked field). Without this memo, re-resolving every occurrence —
  // walking the field-point chain and allocating a fresh record each time —
  // dominated a large render (~50% self-time in profiling). Cache per `u`.
  if (memo.has(u)) return memo.get(u)!;
  let result: { origin: number; field?: string } | null;
  if (points.has(u)) {
    result = { origin: u };
  } else {
    const meta = fieldPointMeta.get(u);
    if (meta) {
      const inner = resolvePoint(fieldPointMeta, points, meta.origin, memo);
      result = inner ? { origin: inner.origin, field: inner.field ?? meta.key } : null;
    } else {
      result = null;
    }
  }
  memo.set(u, result);
  return result;
}

/**
 * Extract the causal statechart from a finished (or in-flight) trace. Reads only
 * provenance-point invocations (the `(infer …)` calls — the "meaningful events"
 * the meta-plane cares about); intermediate plumbing invocations are folded into
 * the edge computation but never become nodes.
 */
export function traceToStatechart(trace: EvalTrace): Statechart {
  // De-proxy the observable trace into plain data once; everything below runs on
  // plain Sets/arrays (no MobX per-read cost). The single read pass inside
  // snapshotTrace is the reactive boundary the React observer tracks for live-fill.
  const snap = snapshotTrace(trace);

  // 1. Gather every provenance-point invocation, indexed by id.
  const points = new Map<number, PlainInv>();
  for (const inv of snap.invocations) {
    if (inv.isProvenancePoint) points.set(inv.id, inv);
  }
  if (points.size === 0) return { nodes: [], edges: [], layerCount: 0 };

  // 2. Uncollapsed causal edges (upstream infer id → this infer id). Each input
  //    provenance id resolves to a real producer point; a field-point resolves
  //    through `fieldPointMeta` to its producer AND the pin it plucked, recorded
  //    per producer→consumer point-edge. (A non-point that resolves to nothing
  //    — only possible mid-flight — is dropped.)
  const upstream = new Map<number, Set<number>>();
  const fieldsByPointEdge = new Map<string, Set<string>>(); // `${producer}>${consumer}` → fields
  const resolveMemo = new Map<number, { origin: number; field?: string } | null>();
  for (const [id, inv] of points) {
    const ups = new Set<number>();
    // The upstream infers feeding this point are ⋃ child.provenance over its
    // direct children — iterate that straight through (ups + the memo dedupe),
    // no intermediate union set.
    for (const child of inv.children) {
      for (const u of child.provenance) {
        const r = resolvePoint(snap.fieldPointMeta, points, u, resolveMemo);
        if (!r || r.origin === id) continue;
        ups.add(r.origin);
        if (r.field !== undefined) {
          const key = `${r.origin}>${id}`;
          (fieldsByPointEdge.get(key) ?? fieldsByPointEdge.set(key, new Set()).get(key)!).add(r.field);
        }
      }
    }
    upstream.set(id, ups);
  }

  // 3. Lamport layer per invocation = longest upstream chain. The id order is a
  //    valid topological order (an infer's id is minted after every infer it can
  //    depend on), so a single ascending-id pass resolves all longest paths.
  const layerOf = new Map<number, number>();
  for (const id of [...points.keys()].sort((a, b) => a - b)) {
    let layer = 0;
    for (const u of upstream.get(id)!) layer = Math.max(layer, (layerOf.get(u) ?? 0) + 1);
    layerOf.set(id, layer);
  }

  // 4. Collapse by Pair identity → one cell per AST node. Representative = lowest
  //    id; cell layer = lowest member layer (where the construct first fires).
  const cellByNode = new Map<Pair, { rep: number; count: number; layer: number; label: string }>();
  const cellIdOf = new Map<number, number>(); // invocation id → representative id
  for (const [id, inv] of points) {
    const node = inv.node;
    let cell = cellByNode.get(node);
    if (!cell) {
      cell = { rep: id, count: 0, layer: layerOf.get(id)!, label: leadingSymbol(node) };
      cellByNode.set(node, cell);
    }
    cell.count += 1;
    if (id < cell.rep) cell.rep = id;
    cell.layer = Math.min(cell.layer, layerOf.get(id)!);
  }
  for (const [id, inv] of points) cellIdOf.set(id, cellByNode.get(inv.node)!.rep);

  const nodes: ChartNode[] = [...cellByNode.values()].map((c) => ({
    id: c.rep,
    count: c.count,
    layer: c.layer,
    label: c.label,
  }));
  const layerByCell = new Map(nodes.map((n) => [n.id, n.layer]));

  // 5. Lift the per-point pins (step 2) onto cell-edges: many point-edges
  //    collapse onto one cell-edge (a fan-out producer, a tail-recursive loop),
  //    so the field set unions across them.
  const fieldsByCellEdge = new Map<string, Set<string>>();
  for (const [pointEdge, fields] of fieldsByPointEdge) {
    const [producer, consumer] = pointEdge.split(">").map(Number) as [number, number];
    const cellKey = `${cellIdOf.get(producer)!}>${cellIdOf.get(consumer)!}`;
    const set = fieldsByCellEdge.get(cellKey) ?? fieldsByCellEdge.set(cellKey, new Set()).get(cellKey)!;
    for (const f of fields) set.add(f);
  }

  // 6. Lift edges to cells, dedupe, and classify by layer: a non-increasing edge
  //    is the loop-back (iter k → iter k+1 collapsed onto the same cells).
  const seen = new Set<string>();
  const edges: ChartEdge[] = [];
  for (const [id, ups] of upstream) {
    const to = cellIdOf.get(id)!;
    for (const u of ups) {
      const from = cellIdOf.get(u)!;
      if (from === to && layerByCell.get(from) === layerByCell.get(to)) continue; // intra-cell, not a loop
      const key = `${from}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind: EdgeKind = layerByCell.get(from)! < layerByCell.get(to)! ? "forward" : "loopback";
      const fields = fieldsByCellEdge.get(key);
      edges.push(fields ? { from, to, kind, fields: [...fields].sort() } : { from, to, kind });
    }
  }

  const layerCount = nodes.reduce((m, n) => Math.max(m, n.layer + 1), 0);
  return { nodes, edges, layerCount };
}

/**
 * Causal reachability over the chart's directed edges, ignoring `kind` — a
 * `loopback` edge (iter-k → iter-k+1) is a real causal edge, so changing a node
 * genuinely re-fires what its loop-back reaches. Cycles (the react⇄reflect tight
 * loop) terminate via the visited set; in a cycle a node's two cones overlap,
 * which is the honest answer (the loop is mutually entangled). Self is never
 * included in the returned set.
 *
 * `forward` = blast radius ("what re-fires if I change X"); `backward` = the
 * causal why ("what produced X").
 */
function cone(chart: Statechart, startId: number, direction: "forward" | "backward"): Set<number> {
  const adj = new Map<number, number[]>();
  for (const e of chart.edges) {
    const [from, to] = direction === "forward" ? [e.from, e.to] : [e.to, e.from];
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(to);
  }
  const out = new Set<number>();
  const queue = [startId];
  while (queue.length > 0) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (next === startId || out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

/** Blast radius: every node that re-fires if the given node changes. */
export const forwardCone = (chart: Statechart, id: number): Set<number> => cone(chart, id, "forward");

/** Causal why: every node whose output flowed into the given node. */
export const backwardCone = (chart: Statechart, id: number): Set<number> => cone(chart, id, "backward");
