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
import { action, makeAutoObservable, observable } from "mobx";

export type InvocationState = "running" | "resolved" | "rejected";

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
function computeProvenance(inv: Invocation): ReadonlySet<number> {
  if (inv.isProvenancePoint) return new Set<number>([inv.id]);
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
   * True when this Pair was evaluated in tail position (R7RS §3.5) — set from
   * the evaluator's own tail flag at enter (NOT inferred from trace shape). A
   * call in tail position is a tail call; `traceToForest` reads this to identify
   * tail-recursive loops (the clean ×K stack) vs. stack-growing recursion.
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
    makeAutoObservable(this, { id: false, node: false, parent: false, children: false });
  }

  /** Walk the dynamic call chain back to the program-root invocation. */
  ancestors(): Invocation[] {
    const out: Invocation[] = [];
    let cur: Invocation | null = this;
    while (cur) {
      out.push(cur);
      cur = cur.parent;
    }
    return out;
  }
}

export class NodeRecord {
  readonly bindings = new Set<Invocation>();
  entered = 0;
  exited = 0;

  constructor() {
    makeAutoObservable(this);
  }
}

export class EvalTrace implements EvalTap {
  readonly records = observable.map<Pair, NodeRecord>();
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

  // `enter`/`exit` mutate observable fields (records map + Invocation state),
  // and are fired from the evaluator (i.e. outside any user-facing action),
  // so they are themselves bound as MobX actions to satisfy strict mode.

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
    return inv;
  });

  exit = action(
    (
      invocation: unknown,
      result: { value: unknown } | { error: unknown },
    ): { value: unknown } | { error: unknown } | void => {
      const inv = invocation as Invocation;
      if (!("value" in result)) {
        inv.state = "rejected";
        inv.error = result.error;
        inv.provenance = computeProvenance(inv);
        const rec = this.records.get(inv.node);
        if (rec) rec.exited += 1;
        return;
      }

      inv.state = "resolved";
      inv.value = result.value;
      inv.provenance = computeProvenance(inv);

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
    },
  );

  /**
   * Flag an invocation as a provenance point. Called by rosetta wrappers
   * declared with `provenance: true`, and by sandbox overrides
   * ("make this AST node a provenance point").
   *
   * Setting this before `exit` fires causes the exit-tap to emit
   * `{ self.id }` instead of the union-of-children rule.
   */
  markProvenancePoint = action((invocation: Invocation): void => {
    invocation.isProvenancePoint = true;
  });

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
