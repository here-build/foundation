/**
 * trace → REGION TREE — the structural model behind the blueprint render: infer
 * calls as leaves, fan-out (map/filter/fold) as CONTAINERS whose N iterations are
 * kept DISTINCT (so the render can stack them on a virtual Z-axis = tabs, one tree
 * shown at a time rather than N laid out flat). Built from the RAW invocation tree
 * (not the scope-collapsing forest), so iterations survive and the nesting is real.
 *
 * The rules, walking each invocation:
 *   - provenance point (an `(infer …)` / `.prompt` call) → a LEAF.
 *   - fan-out head (`map`/`filter`/`fold`/…) → a CONTAINER; its iterations are the
 *     child applications (the children that carry a body — the eval'd-once args,
 *     the lambda + the collection, have none).
 *   - anything else (let, if, list, a plain function call) → PLUMBING: flattened
 *     through to the meaningful regions inside it.
 *
 * Plus the dataflow WIRES: the provenance edges between leaves (`⋃ child.provenance`
 * over a point's children ∩ the point set — the same rule the statechart/chain use).
 *
 * NOT YET: TCO containers. A tail-recursive loop's recursion is nested in the raw
 * tree (loop ⊃ … ⊃ loop), so it CAN be peeled into iterations — but the recursive
 * call's work lives in its argument eval, which needs care. For now the recursion
 * flattens (fine at small budgets; would over-expand a long loop — the follow-on).
 */
import { snapshotTrace, type PlainInv } from "./trace-snapshot.js";
import { scopeId } from "./trace-to-forest.js";
import type { EvalTrace } from "./trace.js";

export type Region =
  | { kind: "leaf"; id: number; label: string }
  | { kind: "fanout"; id: number; label: string; iterations: Region[][] };

export interface RegionGraph {
  /** Top-level meaningful regions, plumbing flattened away. */
  roots: Region[];
  /** Dataflow wires between leaf invocation ids (producer → consumer). */
  edges: { from: number; to: number }[];
  warnings: string[];
}

/** Heads that fan out: each applies a function across a collection. */
const FANOUT: ReadonlySet<string> = new Set(["map", "filter", "fold", "fold-left", "fold-right", "for-each", "mapcat", "flat-map", "flatmap"]);

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";

export function traceToRegions(trace: EvalTrace): RegionGraph {
  const snap = snapshotTrace(trace);
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // Wires: upstream(X) = ⋃ over X's children of child.provenance, ∩ points.
  const edges: { from: number; to: number }[] = [];
  for (const x of points) {
    const up = new Set<number>();
    for (const c of x.children) for (const p of c.provenance) if (p !== x.id && pointIds.has(p)) up.add(p);
    for (const u of up) edges.push({ from: u, to: x.id });
  }

  const regionsAt = (inv: PlainInv): Region[] => {
    if (inv.isProvenancePoint) return [{ kind: "leaf", id: inv.id, label: headOf(inv) }];
    if (FANOUT.has(headOf(inv))) {
      // Iterations = the application children (those carrying a body). The
      // eval'd-once args (lambda, collection) have no children → excluded. An
      // iteration that flattens to nothing meaningful is dropped.
      const iterations = inv.children
        .filter((c) => c.children.length > 0)
        .map((c) => regionsAt(c))
        .filter((r) => r.length > 0);
      return [{ kind: "fanout", id: inv.id, label: headOf(inv), iterations }];
    }
    return inv.children.flatMap(regionsAt); // plumbing: flatten through
  };

  const roots = snap.invocations.filter((i) => !i.parent).flatMap(regionsAt);
  return { roots, edges, warnings: [] };
}
