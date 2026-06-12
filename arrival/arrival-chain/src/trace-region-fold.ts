/**
 * INCREMENTAL region fold — the streaming twin of `traceToRegions`.
 *
 * `traceToRegions(trace)` rebuilds the whole `RegionGraph` from scratch on every call:
 * a fresh `snapshotTrace` + a full `regionsAt` DFS over EVERY invocation + the edge
 * (Hasse) build over every point. On a 486k-invocation trace that is ~6s — and the
 * blueprint render calls it once per animation frame as infers stream in. But the trace
 * is APPEND-ONLY (pure interpreter, no retraction), so almost all of that work is
 * redone identically each frame.
 *
 * `TraceRegionFold` maintains the SAME `RegionGraph` incrementally:
 *   - `applyDelta()` walks only the NEW invocations (id ≥ cursor) and extends the
 *     persistent state — the snapshot mirror, the Hasse edges/reach, the recursion +
 *     branch-liveness signals. Per-tick cost O(Δ-new-invocations), not O(N).
 *   - `current()` materializes a `RegionGraph` reusing the EXACT shared helpers
 *     `trace-to-regions.ts` exports, plus an iteration-level memo: a loop iteration
 *     whose successor exists, or a resolved map application, is FROZEN — its already
 *     built `Region[]` is reused instead of re-walked. Only the growth frontier (the
 *     last loop iteration, a still-running application) is recomputed.
 *
 * The contract is PARITY: `current()` must deep-equal `traceToRegions` on every trace
 * state. That is enforced by `__tests__/trace-region-fold.test.ts` (a strict normalized
 * deep-equal across linear / GEPA-fanout / branch-flip / nested-loop / streaming
 * fixtures). The fold achieves it by NOT re-deriving any region logic — it reuses
 * `regionsAt` / `leafFor` / `attributeFieldEdges` / `derivePorts` / `addPointToHasse`
 * verbatim through the `RegionWalkCtx` seam, so the two paths cannot drift.
 *
 * PHASE 1 is MAIN-THREAD: the fold holds the live `EvalTrace` and reads it for the
 * decision-operand value/provenance (`valueById` / `liveValueById`) — exactly as
 * `traceToRegions` does. Absorbing those live reads into the snapshot mirror is a
 * deferred Phase-2 concern (the worker boundary); see `trace-snapshot.ts`'s header.
 */
import { lipsToJs, type Pair } from "@here.build/arrival-scheme";
import type { PlainInv } from "./trace-snapshot.js";
import { scopeId, staticLoopBodyScopes, staticRecursiveHeads, STRUCTURAL_FORMS } from "./trace-to-forest.js";
import {
  addPointToHasse,
  appendDecisionEdges,
  appendOutput,
  attributeFieldEdges,
  decisionInputProducers,
  derivePorts,
  regionsAt,
  resolveOriginVia,
  routeOf,
  upstreamOfPoint,
  valueProvenance,
  walkSpine,
  type FinalizeCtx,
  type Region,
  type RegionEdge,
  type RegionGraph,
  type RegionWalkCtx,
} from "./trace-to-regions.js";
import type { EvalTrace, Invocation } from "./trace.js";

// The fold reuses the from-scratch SHAPE helpers (`recursionSignals` / `branchLiveness`)
// by EXTENDING the same sets incrementally rather than calling them — `staticLoopBodyScopes`
// / `staticRecursiveHeads` (define-only) re-run lazily on a new define; `STRUCTURAL_FORMS`
// gates the dynamic recursive-head scan.

const EMPTY_NUM: ReadonlySet<number> = new Set();

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";
const hasSelfAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

const BRANCH_FORMS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);

/** Set equality over strings (for live-branch membership change detection). */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Deep-clone a built `Region[]` so a cached iteration template stays pristine while the
 *  returned graph (which `derivePorts` mutates in place) is independent. Ports are reset
 *  to `[]` because the template is captured pre-`derivePorts` and the clone is re-ported
 *  from scratch each `current()`. Only the fields a `Region` actually carries are copied
 *  — structural, not `structuredClone` (which would choke on nothing here but is
 *  needlessly broad). */
