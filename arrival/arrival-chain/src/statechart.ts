/**
 * trace → causal statechart model (pure; no React, no layout engine).
 *
 * This is the data behind the flows-debugging view: the dataflow DAG the two
 * existing trace views never draw. `trace-view`/`trace-editor` render
 * `Invocation.ancestors()` — the dynamic CALL STACK ("how the interpreter got
 * here"). This renders `Invocation.provenance` — the CAUSALITY ("what caused
 * this"). Different graph entirely.
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
import type { Pair, SchemeSymbol } from "@here.build/arrival-scheme";
import type { EvalTrace, Invocation } from "./trace.js";

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

/** Union of a provenance-point invocation's direct children's provenance — the
 *  set of upstream infer ids that flowed into its arguments. */
function inputProvenance(inv: Invocation): Set<number> {
  const out = new Set<number>();
  for (const child of inv.children) for (const id of child.provenance) out.add(id);
  return out;
}

/**
 * Extract the causal statechart from a finished (or in-flight) trace. Reads only
 * provenance-point invocations (the `(infer …)` calls — the "meaningful events"
 * the meta-plane cares about); intermediate plumbing invocations are folded into
 * the edge computation but never become nodes.
 */
export function traceToStatechart(trace: EvalTrace): Statechart {
  // 1. Gather every provenance-point invocation, indexed by id.
  const points = new Map<number, Invocation>();
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      if (inv.isProvenancePoint) points.set(inv.id, inv);
    }
  }
  if (points.size === 0) return { nodes: [], edges: [], layerCount: 0 };

  // 2. Uncollapsed causal edges (upstream infer id → this infer id), keeping
  //    only ids that are themselves provenance points (defensive: a non-point
  //    id can't legally appear, but the trace may be mid-flight).
  const upstream = new Map<number, Set<number>>();
  for (const [id, inv] of points) {
    const ups = new Set<number>();
    for (const u of inputProvenance(inv)) if (points.has(u) && u !== id) ups.add(u);
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

  // 5. Lift edges to cells, dedupe, and classify by layer: a non-increasing edge
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
      edges.push({ from, to, kind });
    }
  }

  const layerCount = nodes.reduce((m, n) => Math.max(m, n.layer + 1), 0);
  return { nodes, edges, layerCount };
}
