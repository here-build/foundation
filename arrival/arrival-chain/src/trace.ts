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
import type { EvalTap, Pair, SchemeSymbol } from "@here.build/arrival-scheme";
import { action, makeAutoObservable, observable } from "mobx";

export type InvocationState = "running" | "resolved" | "rejected";

export class Invocation {
  readonly id: number;
  readonly node: Pair;
  readonly parent: Invocation | null;
  state: InvocationState = "running";
  value: unknown = undefined;
  error: unknown = undefined;

  constructor(id: number, node: Pair, parent: Invocation | null) {
    this.id = id;
    this.node = node;
    this.parent = parent;
    makeAutoObservable(this, { id: false, node: false, parent: false });
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

  enter = action((node: Pair, parent: unknown): Invocation => {
    const inv = new Invocation(this.#nextId++, node, parent as Invocation | null);
    let rec = this.records.get(node);
    if (!rec) {
      rec = new NodeRecord();
      this.records.set(node, rec);
    }
    rec.bindings.add(inv);
    rec.entered += 1;
    return inv;
  });

  exit = action((invocation: unknown, result: { value: unknown } | { error: unknown }): void => {
    const inv = invocation as Invocation;
    if ("value" in result) {
      inv.state = "resolved";
      inv.value = result.value;
    } else {
      inv.state = "rejected";
      inv.error = result.error;
    }
    const rec = this.records.get(inv.node);
    if (rec) rec.exited += 1;
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
    } catch (err) {
      if (!this.#symbolTapWarned) {
        this.#symbolTapWarned = true;
        // eslint-disable-next-line no-console
        console.warn("EvalTrace.onSymbolResolved threw; tap data may be incomplete:", err);
      }
    }
  };
}
