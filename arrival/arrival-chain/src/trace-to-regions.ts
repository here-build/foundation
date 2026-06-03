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
 * TCO containers: a self-recursive function (`loop ⊃ … ⊃ loop`, detected the same
 * way `traceToForest` does — a non-structural application that recurs on its own
 * ancestor chain) is peeled into one `fanout` container whose N iterations are the
 * successive body entries. The trampoline collapses the host stack, but the trace's
 * `currentInvocation` parent-link still chains, so the recursion spine is walkable.
 * Each iteration = that call's children, CUT at the next recursive call (so the next
 * iteration's body doesn't leak in); the recursive call's argument eval (e.g. the
 * `reflect` that seeds the next iteration) rides in as an arg, so nothing is lost —
 * it surfaces at the head of the iteration whose input it produced.
 *
 * Sequential loop iterations reuse the `fanout` container (Z-tab render, one shown
 * at a time) rather than a distinct kind — V's call. `tailPosition` (the evaluator's
 * R7RS §3.5 ground truth, on `Invocation`) is available if we later want to label
 * proper-TCO vs stack-growing recursion; detection here is structural so it covers
 * both. PERF: a very long loop builds an O(N)-deep `currentInvocation` chain; the
 * spine walk is O(N) total (early-return DFS), bounded by that existing depth.
 */
import { snapshotTrace, type PlainInv } from "./trace-snapshot.js";
import { scopeId, staticLoopBodyScopes, staticRecursiveHeads, STRUCTURAL_FORMS } from "./trace-to-forest.js";
import type { EvalTrace } from "./trace.js";

export type Region =
  | {
      kind: "leaf";
      id: number;
      label: string;
      /** Stable STRUCTURAL identity (`head@line:col`) — the same string for every
       *  iteration of one `(infer …)` call. The render keys a container's boundary
       *  ports by this, so a `map`/loop body that runs N times emits ONE exit port
       *  per structural producer (one dataflow), not N (one per value). */
      scope: string;
      nodeKind: "direct" | "prompt";
      /** Node metadata bound via `resultWithProvenance` — a `.prompt` leaf carries
       *  `{ kind:"prompt", path, model, inputs }`; a bare `(infer …)` has none. The
       *  render draws the node's card from this. */
      meta?: unknown;
      /** The resolved inference result (`undefined` while still running). */
      value?: unknown;
      /** running | resolved | rejected — pending vs result vs error in the card. */
      state: "running" | "resolved" | "rejected";
    }
  | {
      /** A `<>` DECISION MARKER — the point a live branch (`if`/`cond`/…) decided
       *  one way HERE. It does NOT box or fork the flow: the divergence between
       *  arms is already absorbed by the enclosing autonomous region's iteration
       *  picker (map/filter/TCO Z-tabs), so the marker only annotates "a decision
       *  was made here". The taken arm's content follows it as ordinary siblings. */
      kind: "decision";
      id: number;
      /** The branch head — `if` | `cond` | `case` | `when` | `unless`. */
      label: string;
      /** Stable source-location identity (`head@line:col`) of the branch site. */
      scope: string;
    }
  | {
      kind: "fanout";
      id: number;
      /** The fused transform breadcrumb, outermost→innermost. ONE entry = a plain
       *  `map`/`filter`/TCO `loop`; SEVERAL = a fused chain (`map ▸ filter ▸ map`)
       *  the cleanup pass collapsed into one frame. Each carries its own invocation
       *  id so the render can later cmd-click-navigate to that stage's call site.
       *  For ELK the whole fanout — chain included — is ONE node, never its stages. */
      stages: { label: string; id: number }[];
      /** Distinct iterations, MEANINGFUL ones only (degenerate — no inference
       *  inside — pruned by the cleanup pass). The render stacks them on Z-tabs. */
      iterations: Region[][];
      /** Raw incoming invocation count BEFORE pruning. `iterations.length` is how
       *  many carried inference — the banner reads "10 incoming, 5 mattered". */
      incoming: number;
      /** True when this container is a TCO SELF-RECURSION loop (peeled from a body
       *  that re-enters itself in tail position), as opposed to a `map`/`filter`
       *  fan-out over a collection. The render draws a loop-back arc on the frame —
       *  a wire leaving the contour and pointing back into it — so recursion reads
       *  as recursion, not as an N-way fan. */
      loop?: boolean;
    }
  | {
      /** The program's final STATEMENT OUTPUT — the value the last top-level
       *  expression returned. A single terminal node the whole graph flows into,
       *  wired from its immediate producers (the last infer/region its value came
       *  from). Rendered as a small terminal card, not a producer leaf. */
      kind: "output";
      id: number;
      value: unknown;
      state: PlainInv["state"];
    };

