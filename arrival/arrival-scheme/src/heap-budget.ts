// heap-budget.ts — a per-run ALLOCATION bound, the memory analogue of the wall-clock `budgetMs`.
//
// WHY: the wall-clock budget is checked at trampoline TICKs (loop-step / tail-call boundaries). A
// native collection op — `filter`/`map`/`append`/`join` — materializes its whole list through
// `to_array` in ONE synchronous JS loop that emits no TICK, so a single reduction over a large list
// runs uninterruptibly (a `(filter pred huge-list)` can burn tens of seconds before the trampoline
// regains control to check the deadline). Counting REDUCTIONS can't see inside that loop; counting
// ALLOCATIONS can. The killer pattern is O(K²) churn — re-materializing a list that grows by one each
// iteration (`(append seen fresh)` in a loop) — and cumulative element-charge catches it fast while a
// legitimately large LINEAR pass (materialize a 1M list a handful of times) stays well under a
// generous cap. Monotonic, like the EvalTrace entry cap: we bound cumulative work, not live heap.
//
// The meter lives on the RUN's environment (installed by `exec`), found by walking the parent chain
// from the calling scope — so it is run-scoped and safe against async interleaving of concurrent runs
// (each run's builtins resolve their own env's meter), with no module-level ambient state.

import type { Environment } from "./Environment.js";

/** A run's cumulative allocation meter. `used` counts elements materialized through `to_array`; once
 *  it passes `max` the run is contained. */
export interface HeapMeter {
  used: number;
  max: number;
}

/** Walk the env parent chain for the nearest installed meter (nearest = this run's). O(depth), called
 *  once per `to_array` (not per element). Returns undefined when no budget was requested. */
export function findHeapMeter(env: Environment | null): HeapMeter | undefined {
  for (let e = env; e; e = e.__parent__) {
    if (e.__heapMeter__ !== undefined) return e.__heapMeter__;
  }
  return undefined;
}

/** The containment message. Carries "budget exceeded" so the same classifier that catches the
 *  wall-clock deadline (`/budget exceeded|abort|maximum call stack/i`) treats this as a contained
 *  outcome, not a genuine fault. Thrown as a `SchemeError` by the caller (which already imports it). */
export function heapBudgetMessage(max: number): string {
  return (
    `heap budget exceeded (${max} cells) — a run materialized more list cells than its allocation ` +
    `bound allows (likely an unbounded-growth loop, e.g. (append acc x) re-copying a growing list).`
  );
}
