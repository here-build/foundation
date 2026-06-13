/**
 * NAIVE flow-graph builder — a switchable alternate to `traceToFlowGraph` that
 * does NOT run the MDL compressor (`mdl-collapse`). The optimized builder folds
 * regions to hit a description-length bit-budget, which can hide structure you
 * want to see; this one keeps the meaningful-scope forest (`traceToForest`) and
 * the causal / field-qualified edges (`traceToStatechart`) and just wires them
 * up faithfully:
 *
 *   - **iteration series** — any `unfold` (map/filter/for-each) or `loop`
 *     (TCO/recursion) box, plus any box that ran more than once, is marked
 *     `collapsedByDefault` (a ×N series card / stack). This stands in for the
 *     MDL decision with a dead-simple structural rule: a fan-out or a loop reads
 *     as an iteration series, not as a bit-budget verdict.
 *   - **stacked-container merge** — when a container's only child is *another*
 *     container (a `filter` nested directly in a `map`, nothing meaningful
 *     between them), the chain merges into one node labelled `map ▸ filter`,
 *     flattening the Russian-doll nesting into a single readable unit.
 *   - **the rest** — every meaningful node is emitted; every provenance edge is
 *     wired (forward / loopback by causal layer, per-field pins preserved). No
 *     compression, nothing hidden.
 *
 * The MDL path (`traceToFlowGraph`) is untouched and stays the default. This is
 * its sibling, selected by the trace view's builder toggle. Emits the identical
 * `FlowGraph` types so the renderer needs no changes.
 */
import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from "./flow-graph.js";
import type { BoxType, CandidateBox } from "./mdl-collapse.js";
import { regionBoundariesFromEdges } from "./region-boundaries.js";
import { traceToStatechart } from "./statechart.js";
import { scopeId, traceToForest, type ForestOptions } from "./trace-to-forest.js";
import type { EvalTrace, Invocation } from "./trace.js";

/** Box types that are containers (can hold nested work), vs a terminal `leaf`. */
const CONTAINER_TYPES: ReadonlySet<BoxType> = new Set(["unfold", "loop", "fold", "dnf"]);
/** Box types that ARE an iteration (a fan-out or a loop) — always a series. */
const ITERATION_TYPES: ReadonlySet<BoxType> = new Set(["unfold", "loop"]);

/** The leading symbol of a structural scope id `head@line:col`. */
const labelOf = (id: string): string => id.split("@")[0] ?? id;

/** A box that is itself a container type AND actually nests other boxes — the
 *  shape that "stacks" with a same-kind parent (the merge target). */
const isContainerRegion = (b: CandidateBox): boolean => b.children.length > 0 && CONTAINER_TYPES.has(b.type);

export function traceToFlowGraphNaive(trace: EvalTrace, opts: ForestOptions = {}): FlowGraph {
  const forest = traceToForest(trace, opts);
  const chart = traceToStatechart(trace);

  // Correlate chart cells (numeric invocation ids) → structural scope ids, so we
  // can hang causal layers on leaves and lift edges. The same bridge the
  // optimized builder uses; rare head@line:col collisions are surfaced, not hidden.
  const invById = new Map<number, Invocation>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) invById.set(inv.id, inv);

  const sidOfChart = new Map<number, string>();
  const layerBySid = new Map<string, number>();
  const claimed = new Map<string, number>();
  const warnings: string[] = [];
  for (const node of chart.nodes) {
    const inv = invById.get(node.id);
    const sid = inv ? scopeId(inv.node) : `#${node.id}`;
    const prior = claimed.get(sid);
    if (prior !== undefined && prior !== node.id) {
      warnings.push(
        `scope-id collision: "${sid}" maps to chart nodes ${prior} and ${node.id}; edges to the second are dropped.`,
      );
      sidOfChart.set(node.id, `${sid}#${node.id}`); // sentinel — routed out of edges
      continue;
    }
    claimed.set(sid, node.id);
    sidOfChart.set(node.id, sid);
    layerBySid.set(sid, node.layer);
  }

  // Flatten the forest into nodes, merging stacked containers as we descend.
  const nodes: FlowGraphNode[] = [];
  const emit = (box: CandidateBox, parentId: string | null): void => {
    // Absorb a chain of single-container-child containers into one merged node.
    const labels = [labelOf(box.id)];
    let tail = box;
    while (isContainerRegion(tail) && tail.children.length === 1 && isContainerRegion(tail.children[0]!)) {
      tail = tail.children[0]!;
      labels.push(labelOf(tail.id));
    }
    const count = Math.max(1, Math.round(box.n));
    const kind: FlowGraphNode["kind"] = tail.children.length > 0 ? "region" : "leaf";
    nodes.push({
      id: box.id, // the chain's TOP id — stable, and the surviving scope
      kind,
      boxType: box.type,
      parentId,
      label: labels.join(" ▸ "),
      count,
      // Only a leaf (a provenance point) has a causal layer; regions sit outside the lanes.
      layer: kind === "leaf" ? (layerBySid.get(box.id) ?? null) : null,
      // Naive iteration-series rule (replaces the MDL verdict): a structural
      // iteration, or anything that ran more than once, shows as a ×N series.
      collapsedByDefault: ITERATION_TYPES.has(box.type) || count > 1,
      forced: box.force === "collapsed",
    });
    for (const child of tail.children) emit(child, box.id);
  };
  for (const root of forest) emit(root, null);

  // Lift causal edges to scope ids; drop collision sentinels; keep field pins.
  const edges: FlowGraphEdge[] = [];
  for (const e of chart.edges) {
    const from = sidOfChart.get(e.from);
    const to = sidOfChart.get(e.to);
    if (from === undefined || to === undefined || from.includes("#") || to.includes("#")) continue;
    edges.push(e.fields ? { from, to, kind: e.kind, fields: e.fields } : { from, to, kind: e.kind });
  }

  // Region boundaries: attach each region node's entrance/exit (the producers
  // crossing its boundary) for the render to draw as ports. Reuses this build's
  // forest + already-lifted edges — no recompute.
  const boundaries = new Map(regionBoundariesFromEdges(forest, edges).map((b) => [b.id, b] as const));
  for (const node of nodes) {
    const b = boundaries.get(node.id);
    if (b && (b.entrance.length > 0 || b.exit.length > 0)) {
      node.entrance = b.entrance;
      node.exit = b.exit;
    }
  }

  // No compression: the chosen description IS the raw one (ratio 1).
  return { nodes, edges, totalBits: nodes.length, rawBits: nodes.length, warnings };
}