export interface RegionGraph {
  /** Top-level meaningful regions, plumbing flattened away. */
  roots: Region[];
  /** Dataflow wires between leaf invocation ids (producer → consumer). `field` is
   *  the consumer's INPUT slot the producer's value flowed into — the named kwarg of
   *  a `.prompt` consumer (`"analysis"` for `… :analysis a`), DERIVED by matching the
   *  producer's value against the consumer's `inputs` dict (not stored in the model:
   *  it's recoverable from data already captured). Absent when the consumer isn't a
   *  `.prompt`, or when the value was PROJECTED/transformed before it reached the
   *  slot (then `inputs[k] !== producer.value` and the match honestly declines —
   *  attributing a projected input needs provenance-on-value, the v1 follow-up). */
  edges: { from: number; to: number; field?: string }[];
  warnings: string[];
}

/** Heads that fan out: each applies a function across a collection. */
const FANOUT: ReadonlySet<string> = new Set(["map", "filter", "fold", "fold-left", "fold-right", "for-each", "mapcat", "flat-map", "flatmap"]);

/** DNF control forms — the branching shapes. A branch is INVISIBLE plumbing by
 *  default (the taken arm flattens through), and becomes a rendered container
 *  ONLY when the SAME source-location branch was exercised ≥2 distinct ways
 *  across the whole trace (see `liveBranchScopes`). An always-one-way branch is
 *  seamless — in THIS run it never decided anything, so it isn't a decision. */
const BRANCH_FORMS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";

/** The rosetta heads of a DIRECT, user-written inference call. A provenance point
 *  whose head is one of these is a raw `(infer …)` / `(infer/chat …)`. Any OTHER
 *  provenance point is a `.prompt` proc — now an opaque native proc, so its
 *  invocation IS the `(run-x …)` call at the real source location (head = the
 *  binding `run-x`). The old line-1 lambda-unwrap heuristic is gone with it. */
const DIRECT_INFER_HEADS: ReadonlySet<string> = new Set(["infer", "infer/chat"]);

/** Classify an infer provenance point by its head: a direct `(infer/chat …)` →
 *  `direct`, labelled by the rosetta head; a `.prompt` call `(run-x …)` →
 *  `prompt`, labelled by the binding `run-x` at its real source location. */
function leafFor(inv: PlainInv): Extract<Region, { kind: "leaf" }> {
  const head = headOf(inv);
  return {
    kind: "leaf",
    id: inv.id,
    label: head,
    scope: scopeId(inv.node),
    nodeKind: DIRECT_INFER_HEADS.has(head) ? "direct" : "prompt",
    meta: inv.metadata,
    value: inv.value,
    state: inv.state,
  };
}

/** A non-structural application that recurs on its own ancestor chain — the same
 *  loop-detection `traceToForest` uses (a recursive APPLICATION, not a re-entrant
 *  special form). `let`/`if`/`begin` re-enter every iteration, so they're excluded. */
const hasSelfAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

