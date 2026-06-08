/**
 * Per-form evaluation trace.
 *
 * Implements arrival-scheme's `EvalTap` and builds an observable
 * `Map<ASTNode, NodeRecord>` keyed by Pair identity (the same Pair object
 * the parser produced). For each parsed Pair the evaluator visits, the
 * trace stores:
 *
 *   - `bindings` — monotonic set of every Invocation that has entered
 *     this node (resolved invocations are NOT removed; the UI distinguishes
 *     live vs. completed by Invocation.state)
 *   - `entered`  — lifetime enter count
 *   - `exited`   — lifetime exit count
 *
 * Each Invocation captures the dynamic call stack via `parent`, so any
 * still-running invocation can be walked back to the program-root form.
 *
 * Atoms, bare symbols, quoted data, and macro-expansion-constructed
 * Pairs (those without `__location__`) are not tracked — the evaluator's
 * tap-firing rules already filter them.
 */
import { AValue, EMPTY_PROVENANCE, type EvalTap, type Pair, type SchemeSymbol } from "@here.build/arrival-scheme";
import { action, observable } from "mobx";
import invariant from "tiny-invariant";

// ── De-MobXed hot machinery ──────────────────────────────────────────────────
// `Invocation` and `NodeRecord` used to be `makeAutoObservable`. On a deep TCO
// loop the trace mints one Invocation per recursion step — tens of thousands —
// and a per-object MobX administration (`values_` / the admin symbol) is ~10× the
// memory of a plain field bag. A 46k-invocation run retained ~186MB of pure admin
// + O(n²) provenance Sets, GC-thrashing the tab into the "pause won't land, no JS
// on the stack" freeze. Nothing observes these fields reactively: the chart reads
// a PLAIN snapshot (`snapshotTrace`) and live-fill is driven solely by the
// `#entries` observable box (TraceGraph's `reaction(() => trace.entries)`), which
// `snapshotTrace` runs OUTSIDE of. So the OBJECTS are now plain. The ONE remaining
// observable is the `#entries` box — its `.set` IS an observed write, so it must
// stay inside an `action` (strict mode's `enforceActions: "observed"` throws
// otherwise: "changing (observed) observable values without using an action"). So
// `enter` keeps its `action` wrapper; the other tap mutators touch only plain
// fields and stay bare.

export type InvocationState = "running" | "resolved" | "rejected";

/**
 * A field-point's origin: which producer point it projects from, and the field
 * key plucked. The `origin` may itself be a field-point id (nested `(:a (:b x))`)
 * — resolve transitively to the real producer point; the pin is the key closest
 * to that real point (the producer's actual output field). See
 * `EvalTrace.fieldPointMeta`.
 */
export interface FieldPointMeta {
  origin: number;
  key: string;
}

/** If a form is a keyword-accessor application `(:field x)`, the bare field name
 *  (`"verdict"`), else null. The head is the keyword SchemeSymbol whose
 *  `__name__` is `":verdict"`; a head of exactly `":"` (no field) is not one. */
function accessorField(node: Pair): string | null {
  const head = (node as { car: unknown }).car;
  if (head === null || typeof head !== "object" || !("__name__" in head)) return null;
  const name = (head as { __name__: unknown }).__name__;
  return typeof name === "string" && name.length > 1 && name.startsWith(":") ? name.slice(1) : null;
}

/**
 * Provenance computation per `docs/spec/arrival-chain.md` §5.
 *
 * Provenance-marked invocations emit `{ self.id }`. Otherwise the rule
 * counts DISTINCT non-empty provenance sets (by reference) across
 * children — zero → empty; one → forward that same set (preserves
 * identity, useful for set comparisons); many → union.
 *
 * Set identity is reference-equal, so `(+ x x)` where both args resolve
 * via the same defining invocation's symbol-resolution naturally
 * contribute one set (forwarded reference), not two.
 *
 * Control-flow restriction (if/cond/when/unless/case → predicate +
 * chosen-arm result) is enforced by the rosetta wrappers for those
 * forms — not here. This function applies the general rule.
 */
