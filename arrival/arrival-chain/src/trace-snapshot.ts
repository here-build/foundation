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
import { lipsToJs, type Pair } from "@here.build/arrival-scheme";
import type { EvalTrace, InvocationState } from "./trace.js";

/** Exactly the Invocation fields the flow-graph build reads. The AST `node` is a
 *  plain Pair, shared by reference — its identity is load-bearing (cells and
 *  forest boxes group by Pair identity). */
export interface PlainInv {
  id: number;
  node: Pair;
  parent: PlainInv | null;
  children: PlainInv[];
  /** Upstream producer ids — materialized ONLY for direct children of provenance
   *  points, the sole place the build reads provenance (statechart step 2). Empty
   *  elsewhere: loop/plumbing invocations accumulate O(n) provenance up the
   *  recursion, so copying all of it made the snapshot O(n²); copying only the
   *  consumed sets keeps it O(n). If a consumer ever needs provenance off a
   *  non-point-child, widen this predicate. */
  provenance: ReadonlySet<number>;
  isProvenancePoint: boolean;
  /** Resolved value — copied for provenance points only (the render reads it for a
   *  node's result). `undefined` while running and for non-points. */
  value: unknown;
  /** Node metadata, bound by the rosetta fn at call time — points only (`undefined`
   *  otherwise). e.g. a `.prompt` node's `{ kind, path, model, inputs }`. */
  metadata: unknown;
  /** running | resolved | rejected — the render's pending/result/error state. */
  state: InvocationState;
}

export interface PlainTrace {
  /** Every invocation, in records order. */
  invocations: PlainInv[];
  /** Field-point id → producer origin + plucked key (the field-provenance map). */
  fieldPointMeta: EvalTrace["fieldPointMeta"];
}

/** The branch heads whose children carry decision-relevant values. A child of one
 *  of these is a branch TEST or chosen-ARM evaluation; we materialize its `value`
 *  so the region build can substitute the runtime outcome into a readable decision
 *  pill (`fails is empty → yes`). Bounded — a branch has a few children, not O(n). */
const BRANCH_HEADS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);
const headName = (node: Pair | undefined): string | undefined => {
  const car = (node as { car?: unknown } | undefined)?.car;
  const n = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof n === "string" ? n : undefined;
};

/** Shared empty set for invocations whose provenance the build never reads. */
const NO_PROVENANCE: ReadonlySet<number> = new Set();

export function snapshotTrace(trace: EvalTrace): PlainTrace {
  const byId = new Map<number, PlainInv>();
  const invocations: PlainInv[] = [];
  // Pass 1: copy each invocation's scalar fields and de-proxy its provenance Set.
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      const isPoint = inv.isProvenancePoint;
      // A parentless invocation is a top-level form; the LAST one is the program's
      // STATEMENT OUTPUT. We materialize its value + provenance too (a handful of
      // roots, so still O(n)) so the region build can render the program's returned
      // value as a terminal node wired from its producers.
      const isRoot = !inv.parent;
      // A child of a branch form is a test/arm evaluation — materialize its value so
      // the readable decision pill can show the runtime outcome (`→ yes` / `→ no`).
      const isBranchChild = BRANCH_HEADS.has(headName(inv.parent?.node) ?? "");
      const plain: PlainInv = {
        id: inv.id,
        node: inv.node,
        parent: null,
        children: [],
        // Only children of provenance points — plus the top-level roots — have their
        // provenance read downstream; everything else accumulates O(n) provenance we'd
        // never look at.
        provenance: inv.parent?.isProvenancePoint || isRoot ? new Set(inv.provenance) : NO_PROVENANCE,
        isProvenancePoint: isPoint,
        // value + metadata are read by the render only for the leaves it draws
        // (provenance points) and the program-output root; copying them for every
        // invocation would make the snapshot track every intermediate value's
        // resolution.
        //
        // `inv.value` is the rosetta result AS SCHEME SEES IT — a provenance-stamped
        // AValue (the wrapper `jsToLips`'d it on the way back). `lipsToJs` peels that
        // envelope to plain JS so the render shows the string, not
        // `{ provenance, kind, __string__ }`.
        value: isPoint || isRoot || isBranchChild ? lipsToJs(inv.value) : undefined,
        metadata: isPoint ? inv.metadata : undefined,
        state: inv.state,
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