export function traceToRegions(trace: EvalTrace): RegionGraph {
  const snap = snapshotTrace(trace);
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // Wires: upstream(X) = ⋃ over X's children of child.provenance, ∩ points.
  // Provenance accumulates TRANSITIVELY (a value carries every ancestor point it
  // ever flowed through), so this raw set is a near-complete DAG — O(points²)
  // wires, almost all of them implied by a shorter path. On a real trace that's
  // thousands of edges over ~100 points, and ELK's layered crossing-minimization
  // is superlinear in edge count → the render stalls. Reduce to the Hasse diagram
  // (transitive reduction): keep u→x only when no OTHER upstream w of x already
  // reaches u (u→…→w→x makes the direct u→x redundant). The skeleton that's left
  // is the genuine causal structure, and it lays out fast.
  // Field points (`(:verdict obj)`, `(:next obj)` — KEYWORD_ACCESSOR_FIELD invocations)
  // carry provenance but are NOT rendered leaves: they're a field pluck off a real
  // producer. A consumer that reads `(:verdict (car reactions))` has the FIELD point
  // in its provenance, not the react infer directly — so naively `∩ points` drops it
  // and the producer→consumer wire vanishes (every reflect ended up isolated). Resolve
  // each id to its concrete origin: follow `fieldPointMeta` to the underlying producer,
  // chasing chains (`:verdict` of a `:next` of an infer → the infer). THIS is what
  // restores the in-block react→reflect dataflow.
  // Memoized: with transitive provenance the SAME id appears across O(points²)
  // provenance entries, so chasing its `fieldPointMeta` chain each time dominated
  // the build (profiled at ~50% of region construction). The resolution is a pure
  // function of the id; cache it so each id's chain is walked at most once.
  const originCache = new Map<number, number>();
  const resolveOrigin = (id: number): number => {
    const cached = originCache.get(id);
    if (cached !== undefined) return cached;
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const meta = snap.fieldPointMeta.get(cur);
      if (!meta) break;
      cur = meta.origin;
    }
    originCache.set(id, cur);
    return cur;
  };
  const upstreamOf = new Map<number, Set<number>>();
  for (const x of points) {
    const up = new Set<number>();
    for (const c of x.children)
      for (const p of c.provenance) {
        const o = resolveOrigin(p);
        if (o !== x.id && pointIds.has(o)) up.add(o);
      }
    upstreamOf.set(x.id, up);
  }
  // Ascending id is a valid topological order — a point's id is minted after every
  // point it can depend on — so each node's reachable-ancestor closure is complete
  // before any consumer reads it. `reach[x]` = all ancestors reachable from x.
  const EMPTY: ReadonlySet<number> = new Set();
  const reach = new Map<number, Set<number>>();
  const edges: { from: number; to: number; field?: string }[] = [];
  for (const x of [...pointIds].sort((a, b) => a - b)) {
    const up = upstreamOf.get(x) ?? EMPTY;
    const closure = new Set<number>();
    for (const u of up) {
      closure.add(u);
      for (const a of reach.get(u) ?? EMPTY) closure.add(a);
    }
    for (const u of up) {
      // u→x is redundant iff another upstream w of x already reaches u.
      let redundant = false;
      for (const w of up) {
        if (w !== u && (reach.get(w) ?? EMPTY).has(u)) { redundant = true; break; }
      }
      if (!redundant) edges.push({ from: u, to: x });
    }
    reach.set(x, closure);
  }

  // Recursive-function heads (loops), unioned from two readers. The STATIC AST
  // scan knows a function loops the moment it's defined — so a streaming loop is a
  // container from iteration 0, before its async-infer successor fires (without
  // this, gepa's `evolve` only boxes at the very end, reshaping the graph mid-run).
  // The DYNAMIC scan (`hasSelfAncestor`) catches anything the static reader misses.
  const recursiveHeads = staticRecursiveHeads(snap.invocations);
  for (const inv of snap.invocations) {
    if (STRUCTURAL_FORMS.has(headOf(inv))) continue;
    if (hasSelfAncestor(inv)) recursiveHeads.add(headOf(inv));
  }

  // Loop BODY scopes — the Pair a recursive fn evaluates each call, entered ×K.
  // We box the body (NOT the call site) so the top-level call and the in-body
  // recursive call — DIFFERENT Pairs — both feed the one container (forest's
  // trick). The forest's rule adds the body Pair when a re-entrant body sits
  // under a recursive call; storing Pairs means the first, non-re-entrant body
  // entry joins by identity too.
  // Loop body scopes from TWO sources. The STATIC set is the exact body Pairs of
  // statically-recursive defines — present from iteration 0, so the container shows
  // midway (not only on completion) WITHOUT mis-tagging the recursive call's own
  // argument evaluations as bodies. The DYNAMIC rule (parent is a recursive call
  // AND the body has already re-entered) covers loops the static reader can't see
  // (mutual recursion); it only fires once recursion is underway, which is fine —
  // those weren't streaming-stalled.
  const loopBodies = staticLoopBodyScopes(snap.invocations);
  for (const inv of snap.invocations) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveHeads.has(headOf(inv.parent))) {
      loopBodies.add(inv.node as object);
    }
  }
  // The spine walk is SAME-LOOP-scoped, keyed on the body AST node identity: every
  // iteration of ONE loop re-enters the SAME body Pair (the source AST is shared
  // across trampoline bounces), so a loop is the chain of invocations carrying that
  // exact node. Matching "any loop body" instead breaks the moment a loop body
  // nests ANOTHER loop (gepa's `evolve` body runs `sample-batch` and `find-merge`,
  // both recursive): the walk would jump into the inner loop and cut `evolve`'s own
  // per-iteration work. Node-identity keeps each loop on its own spine, and a nested
  // DIFFERENT loop simply renders as its own container inside the iteration.
  //
  // Re-entry of the SAME loop (an ancestor shares this body's node) → a later
  // iteration the entry already owns; cut it (return [] at the entry guard).
  const hasSameBodyAncestor = (inv: PlainInv): boolean => {
    for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
    return false;
  };
  // The SAME loop's next iteration: shallowest descendant re-entering THIS body
  // node. Early-return DFS, so summed over the spine the walk is O(N), not O(N²).
  const nextSameBody = (entry: PlainInv): PlainInv | undefined => {
    const find = (n: PlainInv): PlainInv | undefined => {
      for (const c of n.children) {
        if (c.node === entry.node) return c;
        const deep = find(c);
        if (deep) return deep;
      }
      return undefined;
    };
    return find(entry);
  };

  // LIVE-BRANCH detection. A branch form `(if …)`/`(cond …)`/… earns a `<>`
  // decision marker only when its SOURCE-LOCATION scope took ≥2 distinct routes
  // across the whole trace — i.e. it actually decided differently at least once.
  // The "route" a single branch invocation took is the identity of its LAST
  // evaluated child's node: evaluation order puts the test(s) first and the chosen
  // arm/body last, so the last child IS the taken arm (or the test itself when the
  // arm was a bare atom with no sub-invocation — still a distinct route from an
  // inference-bearing arm: "sometimes ran the infer arm, sometimes didn't"). One
  // distinct route ⇒ the branch always went the same way ⇒ seamless plumbing.
  //
  // No loop-control exclusion: a recursive fn's tail `if` (recurse vs base-case)
  // that IS the loop body is already claimed by the loop CONTAINER (the loopBodies
  // case runs before branch handling), so it never reaches the marker. The OTHER
  // control branches inside a loop body (genetic-vs-reflective, gate pass/fail) ARE
  // the midway decisions we want to mark — a marker doesn't box, so there's nothing
  // to double-draw even when an arm routes onward to the recursive call.
  const BRANCH_VOID: object = Symbol("branch-route-void") as unknown as object;
  const routeOf = (inv: PlainInv): object => (inv.children.length > 0 ? inv.children[inv.children.length - 1]!.node : BRANCH_VOID);
  const branchRoutes = new Map<string, Set<object>>();
  for (const inv of snap.invocations) {
    if (!BRANCH_FORMS.has(headOf(inv))) continue;
    const scope = scopeId(inv.node);
    (branchRoutes.get(scope) ?? branchRoutes.set(scope, new Set()).get(scope)!).add(routeOf(inv));
  }
  const liveBranchScopes = new Set<string>();
  for (const [scope, routes] of branchRoutes) {
    if (routes.size >= 2) liveBranchScopes.add(scope);
  }

  // `<>` knot id → the chosen arm's RESULT leaf id, collected during the walk. A
  // branch returns its taken arm's value, and `regionsAt` emits that arm's own leaf
  // LAST (eval order: test first, chosen value last) — so the final leaf in a knot's
  // inner regions is the producer whose value the branch yielded. We seat the knot at
  // the head of that producer's flow once the walk is done.
  const knotArm: { knot: number; arm: number }[] = [];
  const lastLeafId = (rs: Region[]): number | undefined => {
    for (let i = rs.length - 1; i >= 0; i--) if (rs[i]!.kind === "leaf") return rs[i]!.id;
    return undefined;
  };

  const regionsAt = (inv: PlainInv): Region[] => {
    if (inv.isProvenancePoint) {
      // A point is an ATOMIC card — but its ARGUMENT subtree can hold OTHER points
      // (a nested `(infer …)`) or a live branch (`… :failures (list (pick n)))`).
      // Those carry the very provenance that wires INTO this consumer, so if we
      // returned the bare leaf they'd never render and their edges would dangle
      // from nothing. HOIST them as PRECEDING siblings: the producers a card
      // depends on draw before it, the card itself stays atomic, and every wire
      // lands on a rendered node. (The point's OWN value still flows downstream
      // via its leaf id, unchanged.)
      const hoisted = inv.children.flatMap(regionsAt);
      return [...hoisted, leafFor(inv)];
    }

    if (loopBodies.has(inv.node as object)) {
      // A re-entrant body (an ancestor is the same loop's body) is the next
      // iteration; the loop ENTRY's spine walk owns it. Reached via flatten →
      // CUT, so the next iteration's body doesn't leak into this one.
      if (hasSameBodyAncestor(inv)) return [];

      // Loop ENTRY (the first body entry) → one fanout container; iterations =
      // the spine of body entries, each cut at the next. The recursive call's
      // arg eval (the `reflect` that seeds the next iteration) lives OUTSIDE the
      // next body, so it stays in THIS iteration — correct: this iteration
      // computed it. Sequential iters reuse `fanout` (Z-tabs) per V's call.
      const iterations: Region[][] = [];
      let incoming = 0;
      for (let body: PlainInv | undefined = inv; body; body = nextSameBody(body)) {
        incoming += 1;
        const regions = body.children.flatMap(regionsAt);
        if (regions.length > 0) iterations.push(regions);
      }
      // Degenerate container (no inference anywhere in the loop) → drop it. The
      // cleanup is INLINE: an empty fanout never materializes, so an outer frame
      // whose only child was this loop also flattens to nothing and collapses too.
      if (iterations.length === 0) return [];
      // Label by the recursive fn name (the call head, e.g. `loop`), not the
      // body form (`let`).
      const label = inv.parent ? headOf(inv.parent) : headOf(inv);
      return [{ kind: "fanout", id: inv.id, stages: [{ label, id: inv.id }], iterations, incoming, loop: true }];
    }

    if (FANOUT.has(headOf(inv))) {
      // Iterations = the application children (those carrying a body). The
      // eval'd-once args (lambda, collection) have no children → excluded.
      const applChildren = inv.children.filter((c) => c.children.length > 0);
      // An iteration that flattens to nothing meaningful is dropped; `incoming`
      // keeps the RAW count so the banner can say "10 incoming, 5 mattered".
      const iterations = applChildren.map((c) => regionsAt(c)).filter((r) => r.length > 0);
      // Degenerate container (mapped/filtered over non-inference data) → drop it.
      if (iterations.length === 0) return [];
      return [{ kind: "fanout", id: inv.id, stages: [{ label: headOf(inv), id: inv.id }], iterations, incoming: applChildren.length }];
    }

    // A LIVE branch (decided ≥2 ways trace-wide) does NOT box — boxing every `if`
    // makes branches dominate and shatters a TCO loop whose body IS an `if` into a
    // nested tower of boxes (the loop never peels). Instead drop a `<>` DECISION
    // MARKER at the site and flatten through to the arm it took: the divergence is
    // already carried by the enclosing autonomous region's iteration picker, so the
    // marker just says "here's where the decision was made". An arm with no rendered
    // content this time (a bare-atom route) yields nothing → no marker either.
    // (A branch that IS a loop body was already claimed above; a seamless one-way
    // branch isn't live and falls through to plain plumbing.)
    if (BRANCH_FORMS.has(headOf(inv)) && liveBranchScopes.has(scopeId(inv.node))) {
      const inner = inv.children.flatMap(regionsAt);
      if (inner.length === 0) return [];
      const arm = lastLeafId(inner);
      if (arm !== undefined) knotArm.push({ knot: inv.id, arm });
      return [{ kind: "decision", id: inv.id, label: headOf(inv), scope: scopeId(inv.node) }, ...inner];
    }

    return inv.children.flatMap(regionsAt); // plumbing: flatten through
  };

  // Consumer-field attribution (DERIVED, render-only-grade — never stored). For a
  // `.prompt` consumer, find which named input the producer flowed into.
  //
  // SOUND path (`inputsProvenance`): the rosetta membrane threaded each input's
  // DEEP provenance (per-element origins, not the value itself) through to the
  // node's metadata. The producer `e.from` flowed into field `k` iff k's
  // origin-resolved provenance closure contains it. This survives packing into a
  // list — `(list react.verdict …)` keeps each element's origin — where a
  // whole-value compare would only ever see the array, not its sources. Precise
  // because the edges are Hasse-reduced (immediate producers only), so a transitive
  // ancestor in the same closure can't steal the attribution.
  //
  // FALLBACK (structural value match): older traces with no `inputsProvenance`.
  // Match the producer's resolved value against the consumer's `inputs` dict by
  // stable JSON. Declines (leaves `field` unset) when the slot holds a PROJECTION
  // rather than the value — the honest "this input is a transform, not the source".
  const pointById = new Map(points.map((p) => [p.id, p]));
  const asJson = (v: unknown): string | undefined => {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };
  for (const e of edges) {
    const consumer = pointById.get(e.to);
    const meta = consumer?.metadata as
      | { kind?: string; inputs?: Record<string, unknown>; inputsProvenance?: Record<string, number[]> }
      | undefined;
    if (!meta || meta.kind !== "prompt" || !meta.inputs) continue;

    if (meta.inputsProvenance) {
      let matched = false;
      for (const [k, ids] of Object.entries(meta.inputsProvenance)) {
        if (ids.some((id) => resolveOrigin(id) === e.from)) {
          e.field = k;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    const producer = pointById.get(e.from);
    if (!producer || producer.value === undefined) continue;
    const pv = asJson(producer.value);
    if (pv === undefined) continue;
    for (const [k, v] of Object.entries(meta.inputs)) {
      if (asJson(v) === pv) {
        e.field = k;
        break;
      }
    }
  }

  const tops = snap.invocations.filter((i) => !i.parent);
  const roots = tops.flatMap(regionsAt);

  // Wire each `<>` knot to the arm it chose THIS run. A live branch is degenerate
  // WITHIN a single tab (one arm ran), so on its own the marker has no dataflow and
  // floats detached — but across the enclosing block's Z-tabs the SAME code point
  // took DIFFERENT arms, which is exactly what the knot exists to say. We surface
  // that by seating it at the HEAD of the chosen arm's flow: a single edge knot→arm
  // to the leaf the branch yielded this run (captured during the walk). The chain
  // then reads `<> → spark → digest` where the arm feeds downstream, and `<> → spark`
  // where it doesn't — a junction on the spaghetti instead of an orphan box. The
  // knot's id is the branch invocation id (never a provenance point), so it only
  // ever appears as an edge SOURCE here; nothing upstream targets it. Branch
  // invocations carry no materialized provenance (trace-snapshot only retains it for
  // children-of-points and roots), so we seat the knot via the arm's own leaf, not a
  // provenance scan.
  for (const { knot, arm } of knotArm) edges.push({ from: knot, to: arm });

  // The program's STATEMENT OUTPUT — the value the LAST top-level expression
  // returned. Render it as a terminal node the graph flows into, but only when
  // there's a graph to terminate (some inference happened) and the final form
  // actually produced a value (not a trailing `define`). Wire it from its
  // IMMEDIATE producers: the provenance origins of the returned value, Hasse-
  // reduced against each other so only the last region(s) it came from connect —
  // the same transitive-reduction the dataflow edges use.
  const OUTPUT_ID = -1;
  const final = tops[tops.length - 1];
  if (roots.length > 0 && final && final.value !== undefined) {
    const origins = new Set<number>();
    for (const p of final.provenance) {
      const o = resolveOrigin(p);
      if (pointIds.has(o)) origins.add(o);
    }
    for (const o of origins) {
      const redundant = [...origins].some((w) => w !== o && (reach.get(w) ?? EMPTY).has(o));
      if (!redundant) edges.push({ from: o, to: OUTPUT_ID });
    }
    roots.push({ kind: "output", id: OUTPUT_ID, value: final.value, state: final.state });
  }

  return { roots, edges, warnings: [] };
}