function computeProvenance(inv: Invocation, trace: EvalTrace): ReadonlySet<number> {
  if (inv.isProvenancePoint) return trace.markAuthoritativeProvenance(new Set<number>([inv.id]));

  const field = accessorField(inv.node);

  // Forward an already-truncated lineage across a FORWARDING boundary — a
  // function-call return, a `let`, a tail-recursive pass-through, a control-flow
  // arm that the evaluator left untouched (empty predicate). When the produced
  // value's provenance is AUTHORITATIVE (minted by a point or a `(:field …)`
  // projection, see `markAuthoritativeProvenance`) it is the COMPLETE lineage;
  // re-unioning the frame's other resolutions here is precisely the
  // depth-accumulation that flattened a navigable O(1)-per-hop link chain into an
  // O(history) set (the 2026-06-08 heap dump). Field accessors are EXCLUDED so
  // they reach the refine branch below and mint their own link; genuine combiners
  // (string-append, an `if` with a provenance-bearing predicate — whose merged set
  // the evaluator produced via `withProvenance`, never marked authoritative) are
  // not authoritative and fall through to the normal union.
  if (field === null && inv.value instanceof AValue && trace.isAuthoritativeProvenance(inv.value.provenance)) {
    return inv.value.provenance;
  }

  const distinct = new Set<ReadonlySet<number>>();
  // Pair-children — sub-expressions evaluated within this invocation.
  // Each child's `provenance` was computed by its own exit-tap and
  // stamped onto its `value` (see `exit` below), so the field is the
  // authoritative carrier.
  for (const child of inv.children) {
    if (child.provenance.size > 0) distinct.add(child.provenance);
  }
  // Symbol resolutions — bare references to values produced by other
  // tracked invocations. Per spec §5.2: provenance flows through env
  // bindings via the resolved value's origin.
  if (inv.symbolContributions) {
    for (const s of inv.symbolContributions) {
      if (s.size > 0) distinct.add(s);
    }
  }
  if (distinct.size === 0) return EMPTY_PROVENANCE;

  // Field-qualified projection (§5.3 sibling): a keyword-accessor `(:verdict x)`
  // crosses the structured-output membrane — it doesn't merely forward the
  // producer's provenance, it REFINES each upstream point P into a field-point
  // (P, "verdict"). The field-point is a plain synthetic id (minted lazily,
  // singleton per (origin, field) via the trace registry), so it rides through
  // `string-append`/binding as an ordinary `Set<number>` member and survives
  // absorb. The statechart resolves it back to (producer cell, pin) for the
  // per-property flow wire / go-to-source edge. Element-only provenance from
  // `car`/`cdr` (§5.3) already attributes to the right fan-out producer, so a
  // chained `(:verdict (car reactions))` qualifies react[0]'s point specifically.
  if (field !== null) {
    const refined = new Set<number>();
    for (const s of distinct) for (const p of s) refined.add(trace.fieldPoint(p, field));
    return trace.markAuthoritativeProvenance(refined);
  }

  if (distinct.size === 1) return distinct.values().next().value!;
  const merged = new Set<number>();
  for (const s of distinct) for (const x of s) merged.add(x);
  return merged;
}