function cloneRegions(regions: Region[]): Region[] {
  return regions.map(cloneRegion);
}
function cloneRegion(r: Region): Region {
  switch (r.kind) {
    case "leaf":
      return { ...r };
    case "decision":
      return { ...r };
    case "output":
      return { ...r };
    case "fanout":
      return {
        kind: "fanout",
        id: r.id,
        scope: r.scope,
        stages: r.stages.map((s) => ({ ...s })),
        iterations: r.iterations.map(cloneRegions),
        incoming: r.incoming,
        ...(r.loop !== undefined ? { loop: r.loop } : {}),
        inputs: [],
        outputs: [],
      };
  }
}

/** A cached iteration: the pristine template + the decision wires it contributed during
 *  its first walk. On reuse the template is cloned (into the returned tree) AND the knot
 *  entries are replayed into the live walk collectors — because a reused iteration is NOT
 *  re-walked, so its `<>` knot→arm / operand→knot edges would otherwise be lost. */
interface CachedIteration {
  template: Region[];
  knotArm: { knot: number; arm: number }[];
  knotInputs: { knot: number; from: number }[];
  /** The signal generation the template was built under (see `#signalGen`). Stale when
   *  the generation has since advanced (a branch flipped live, a new loop body / recursive
   *  head appeared) — those change region SHAPE even for a structurally-frozen iteration. */
  gen: number;
}

export class TraceRegionFold {
  readonly #trace: EvalTrace;

  // ── cursor ──────────────────────────────────────────────────────────────────
  /** Next unprocessed invocation id. Ids are monotonic (`trace.ts` `#nextId++`), so
   *  ascending id is the correct fold order and `id ≥ #nextId` is exactly the delta. */
  #nextId = 0;

  // ── snapshot mirror (the growing de-MobX'd PlainInv graph) ────────────────────
  readonly #invById = new Map<number, PlainInv>();
  /** Live invocation refs, for decision-operand value + provenance (KEEP live-read — the
   *  snapshot drops plumbing values; absorbing them is a Phase-2 concern). */
  readonly #liveById = new Map<number, Invocation>();
  /** Ids whose mirror was captured while the live invocation was still `running` — its
   *  lifecycle fields (`state`/`value`/`metadata`/`provenance`) mutate when it later
   *  resolves. `traceToRegions` snapshots them fresh each call, so the fold must REFRESH
   *  these mirrors to stay equal mid-flight (the streaming-correctness fix). Bounded by
   *  the running frontier; an id drops out once it settles. */
  readonly #runningIds = new Set<number>();

  // ── top-level (parentless) forms, in ascending id (= source order) ────────────
  // Tracked incrementally so `current()` does not re-filter all mirrors (O(N)) to find
  // the roots. A top-level form enters once, parentless; ascending id = source order, so
  // the LAST is the program's statement-output form (matching `snap.invocations` order).
  readonly #rootIds: number[] = [];

  // ── points + Hasse edges (incremental transitive reduction) ───────────────────
  readonly #points: PlainInv[] = [];
  readonly #pointIds = new Set<number>();
  readonly #reach = new Map<number, Set<number>>();
  readonly #baseEdges: RegionEdge[] = [];
  /** field-point → producer origin; sound across ticks (`fieldPointMeta` is append-only,
   *  never rewrites an existing entry — see `resolveOriginVia`). */
  readonly #originCache = new Map<number, number>();

