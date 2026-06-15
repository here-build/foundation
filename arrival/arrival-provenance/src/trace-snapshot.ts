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
 *
 * ── structured-clone contract (the worker boundary) ─────────────────────────
 * The snapshot is plain (de-MobX'd) but it is NOT yet a *pure* structured-clone
 * payload, and the difference is exactly ONE field — `PlainInv.node`. The plan to
 * move `traceToRegions`/`planNesting` into the ELK worker (DAG node A2) will
 * `postMessage` a snapshot across the worker boundary; structured-clone is the
 * transport, so this file's job (DAG node A1) is to pin down precisely what
 * survives that round-trip and what does not.
 *
 * SURVIVES `structuredClone` (verified — see `__tests__/trace-snapshot-clone.test.ts`):
 *   - `id` / `state` — number / string primitives.
 *   - `scope` — the pre-derived `scopeId(node)` string (`head@line:col`). This is the
 *     clone-safe twin of `node`: it captures the symbol-keyed `__location__` (which
 *     a clone strips) into a plain string while the live Pair is in hand.
 *   - `provenance` — a plain `Set<number>` (Sets are clone-safe).
 *   - `value` / `metadata` — already peeled to plain JS by `schemeToJs` (`value`) or
 *     built as a POJO `{ kind, path, model, inputs, … }` (`metadata`); the values a
 *     `.prompt` card reads are strings / numbers / plain objects / Sets.
 *   - `parent` / `children` — object references; the DAG/back-edges are rebuilt
 *     faithfully by structured-clone (it de-dups shared refs and tolerates cycles).
 *   - `PlainTrace.invocations` array and `fieldPointMeta` `Map` — both clone-safe.
 *   - **Invocation ids round-trip intact** — the load-bearing requirement: a later
 *     node binds per-cell values back to worker-produced regions BY `id`, so the
 *     ids MUST survive the boundary. They do (plain numbers).
 *
 * Does NOT survive — `PlainInv.node` (a live arrival-scheme `Pair`):
 *   structured-clone deep-copies a `Pair` into a *plain* `Object` — it drops the
 *   prototype (so `is_pair()` / `instanceof Pair` go false downstream), it does NOT
 *   preserve cross-node `===` identity against any Pair the consumer holds OUTSIDE
 *   the snapshot (a cloned node is a brand-new object), and — the silent killer —
 *   it STRIPS symbol-keyed properties, so `__location__` vanishes and `scopeId`
 *   degrades from `head@line:col` to bare `head` (scope discrimination, loop-body
 *   keying and branch-scope liveness all collapse). The current main-thread
 *   consumers (`traceToRegions`, `statechart`, `region-boundaries`, `trace-to-chain`,
 *   `trace-to-forest`) read `node` by Pair identity, `node.car`, deep `car/cdr`
 *   spine-walks AND `__location__` — all of which the live ref provides for free.
 *
 * ⇒ Contract for A2. The first piece of the projection now EXISTS: `scope`
 * (`scopeId(node)`, pre-derived above) is the clone-safe carrier of the symbol-keyed
 * `__location__` — the silent killer is defused. What the live `Pair` on `node`
 * still uniquely provides, and what the worker boundary still needs handling for:
 *   - cross-node `===` identity (loop-body keying, `a.node === b.node`) — A2 rewrites
 *     these read-sites to `a.scope === b.scope` (equal Pairs ⇒ equal scope strings);
 *   - `car`/`cdr` spine-walks (`listOf`/`asPair`) — these survive the clone as plain
 *     fields (prototype lost, but the duck-typed `"car" in v` checks still hold), so
 *     no projection needed beyond not relying on `is_pair()`/`instanceof`;
 *   - the second live-trace read inside `traceToRegions` (the `liveById`/`valueById`
 *     decision-operand substitution) reads `trace.records` AFTER the snapshot — A2
 *     must absorb those values into the snapshot rather than re-reading the live map.
 * Once A2's `traceToRegions` reads `scope` (not `scopeId(node)`) and the above are
 * handled, `node` itself can be dropped from the posted payload. The read-site
 * rewrite co-designs with `trace-to-regions.ts`, so it is A2's edit, not A1's.
 */
import { schemeToJs, type Pair } from "@here.build/arrival-scheme";

import { scopeId } from "./scope-id.js";
import type { EvalTrace, InvocationState } from "./trace.js";

/** Exactly the Invocation fields the flow-graph build reads. The AST `node` is a
 *  plain Pair, shared by reference — its identity is load-bearing (cells and
 *  forest boxes group by Pair identity). */
export interface PlainInv {
  id: number;
  /** Live arrival-scheme `Pair`, shared by reference — its identity is load-bearing
   *  (consumers group by Pair identity and read `__location__` via `scopeId`). This
   *  is the ONE field that is NOT structured-clone-safe: a clone loses the prototype,
   *  cross-snapshot identity, and the symbol-keyed `__location__`. A2 must project it
   *  to a plain shape before `postMessage`. See the structured-clone contract in this
   *  file's header and `__tests__/trace-snapshot-clone.test.ts`. */
  node: Pair;
  /** Pre-derived `scopeId(node)` (`head@line:col`) — the clone-safe twin of `node`.
   *  `scopeId` reads the symbol-keyed `__location__` off the live Pair, which
   *  `structuredClone` strips; deriving it here (while the live Pair is in hand)
   *  is what lets the off-thread region build key by scope without the Pair. The
   *  worker-side `traceToRegions` rewrite (A2) reads THIS instead of `scopeId(node)`,
   *  and `a.node === b.node` identity checks become `a.scope === b.scope` (scopeId
   *  already collapses by Pair identity, so equal nodes yield equal strings). */
  scope: string;
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
        // Pre-derive scope NOW, while `inv.node` is the live Pair (its symbol-keyed
        // `__location__` is gone after a structuredClone). This is the one piece of
        // node's identity the build needs that does not survive the worker boundary.
        scope: scopeId(inv.node),
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
        // AValue (the wrapper `jsToScheme`'d it on the way back). `schemeToJs` peels that
        // envelope to plain JS so the render shows the string, not
        // `{ provenance, kind, __string__ }`.
        value: isPoint || isRoot || isBranchChild ? schemeToJs(inv.value) : undefined,
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