export class Invocation {
  readonly id: number;
  readonly node: Pair;
  readonly parent: Invocation | null;
  /**
   * Child invocations spawned within this one's evaluation. Populated as
   * each child's `enter` fires. Lets the exit-tap compute provenance in
   * O(children) without scanning the full records map.
   */
  readonly children: Invocation[] = [];
  state: InvocationState = "running";
  value: unknown = undefined;
  error: unknown = undefined;
  /**
   * Dataflow provenance: the set of provenance-point invocation ids whose
   * outputs flowed into this call's inputs. Computed on exit per the
   * algebra in `docs/spec/arrival-chain.md` §5:
   *
   *   - Provenance-flagged rosetta call → { self.id }
   *   - Else: union of child invocations' provenance sets, deduped by
   *     reference (so `(+ x x)` where `x` resolves to one invocation
   *     contributes one membership, not two)
   *   - Control-flow forms (if/cond/…) restrict to chosen-arm result
   */
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE;
  /**
   * Set true when the rosetta wrapper (or an ad-hoc sandbox override) marks
   * this invocation as a provenance point. Read by exit-tap.
   */
  isProvenancePoint = false;
  /**
   * Trace-side metadata bound to this node via a rosetta's
   * `resultWithProvenance(value, meta)` — e.g. a `.prompt` node's `{ kind, path,
   * model, inputs }`, which the render reads to draw the node's card. Never
   * crosses back into scheme, never synced; `undefined` for almost every node.
   */
  metadata: unknown = undefined;
  /**
   * For an `(infer …)` invocation: whether it bound to an already-resolved task
   * (a cache HIT — `true`, blue/saved) vs triggered a fresh call (`false`,
   * green/spent). `undefined` for non-infer invocations. Set once at bind time
   * via `EvalTrace.markInferCached`; drives the per-node cached/fresh bar.
   */
  cached: boolean | undefined = undefined;
  /**
   * True when this Pair was evaluated in tail position (R7RS §3.5) — set from
   * the evaluator's own tail flag at enter (NOT inferred from trace shape). A
   * call in tail position is a tail call. Loop detection (in `traceToForest` and
   * `traceToRegions`) is STRUCTURAL — `hasSelfAncestor`, which covers tail- and
   * stack-recursion alike — so nothing reads this yet; it's the ground truth kept
   * for when we want to LABEL proper-TCO vs stack-growing recursion.
   */
  tailPosition = false;
  /**
   * Provenance contributions from symbol resolutions during this invocation's
   * evaluation. Populated by `onSymbolResolved`: when a bare symbol (`x`)
   * resolves to an AValue with non-empty provenance, that set is added here.
   * Read by `computeProvenance` at exit alongside `inv.children`'s provenances.
   *
   * Lazily allocated — most invocations don't reference any bare symbols
   * that came from provenance-tracked producers.
   */
  symbolContributions: Set<ReadonlySet<number>> | null = null;

  constructor(id: number, node: Pair, parent: Invocation | null) {
    this.id = id;
    this.node = node;
    this.parent = parent;
    if (parent) parent.children.push(this);
    // Plain object — see the de-MobXed-hot-machinery note at the top of the file.
  }

  /**
   * Flip {@link isProvenancePoint} as a MobX action (`makeAutoObservable` wraps
   * prototype methods as actions). The arrival-scheme rosetta wrapper is MobX-free
   * and duck-types this object as `{ id, isProvenancePoint? }`; it calls this
   * method to mark a `provenance: true` rosetta's invocation rather than writing
   * the observable directly — a raw write trips MobX strict-mode, which the studio
   * enables (node tests don't, which is why this only surfaced in-app).
   */
  markProvenancePoint(): void {
    this.isProvenancePoint = true;
  }

  /**
   * Bind {@link metadata} as a MobX action (same strict-mode reason as
   * {@link markProvenancePoint} — the studio enables strict-mode). Called by the
   * arrival-scheme rosetta wrapper when a fn returns `resultWithProvenance`.
   */
  setMetadata(meta: unknown): void {
    this.metadata = meta;
  }

  /** Walk the dynamic call chain back to the program-root invocation. */
  ancestors(): Invocation[] {
    const out: Invocation[] = [];
    let cur: Invocation | null = this;
    while (cur) {
      out.push(cur);
      cur = cur.parent;
      invariant(cur !== this, "ancestors should not walk off the root");
    }
    return out;
  }
}

export class NodeRecord {
  readonly bindings = new Set<Invocation>();
  entered = 0;
  exited = 0;
  // Plain object — see the de-MobXed-hot-machinery note at the top of the file.
}