  // ── recursion + branch-liveness signals (monotonic) ───────────────────────────
  readonly #recursiveHeads = new Set<string>();
  readonly #loopBodies = new Set<object>();
  /** Cached loop spines: ENTRY invocation id → ordered body-entry ids (= the chain
   *  `nextSameBody` produces). Built in O(Δ) (each new body-entry links to its immediate
   *  same-body ancestor's spine) so `current()` need not re-DFS the recursion — the
   *  spine walk is otherwise O(N) per build (each iteration's subtree holds the next
   *  entry deep inside). `#bodyEntryOf` maps a body-entry id → its loop's entry id. */
  readonly #loopSpines = new Map<number, number[]>();
  readonly #bodyEntryOf = new Map<number, number>();
  /** Per-scope set of branch-invocation ids, and per-invocation its CURRENT route (the
   *  last evaluated child's node). `liveBranchScopes` = scopes whose invocations span ≥2
   *  DISTINCT current routes — exactly `branchLiveness` over the present trace. We store
   *  the route PER INVOCATION (not an accumulating multiset) so a route that SHIFTS as an
   *  arm fills across deltas replaces the old one, matching what a fresh `routeOf` would
   *  read — otherwise a streaming branch would record stale intermediate routes and spuriously
   *  go live. */
  readonly #branchInvsByScope = new Map<string, Set<number>>();
  readonly #branchRouteByInv = new Map<number, object>();
  /** The live-branch scope set, recomputed at the end of each `applyDelta` (cheap —
   *  branches are sparse) and reused by `current()`. */
  #liveBranchScopes = new Set<string>();
  /** Scopes that are DYNAMIC-CAPABLE — at least one of their branch invocations has a
   *  tested operand that traces (via `decisionInputProducers` + provenance) to an
   *  inference point. This is EXACTLY `regionsAt`'s `wired.size > 0` condition, computed
   *  with the same helpers (parity). Monotonic — a producer that is a point stays one — so
   *  it only grows. Why it matters: a non-dynamic branch DISSOLVES (`wired.size===0` →
   *  flatten) whether or not its scope is live, so its regions are IDENTICAL live-or-not.
   *  Only a scope that is BOTH live AND dynamic-capable renders a `<>` marker — so the
   *  iteration cache must invalidate only when the live∩dynamic set changes, NOT on every
   *  liveBranchScopes change. Without this, the GEPA loop's static tail-`if` going live at
   *  the FINAL iteration would clear the whole cache and force a full O(N) re-walk on the
   *  terminal tick (a ~1.4s hitch at 500k) for a change that alters no region. */
  readonly #dynamicCapableScopes = new Set<string>();
  /** Scopes whose dynamic-capability has been determined (checked once — wiredness is a
   *  source-structure property, identical across a scope's invocations, so we never repeat
   *  the O(depth) `#isWired` walk per invocation). */
  readonly #wiredChecked = new Set<string>();
  /** Has any `(define …)` been seen since the static loop/recursion scan last ran? The
   *  static readers depend only on defines, so re-run them lazily when a define arrives. */
  #pendingDefine = false;

  // ── value memo (cleared per current(); mirrors the from-scratch valCache) ──────
  #valCache = new Map<number, unknown>();

  // ── iteration memo (the incremental win) ──────────────────────────────────────
  readonly #iterCache = new Map<number, CachedIteration>();
  /** Generation of the SHAPE-affecting signals — `loopBodies`, `recursiveHeads`, and the
   *  branch ROUTES (which drive `liveBranchScopes`). Bumped by `applyDelta` whenever ANY
   *  of them moves (a new loop body / recursive head, or any branch route changed). A
   *  cached iteration built under an older generation is recomputed — its region SHAPE
   *  may have changed (the branch-flip case: a scope crossing the live threshold turns a
   *  dissolved branch into a `<>` marker in EVERY iteration). Deliberately TRACKS routes
   *  rather than just `liveBranchScopes.size`, because a streaming route shift can change
   *  the live SET without changing its size. Deliberately EXCLUDES `pointIds`: a
   *  structurally-frozen iteration's point membership + operand wiring are fixed (new
   *  points get higher ids, outside its closure), so a new infer elsewhere does not
   *  invalidate it — that is what keeps reuse near-total. */
  #shapeGen = 0;
  /** The `#shapeGen` the iteration cache was last validated against. */
  #cacheGen = -1;

  constructor(trace: EvalTrace) {
    this.#trace = trace;
  }

  /** Static `traceToRegions`-equivalent built through the fold (construct → applyDelta →
   *  current). Used by the parity test as the reference incremental build. */
  static fromTrace(trace: EvalTrace): RegionGraph {
    const fold = new TraceRegionFold(trace);
    fold.applyDelta();
    return fold.current();
  }

