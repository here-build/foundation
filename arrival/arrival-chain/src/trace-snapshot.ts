/**
 * Plain (non-observable) mirror of an EvalTrace, for the flow-graph build.
 *
 * The trace is fully MobX-observable so the chart can fill in live as infers
 * resolve. But the graph build (`traceToStatechart` / `traceToForest`) is a heavy
 * O(n²)-ish traversal that reads `children` / `provenance` millions of times — and
 * against the live trace, every one of those reads pays observable-proxy +
 * dependency-tracking overhead (profiling a large render put `ObservableSet`
 * iteration alone at ~22% and `track` at ~7%).
 *
 * `snapshotTrace` is the **reactive boundary**: one linear pass copies the fields
 * the build needs into plain objects/Sets. Called inside the React observer, that
 * single pass is what gets tracked — so live-fill is preserved (a trace change
 * re-runs the snapshot → re-renders) — while the expensive build downstream
 * touches only plain structures and pays zero MobX cost. Reactivity at the edge,
 * computation in the core.
 */
import type { Pair } from "@here.build/arrival-scheme";
import type { EvalTrace } from "./trace.js";

/** Exactly the Invocation fields the flow-graph build reads. The AST `node` is a
 *  plain Pair, shared by reference — its identity is load-bearing (cells and
 *  forest boxes group by Pair identity). */
export interface PlainInv {
  id: number;
  node: Pair;
  parent: PlainInv | null;
  children: PlainInv[];
  provenance: ReadonlySet<number>;
  isProvenancePoint: boolean;
}

export interface PlainTrace {
  /** Every invocation, in records order. */
  invocations: PlainInv[];
  /** Field-point id → producer origin + plucked key (the field-provenance map). */
  fieldPointMeta: EvalTrace["fieldPointMeta"];
}

export function snapshotTrace(trace: EvalTrace): PlainTrace {
  const byId = new Map<number, PlainInv>();
  const invocations: PlainInv[] = [];
  // Pass 1: copy each invocation's scalar fields and de-proxy its provenance Set.
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      const plain: PlainInv = {
        id: inv.id,
        node: inv.node,
        parent: null,
        children: [],
        provenance: new Set(inv.provenance),
        isProvenancePoint: inv.isProvenancePoint,
      };
      byId.set(inv.id, plain);
      invocations.push(plain);
    }
  }
  // Pass 2: wire parent/children by id (both endpoints now exist as plain nodes).
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      const plain = byId.get(inv.id)!;
      if (inv.parent) plain.parent = byId.get(inv.parent.id) ?? null;
      for (const child of inv.children) {
        const childPlain = byId.get(child.id);
        if (childPlain) plain.children.push(childPlain);
      }
    }
  }
  return { invocations, fieldPointMeta: new Map(trace.fieldPointMeta) };
}