export class EvalTrace implements EvalTap {
  readonly records = new Map<Pair, NodeRecord>();
  /**
   * Task-creating invocations indexed by the task they produced. Stamped at
   * upsertTask time by rosettas that have access to currentInvocation. Lets
   * the monitor walk from a live pipe back to its AST provenance.
   *
   * One task can have MANY invocations when the same prompt fires from
   * different iterations of a HOF — the content-addressed task cache merges
   * them, but each iteration's invocation has a distinct path. We keep the
   * full list so lineage queries can surface every site that hit the task.
   * The first invocation in the list is preserved as the "canonical" one
   * returned by `invocationFor`.
   */
  readonly invocationByTask = new Map<object, Invocation[]>();
  /**
   * Per-invocation symbol-resolution log. Populated by the evaluator each
   * time a SchemeSymbol is looked up while a Pair invocation is current.
   * Keyed by Invocation; value maps symbol name → resolved value.
   *
   * Symbol eval doesn't go through enter/exit (no Pair), so this is the
   * only mechanism a tracer has to recover the runtime value of e.g. a
   * lambda-parameter reference like `name` in `(string-append "hi " name)`.
   */
  readonly symbolValues = new WeakMap<Invocation, Map<string, unknown>>();
  #nextId = 0;

  /**
   * Monotonic enter-count — a CHEAP structural signal for renderers. Every
   * `enter` ticks it (including loop re-entry of an already-seen Pair, which
   * `records.size` does NOT reflect), so an observer can subscribe to JUST this
   * number to know "the trace grew" without reading every invocation's fields.
   * The blueprint uses it to throttle the O(points²) region rebuild to once per
   * animation frame instead of once per streamed value — the difference between a
   * frozen tab and a responsive one on a long run.
   */
  readonly #entries = observable.box(0);
  get entries(): number {
    return this.#entries.get();
  }

  /**
   * Field-point registry: synthetic provenance-point id → its origin + plucked
   * field. A field-point is minted by `computeProvenance` when a keyword
   * accessor `(:field x)` projects across the structured-output membrane (§5.3
   * sibling). It is a first-class member of `provenance: Set<number>` — so it
   * flows through `string-append`/binding/absorb like any point — but it is NOT
   * an invocation, so the statechart resolves it back through here to the real
   * producer cell + pin. `origin` may itself be a field-point id (nested
   * `(:a (:b x))`); resolve transitively, the pin being the key closest to the
   * real producer point (its actual output field). See `FieldPointMeta`.
   */
  readonly fieldPointMeta = new Map<number, FieldPointMeta>();
  /** (origin,key) → field-point id, so the same pluck mints a stable singleton
   *  id across every fire (matching how Pair-identity collapses invocations). */
  readonly #fieldPointIds = new Map<string, number>();

  /** Mint (or reuse) the synthetic field-point id for plucking `key` off a value
   *  whose provenance carries `origin`. Lazy + singleton per (origin, key).
   *
   *  ABSORPTION: if `origin` is ITSELF a field-point, return it unchanged rather
   *  than minting `fieldPoint(fieldPoint(P,…), key)`. A re-projection
   *  (`(:a (:b x))`) is a deeper pluck within the SAME producer pin; `resolvePoint`
   *  already keeps the INNER key as the producer port and walks the chain to the
   *  base point, so the outer mint is observably a no-op. Minting it anyway is the
   *  one non-idempotent op in the provenance semiring — and under loop
   *  accumulation it compounds to the O(n²) field-point blow-up that froze the
   *  chart (80k field-points from ~1.8k invocations). Absorbing it caps the
   *  registry at base-points × keys and restores the semiring's free loop bound.
   *  See docs/working-proposals/trace-provenance-idempotence-fix-2026-06-04.md. */
  fieldPoint(origin: number, key: string): number {
    if (this.fieldPointMeta.has(origin)) return origin;
    const memo = `${origin}:${key}`;
    const existing = this.#fieldPointIds.get(memo);
    if (existing !== undefined) return existing;
    const id = this.#nextId++;
    this.#fieldPointIds.set(memo, id);
    this.fieldPointMeta.set(id, { origin, key });
    return id;
  }

  /**
   * The provenance sets that are AUTHORITATIVE — minted by a provenance point
   * (`{self.id}`) or a `(:field …)` projection (`{field-point ids}`). An
   * authoritative set is the COMPLETE lineage of the value it stamps: upstream is
   * reached by FOLLOWING the link (the point / field-point resolves back to its
   * producer), never by carrying the transitive closure. `computeProvenance`
   * forwards an authoritative set across a forwarding boundary (function-call
   * return, `let`, tail-recursive pass-through) instead of re-unioning it with the
   * frame's other resolutions — that re-union is the depth-accumulation that turned
   * a navigable O(1)-per-hop chain into an O(history) flat set (the 2026-06-08
   * 1.3 GB heap dump: a loop's tagline carried every prior round's points instead of
   * one link back). Keyed by Set IDENTITY (WeakSet) so it rides the reference that
   * `withProvenance` / the size-1 forward share, and is GC'd with it.
   */
  readonly #authoritativeProvenance = new WeakSet<ReadonlySet<number>>();