  /**
   * Absorb every invocation minted since the last call (id ≥ cursor), in ascending id
   * order, extending the persistent state. Returns the number of new invocations.
   * O(Δ-new-invocations) — the whole point.
   */
  applyDelta(): number {
    // Collect the new invocations across all records, ascending id (the fold order).
    const fresh: Invocation[] = [];
    for (const rec of this.#trace.records.values()) {
      for (const inv of rec.bindings) {
        if (inv.id >= this.#nextId) fresh.push(inv);
      }
    }
    fresh.sort((a, b) => a.id - b.id);
    // Refresh previously-running mirrors even when there are NO new invocations — an
    // in-flight infer can resolve (running → resolved) without minting anything new, and
    // the next `current()` must reflect that (parity with a fresh snapshot).
    this.#refreshRunning();
    if (fresh.length === 0) return 0;

    // ── pass 1: mirror each new invocation as a PlainInv (snapshotTrace's pass 1) ──
    for (const inv of fresh) {
      this.#liveById.set(inv.id, inv);
      const plain = this.#mirror(inv);
      this.#invById.set(inv.id, plain);
      if (plain.state === "running") this.#runningIds.add(inv.id);
      if (inv.parent === null) this.#rootIds.push(inv.id); // parentless top-level form
    }
    // ── pass 2: wire parent/children by id (both endpoints now mirrored) ──────────
    // A new invocation's parent may be OLD (already mirrored) — link both directions.
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (inv.parent) {
        const parentPlain = this.#invById.get(inv.parent.id) ?? null;
        plain.parent = parentPlain;
        // Append to the parent's children IN INVOCATION ORDER. `children` mirrors the
        // live `inv.parent.children` push order; since we process ascending id and a
        // child's id > its parent's, appending as we go reproduces that order — but a
        // parent can gain children across MULTIPLE deltas, so guard against dup.
        if (parentPlain && !parentPlain.children.includes(plain)) parentPlain.children.push(plain);
      }
      // This invocation may also be the PARENT of an already-mirrored child (children
      // always have higher ids, so within one ascending pass the parent is seen first;
      // across deltas a child can never precede its parent). Children of `inv` that are
      // already mirrored get linked when THEY are processed (their own pass-2 step), so
      // nothing to do here for the downward direction.
    }
    // Re-materialize provenance for any OLD invocation whose provenance the snapshot
    // would now keep but didn't when first mirrored. The snapshot keeps provenance only
    // for (a) children of points and (b) roots. A child mirrored BEFORE its parent was
    // known to be a point would have been stored with NO_PROVENANCE — but in practice a
    // child's parent is created (entered) strictly before the child, and point-marking
    // happens at the parent's rosetta-call time (before the child enters), so the parent's
    // `isProvenancePoint` is already set when the child is mirrored. The root case is
    // likewise stable (parentless from birth). So no back-fix pass is needed; asserted by
    // the parity test (which would diverge if a child's provenance were dropped).

    this.#nextId = fresh[fresh.length - 1]!.id + 1;

    // ── recursion + branch signals (extend the monotonic sets) ────────────────────
    this.#extendSignals(fresh);

    // ── loop spines (extend in O(Δ) so current() never re-DFSs the recursion) ──────
    this.#extendSpines(fresh);

    // ── points + Hasse edges (ascending id) ───────────────────────────────────────
    // New points, ascending id (already sorted). A point's children's provenance refers
    // only to lower ids, so its upstream closure is complete the moment it is processed.
    for (const inv of fresh) {
      if (!inv.isProvenancePoint) continue;
      const plain = this.#invById.get(inv.id)!;
      this.#points.push(plain);
      this.#pointIds.add(inv.id);
    }
    // The Hasse edges/reach must be extended in ascending POINT id (the topological order
    // `addPointToHasse` assumes). New points are already ascending in `fresh`.
    for (const inv of fresh) {
      if (!inv.isProvenancePoint) continue;
      const plain = this.#invById.get(inv.id)!;
      const up = upstreamOfPoint(plain, this.#pointIds, this.#trace.fieldPointMeta, this.#originCache);
      const { edges: added } = addPointToHasse(plain.id, up, this.#reach);
      this.#baseEdges.push(...added);
    }

    return fresh.length;
  }

  /**
   * Materialize the current `RegionGraph`. Reuses frozen iterations through the memo so
   * only the growth frontier is re-walked; re-runs field-attribution + ports + the
   * statement-output over the (cheap) edge/region totals. Deep-equal to
   * `traceToRegions(trace)` for the same trace state.
   */
  current(): RegionGraph {
    // liveBranchScopes is maintained by applyDelta (a CHANGE in it bumps #shapeGen).
    const liveBranchScopes = this.#liveBranchScopes;
    // Invalidate the iteration cache iff a SHAPE-affecting signal moved since it was last
    // validated (a new loop body / recursive head, or a live-branch membership change —
    // all captured by `#shapeGen`, bumped in `applyDelta`).
    const gen = this.#shapeGen;
    if (gen !== this.#cacheGen) {
      this.#iterCache.clear();
      this.#cacheGen = gen;
    }

    // Fresh value memo per build (mirrors from-scratch `valCache`; lipsToJs is pure but
    // we keep parity with the one-shot which allocates a fresh cache each call).
    this.#valCache = new Map<number, unknown>();
    const valueById = (id: number): unknown => {
      if (this.#valCache.has(id)) return this.#valCache.get(id);
      const v = lipsToJs(this.#liveById.get(id)?.value);
      this.#valCache.set(id, v);
      return v;
    };
    const liveValueById = (id: number): unknown => this.#liveById.get(id)?.value;

    const knotArm: { knot: number; arm: number }[] = [];
    const knotInputs: { knot: number; from: number }[] = [];

    // The iteration memo (the incremental seam). On a freezable iteration: reuse the
    // cached template (cloned) + replay its knot wires; else compute fresh, and if
    // freezable, cache a pristine clone + the knot delta it produced.
    const iterationCache = (key: number, freezable: boolean, compute: () => Region[]): Region[] => {
      if (freezable) {
        const hit = this.#iterCache.get(key);
        if (hit && hit.gen === gen) {
          for (const k of hit.knotArm) knotArm.push(k);
          for (const k of hit.knotInputs) knotInputs.push(k);
          return cloneRegions(hit.template);
        }
      }
      const armBefore = knotArm.length;
      const inBefore = knotInputs.length;
      const regions = compute();
      if (freezable) {
        this.#iterCache.set(key, {
          template: cloneRegions(regions),
          knotArm: knotArm.slice(armBefore),
          knotInputs: knotInputs.slice(inBefore),
          gen,
        });
      }
      return regions;
    };

    // Cached loop spine — the body-entry list maintained in O(Δ). Falls back to the
    // from-scratch `walkSpine` when an entry has no cached spine (e.g. a loop only
    // dynamically detected after its entries were mirrored), so correctness never depends
    // on cache completeness — the cache is purely the optimization.
    const loopSpine = (entry: PlainInv): PlainInv[] => {
      const ids = this.#loopSpines.get(entry.id);
      if (ids === undefined) return walkSpine(entry);
      return ids.map((id) => this.#invById.get(id)!);
    };

    const ctx: RegionWalkCtx = {
      loopBodies: this.#loopBodies,
      liveBranchScopes,
      pointIds: this.#pointIds,
      valueById,
      liveValueById,
      fieldPointMeta: this.#trace.fieldPointMeta,
      originCache: this.#originCache,
      knotArm,
      knotInputs,
      iterationCache,
      loopSpine,
    };

    // Roots = top-level (parentless) forms, ascending id (= source order, matching
    // `snapshotTrace`'s `invocations` ordering for top-level forms). Tracked
    // incrementally so this is O(#roots), not an O(N) re-filter.
    const tops = this.#rootIds.map((id) => this.#invById.get(id)!);
    const roots = tops.flatMap((t) => regionsAt(t, ctx));

    // Field attribution over a COPY of the base edges (the from-scratch build rewrites in
    // place; we keep #baseEdges pristine for the next tick).
    const finalizeCtx: FinalizeCtx = {
      points: this.#points,
      pointIds: this.#pointIds,
      reach: this.#reach,
      fieldPointMeta: this.#trace.fieldPointMeta,
      originCache: this.#originCache,
    };
    const edges = attributeFieldEdges(this.#baseEdges, finalizeCtx);

    // Decision wires, then the statement-output terminal (final = last top-level form).
    appendDecisionEdges(edges, knotArm, knotInputs);
    appendOutput(roots, edges, tops[tops.length - 1], finalizeCtx);

    // Stage 2a — container boundary ports (mutates the cloned/fresh fanout objects).
    derivePorts(roots, edges);

    return { roots, edges, warnings: [] };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /** Re-read the lifecycle fields of every mirror captured while still running; once it
   *  has settled (resolved/rejected) refresh its `state`/`value`/`metadata`/`provenance`
   *  to the live values and drop it from the running set. This is what keeps the fold's
   *  mirror equal to a fresh `snapshotTrace` mid-flight — a leaf parked at mirror time and
   *  resolved later would otherwise show stale `running`/`undefined`. The lifecycle fields
   *  re-use the EXACT materialization predicates `#mirror` (and `snapshotTrace`) apply.
   *
   *  NOTE (documented residual): a point whose ARGUMENT is itself a still-running infer
   *  (infer-as-infer-arg) could have been added to the Hasse with an incomplete upstream;
   *  re-deriving point edges on a child's late provenance change is a Phase-2 concern. The
   *  common streaming shape (an infer reading PRIOR results via let-bindings) resolves its
   *  arg subtree before parking, so its upstream is complete when first added. */
  #refreshRunning(): void {
    if (this.#runningIds.size === 0) return;
    for (const id of [...this.#runningIds]) {
      const live = this.#liveById.get(id);
      const plain = this.#invById.get(id);
      if (!live || !plain) {
        this.#runningIds.delete(id);
        continue;
      }
      if (live.state === "running") continue; // still in flight — re-check next tick.
      const isPoint = plain.isProvenancePoint;
      const isRoot = plain.parent === null;
      const isBranchChild = BRANCH_FORMS.has(this.#headName(plain.parent?.node) ?? "");
      plain.state = live.state;
      plain.value = isPoint || isRoot || isBranchChild ? lipsToJs(live.value) : undefined;
      plain.metadata = isPoint ? live.metadata : undefined;
      // Provenance is materialized for children-of-points + roots (snapshot predicate);
      // it is computed at the live invocation's exit, so re-copy it now it has settled.
      if (plain.parent?.isProvenancePoint || isRoot) plain.provenance = new Set(live.provenance);
      this.#runningIds.delete(id);
    }
  }

  /** Mirror ONE live invocation as a PlainInv exactly as `snapshotTrace` pass 1 does:
   *  scalar fields + pre-derived `scope` + the selective provenance/value/metadata
   *  materialization. Parent/children are wired in pass 2 (`applyDelta`). */
  #mirror(inv: Invocation): PlainInv {
    const isPoint = inv.isProvenancePoint;
    const isRoot = inv.parent === null;
    const isBranchChild = BRANCH_FORMS.has(this.#headName(inv.parent?.node) ?? "");
    return {
      id: inv.id,
      node: inv.node,
      scope: scopeId(inv.node),
      parent: null,
      children: [],
      provenance: inv.parent?.isProvenancePoint || isRoot ? new Set(inv.provenance) : EMPTY_NUM,
      isProvenancePoint: isPoint,
      value: isPoint || isRoot || isBranchChild ? lipsToJs(inv.value) : undefined,
      metadata: isPoint ? inv.metadata : undefined,
      state: inv.state,
    };
  }

  /** Head name of a live Pair (the snapshot's `headName` helper, inlined). */
  #headName(node: Pair | undefined): string | undefined {
    const car = (node as { car?: unknown } | undefined)?.car;
    const n = (car as { __name__?: unknown } | undefined)?.__name__;
    return typeof n === "string" ? n : undefined;
  }

  /** Extend the recursion + branch-liveness signal sets with the new invocations. The
   *  STATIC loop/recursion readers depend only on `(define …)` forms, so re-run them only
   *  when a define arrived; the DYNAMIC scans (`hasSelfAncestor`) are applied per new inv;
   *  branch routes are accumulated per new branch invocation. All monotonic. */
  #extendSignals(fresh: Invocation[]): void {
    const headsBefore = this.#recursiveHeads.size;
    const bodiesBefore = this.#loopBodies.size;
    // Did a define arrive? (static recursion readers depend on defines.)
    for (const inv of fresh) {
      if (headOf(this.#invById.get(inv.id)!) === "define") {
        this.#pendingDefine = true;
        break;
      }
    }
    // Re-run the static readers over ALL mirrored invocations when a define is pending.
    // (They are idempotent — adding to a Set — and bounded by define count, not N; the
    // GEPA trace has 3 defines total, scanned once.)
    if (this.#pendingDefine) {
      const all = [...this.#invById.values()];
      for (const h of staticRecursiveHeads(all)) this.#recursiveHeads.add(h);
      for (const b of staticLoopBodyScopes(all)) this.#loopBodies.add(b);
      this.#pendingDefine = false;
    }
    // Dynamic recursive-head scan (an application recurring on its own ancestor chain).
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (STRUCTURAL_FORMS.has(headOf(plain))) continue;
      if (hasSelfAncestor(plain)) this.#recursiveHeads.add(headOf(plain));
    }
    // Dynamic loop-body scan (a re-entrant body under a recursive-head call).
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (plain.parent && hasSelfAncestor(plain) && this.#recursiveHeads.has(headOf(plain.parent))) {
        this.#loopBodies.add(plain.node as object);
      }
    }
    // Branch-route liveness (the LAST evaluated child's node identity = the taken route).
    // A branch's route can CHANGE across deltas (its last child shifts as the arm fills),
    // so we recompute the route for every branch invocation touched this delta — a branch
    // in `fresh`, or an OLD branch whose child set grew (a parent-of-fresh that is a
    // branch). We store the route PER INVOCATION, so a shift REPLACES the prior route
    // (no stale accumulation) — keeping `liveBranchScopes` identical to a fresh scan.
    const branchTouched = new Set<number>();
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (BRANCH_FORMS.has(headOf(plain))) branchTouched.add(plain.id);
      const par = plain.parent;
      if (par && BRANCH_FORMS.has(headOf(par))) branchTouched.add(par.id);
    }
    // A transient lipsToJs memo for the operand-value reads decisionInputProducers needs.
    const valCache = new Map<number, unknown>();
    const valueById = (vid: number): unknown => {
      if (valCache.has(vid)) return valCache.get(vid);
      const v = lipsToJs(this.#liveById.get(vid)?.value);
      valCache.set(vid, v);
      return v;
    };
    const renderableBefore = this.#renderableBranchScopes();
    for (const id of branchTouched) {
      const plain = this.#invById.get(id)!;
      const scope = scopeId(plain.node);
      (this.#branchInvsByScope.get(scope) ?? this.#branchInvsByScope.set(scope, new Set()).get(scope)!).add(id);
      this.#branchRouteByInv.set(id, routeOf(plain));
      // Dynamic-capability — EXACTLY regionsAt's wired test (so live∩dynamic == the set of
      // scopes that actually render a `<>`). Wiredness is a property of the SOURCE
      // structure (does the operand's binding trace to an infer), so it is the SAME for
      // every invocation of a scope — check ONCE per scope (the `#isWired` resolveRaw walk
      // is O(ancestor-depth), so checking all 1000 loop-`if` invocations would be O(N²)).
      // Mark "checked" only when the verdict is DETERMINATE: if any tested operand's
      // producer is still RUNNING, its provenance may not be stamped yet, so re-check next
      // delta (keeps the streaming verdict sound — a branch fed by an in-flight infer).
      if (!this.#wiredChecked.has(scope)) {
        if (this.#isWired(plain, valueById)) {
          this.#dynamicCapableScopes.add(scope);
          this.#wiredChecked.add(scope);
        } else if (this.#operandsResolved(plain)) {
          this.#wiredChecked.add(scope);
        }
      }
    }
    // Recompute the live-branch scope set (sparse — branches are few). A scope is live iff
    // its invocations span ≥2 DISTINCT current routes (exactly `branchLiveness`).
    const liveBranchScopes = new Set<string>();
    for (const [scope, invs] of this.#branchInvsByScope) {
      const routes = new Set<object>();
      for (const invId of invs) {
        const r = this.#branchRouteByInv.get(invId);
        if (r !== undefined) routes.add(r);
        if (routes.size >= 2) break;
      }
      if (routes.size >= 2) liveBranchScopes.add(scope);
    }
    this.#liveBranchScopes = liveBranchScopes;
    // Bump the shape generation iff a SHAPE-affecting signal moved — a new loop body /
    // recursive head, or a change in the RENDERABLE branch set (live ∩ dynamic-capable).
    // A liveBranchScopes change for a STATIC (dissolving) branch alters no region, so it
    // must NOT invalidate the cache — that is what prevents the terminal-iteration full
    // re-walk on the GEPA loop's static tail-`if`.
    const renderableChanged = !sameStringSet(this.#renderableBranchScopes(), renderableBefore);
    if (this.#recursiveHeads.size !== headsBefore || this.#loopBodies.size !== bodiesBefore || renderableChanged) {
      this.#shapeGen += 1;
    }
  }

  /** The scopes that actually render a `<>` marker: live AND dynamic-capable. The cache
   *  invalidates only when THIS set changes (region shape depends on it, not on raw
   *  liveBranchScopes — a dissolving static branch flattens identically live-or-not). */
  #renderableBranchScopes(): Set<string> {
    const out = new Set<string>();
    for (const scope of this.#liveBranchScopes) if (this.#dynamicCapableScopes.has(scope)) out.add(scope);
    return out;
  }

  /** Whether a branch invocation has ≥1 tested operand tracing to an inference point —
   *  EXACTLY `regionsAt`'s `wired.size > 0` (same helpers, same provenance resolution). */
  #isWired(inv: PlainInv, valueById: (id: number) => unknown): boolean {
    for (const { producerId } of decisionInputProducers(inv, valueById)) {
      if (this.#pointIds.has(producerId)) return true;
      for (const p of valueProvenance(this.#liveById.get(producerId)?.value)) {
        if (this.#pointIds.has(resolveOriginVia(p, this.#trace.fieldPointMeta, this.#originCache))) return true;
      }
    }
    return false;
  }

  /** Whether every operand producer of a branch invocation has SETTLED (not running) —
   *  so a "not wired" verdict is final (the operand's provenance won't grow later). Used to
   *  decide whether to lock in the dynamic-capability check or defer it. */
  #operandsResolved(inv: PlainInv): boolean {
    const valueById = (vid: number): unknown => lipsToJs(this.#liveById.get(vid)?.value);
    for (const { producerId } of decisionInputProducers(inv, valueById)) {
      if (this.#liveById.get(producerId)?.state === "running") return false;
    }
    return true;
  }

  /** Extend the per-loop body-entry spines in O(Δ). For each NEW body-entry (an invocation
   *  whose node is a loop body), link it to its loop's spine: its IMMEDIATE same-body
   *  ancestor (the previous iteration's entry) is found by a bounded ancestor walk (one
   *  iteration's nesting depth, NOT the spine length), and the new entry appends to THAT
   *  entry's spine. A body-entry with no same-body ancestor STARTS a new spine. This
   *  reconstructs exactly the `nextSameBody` chain (the inverse: B's nearest same-body
   *  ancestor P ⟺ B = nextSameBody(P)), so `current()` reads the spine instead of
   *  re-DFSing it — turning the otherwise-O(N)-per-build spine walk into O(spine length). */
  #extendSpines(fresh: Invocation[]): void {
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (!this.#loopBodies.has(plain.node as object)) continue;
      // Nearest same-body ancestor (the previous iteration's body-entry), bounded depth.
      let p: PlainInv | null = plain.parent;
      while (p && p.node !== plain.node) p = p.parent;
      if (p) {
        // A later iteration: append to the loop's spine owned by p's entry.
        const entryId = this.#bodyEntryOf.get(p.id);
        if (entryId !== undefined) {
          this.#bodyEntryOf.set(plain.id, entryId);
          this.#loopSpines.get(entryId)?.push(plain.id);
        }
        // ELSE p was mirrored BEFORE its node became a loop body (dynamic detection), so
        // the true entry is unrecorded — DON'T start a spurious spine here. `current()`
        // sees no spine for the true entry and falls back to the correct `walkSpine`.
        continue;
      }
      // First body-entry of a loop instance → start a new spine.
      this.#bodyEntryOf.set(plain.id, plain.id);
      this.#loopSpines.set(plain.id, [plain.id]);
    }
  }
}