  /** Tag a freshly-minted provenance set as authoritative (point / field-projection),
   *  returning it so call sites read `return trace.markAuthoritative(set)`. */
  markAuthoritativeProvenance<T extends ReadonlySet<number>>(set: T): T {
    if (set.size > 0) this.#authoritativeProvenance.add(set);
    return set;
  }

  /** Whether `set` is an authoritative (point / field-projection) lineage — see
   *  {@link markAuthoritativeProvenance}. */
  isAuthoritativeProvenance(set: ReadonlySet<number>): boolean {
    return this.#authoritativeProvenance.has(set);
  }

  /** Associate a task with an invocation that created it. Idempotent —
   *  re-binding the same invocation does not duplicate. Multiple distinct
   *  invocations for the same task accumulate. */
  bindTask(task: object, invocation: Invocation): void {
    let list = this.invocationByTask.get(task);
    if (!list) {
      list = [];
      this.invocationByTask.set(task, list);
    }
    if (!list.includes(invocation)) list.push(invocation);
  }

  /** Record whether an infer invocation was served from cache (hit) or fired a
   *  fresh call. Set at bind time, before the await — `cached` never changes
   *  after. Drives the per-node cached/fresh (blue/green) bar. */
  markInferCached = (invocation: Invocation, cached: boolean): void => {
    invocation.cached = cached;
  };

  /** First (canonical) invocation that produced the task; undefined if unbound. */
  invocationFor(task: object): Invocation | undefined {
    return this.invocationByTask.get(task)?.[0];
  }

  /** Every invocation that produced this task — one per site/iteration. */
  invocationsFor(task: object): readonly Invocation[] {
    return this.invocationByTask.get(task) ?? [];
  }

  /** Look up a symbol's resolved value inside the given invocation's scope. */
  symbolValueIn(inv: Invocation, name: string): unknown {
    return this.symbolValues.get(inv)?.get(name);
  }

  // `enter` mutates plain fields (records Map + Invocation fields) AND bumps the
  // `#entries` observable box — the lone reactive signal renderers subscribe to.
  // Because that box write is an observed-observable mutation, `enter` MUST be an
  // `action` (strict mode rejects a bare observed write). `exit`/`markProvenancePoint`
  // touch only plain fields, so they stay bare.

  enter = action((node: Pair, parent: unknown, tailPosition?: boolean): Invocation => {
    const inv = new Invocation(this.#nextId++, node, parent as Invocation | null);
    if (tailPosition) inv.tailPosition = true;
    let rec = this.records.get(node);
    if (!rec) {
      rec = new NodeRecord();
      this.records.set(node, rec);
    }
    rec.bindings.add(inv);
    rec.entered += 1;
    this.#entries.set(this.#entries.get() + 1);
    return inv;
  });

  exit = (
    invocation: unknown,
    result: { value: unknown } | { error: unknown },
  ): { value: unknown } | { error: unknown } | void => {
    const inv = invocation as Invocation;
    if (!("value" in result)) {
      inv.state = "rejected";
      inv.error = result.error;
      inv.provenance = computeProvenance(inv, this);
      this.#pruneChildProvenance(inv);
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return;
    }

    inv.state = "resolved";
    inv.value = result.value;
    inv.provenance = computeProvenance(inv, this);
    this.#pruneChildProvenance(inv);

    // Stamp the computed provenance back onto the value itself, so it rides
    // through env bindings and emerges intact at the next symbol resolution.
    // Pre-AValue this needed a sidecar WeakMap keyed by the result object —
    // which snapped at primitives (strings/numbers/booleans can't key a
    // WeakMap) and lost provenance whenever an (infer …) chain produced a
    // bare scalar. Now every scheme runtime value extends AValue and carries
    // its own provenance field, so the same machinery works uniformly.
    //
    // The substitution-return is load-bearing: `withProvenance` clones the
    // AValue (provenance is part of identity, not mutable in place), so the
    // freshly-stamped clone lives only here. Without returning it, the
    // evaluator would continue with the ORIGINAL un-stamped value and bind
    // THAT to whatever `define`/`let`/arg slot this invocation feeds.
    // See arrival-scheme `Call.onResolve` for the trampoline-side contract.
    if (inv.provenance.size > 0 && inv.value instanceof AValue) {
      inv.value = inv.value.withProvenance(inv.provenance);
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return { value: inv.value };
    }

    const rec = this.records.get(inv.node);
    if (rec) rec.exited += 1;
  };

  /**
   * Free a child's provenance Set the moment its parent has folded it in.
   *
   * Provenance flows exactly ONE level at exit: `computeProvenance(parent)` unions
   * its direct children's sets (plus symbol contributions). The value-carried copy
   * (`withProvenance` on the AValue) handles the symbol-resolution path independently,
   * so once the parent's set is computed, an intermediate child's own Set is never
   * read again — by anyone. Without this, every Invocation on a 46k-deep TCO loop
   * retains an O(depth) provenance Set forever (`NodeRecord.bindings → Invocation.provenance`),
   * the O(n²) blowup that GC-froze the tab.
   *
   * The keep-condition mirrors `snapshotTrace`'s materialization predicate EXACTLY
   * (`inv.parent?.isProvenancePoint || isRoot || isPoint`): a provenance point's own
   * set is `{self.id}` (tiny, and read as a point), and a point's direct children are
   * what the snapshot reads. Everything else is never-read scaffolding — safe to drop.
   */
  #pruneChildProvenance(inv: Invocation): void {
    // A point's children ARE snapshot-materialized (parent.isProvenancePoint) — keep them.
    if (inv.isProvenancePoint) return;
    for (const child of inv.children) {
      // A point's own set is {self} (tiny + read as a point); never prune it.
      if (child.isProvenancePoint) continue;
      if (child.provenance.size > 0) child.provenance = EMPTY_PROVENANCE;
    }
  }

  /**
   * Flag an invocation as a provenance point. Called by rosetta wrappers
   * declared with `provenance: true`, and by sandbox overrides
   * ("make this AST node a provenance point").
   *
   * Setting this before `exit` fires causes the exit-tap to emit
   * `{ self.id }` instead of the union-of-children rule.
   */
  markProvenancePoint = (invocation: Invocation): void => {
    invocation.isProvenancePoint = true;
  };

  /**
   * Set true after the first time onSymbolResolved throws and we suppress
   * it (the arrival-scheme evaluator swallows tap exceptions so user code
   * doesn't see them; that silence makes tap bugs invisible). We warn once
   * per session to surface the failure without spamming the console.
   */
  #symbolTapWarned = false;

  onSymbolResolved = (invocation: Invocation | null, symbol: SchemeSymbol, value: unknown): void => {
    try {
      if (!invocation) return;
      let map = this.symbolValues.get(invocation);
      if (!map) {
        map = new Map<string, unknown>();
        this.symbolValues.set(invocation, map);
      }
      const name = (symbol as { __name__?: unknown }).__name__;
      if (typeof name === "string") map.set(name, value);

      // Provenance contribution: read it directly off the value. The producing
      // invocation's exit-tap stamped it via `withProvenance`, so every AValue
      // — primitive-shaped or not — carries its origin. Per spec §5.2: symbols
      // don't carry provenance themselves; the producing invocation's
      // provenance flows through them at resolve time.
      if (value instanceof AValue && value.provenance.size > 0) {
        if (!invocation.symbolContributions) invocation.symbolContributions = new Set();
        invocation.symbolContributions.add(value.provenance);
      }
    } catch (error) {
      if (!this.#symbolTapWarned) {
        this.#symbolTapWarned = true;

        console.warn("EvalTrace.onSymbolResolved threw; tap data may be incomplete:", error);
      }
    }
  };
}
