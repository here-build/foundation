import { createInferStore, type ModelSpec, singletonRouter } from "@here.build/arrival-inference";
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { runNamed } from "../run-isolated.js";

// Reference crashers for the run plane. Since runs are CAUSAL by default (no trace), the VALUE run is
// bounded only by the wall-clock budget + the recursion limit; the trace-entry cap applies to the
// LAZY teleological (provenance) re-run. The headline property: a run too big to TRACE still returns
// its value — only provenance degrades.

function projectWith(files: Record<string, string>) {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "" })) })));
  for (const [path, source] of Object.entries(files)) project.addFile(path, source);
  return project;
}

// A loop-until-dry whose generator always yields a brand-new item ⇒ `seen` grows unbounded (the shape
// of sift/closure.scm's bug). The CAUSAL run is bounded by the wall-clock budget → timeout marker.
const NEVER_CONVERGES = `
(define (member? x xs) (> (length (filter (lambda (y) (equal? y x)) xs)) 0))
(define (loop-until-dry gen patience)
  (let loop ((seen (list)) (dry 0))
    (if (>= dry patience) seen
        (let* ((fresh (filter (lambda (x) (not (member? x seen))) (gen seen)))
               (next  (append seen fresh)))
          (if (null? fresh) (loop seen (+ dry 1)) (loop next 0))))))
(loop-until-dry (lambda (seen) (list (length seen))) 2)
`;

// Each step doubles the list via native (append xs xs). clone's recursion stack-overflows (recoverable)
// before the heap OOMs ⇒ contained as a timeout marker, not a crash.
const EXPONENTIAL = `
(define (blow xs) (blow (append xs xs)))
(blow (list 1 2 3 4 5 6 7 8))
`;

// Completes (a tail loop) returning a real value — but is far too large to TRACE (50k reductions ≫
// a 5k trace cap). The tree-walking interpreter is ~100k reductions/s, so keep it modest.
const HUGE_BUT_FINISHES = `
(define (sum n acc) (if (= n 0) acc (sum (- n 1) (+ acc 1))))
(sum 50000 0)
`;

// A legitimately large but LINEAR pass: materialize a 50k list a couple of times. Cumulative cells
// charged ≈ 100k — comfortably under a 1M cap — so the heap budget must let it FINISH with its real
// value. This is the false-positive guard: the cap distinguishes O(K²) churn from honest linear work.
const LINEAR_OK = `
(define (range n) (let loop ((i n) (acc (list))) (if (= i 0) acc (loop (- i 1) (cons i acc)))))
(length (filter (lambda (x) (> x 49995)) (range 50000)))
`;

describe("run plane — containment + lazy-provenance property", () => {
  // The native-op runaway, contained by the HEAP budget (the gap the wall-clock budget can't close).
  // This loop grows `seen` by one per iteration; every iteration re-materializes it through a native
  // `filter`/`append` — ONE synchronous JS pass with no trampoline TICK, so the wall-clock deadline
  // (checked only at TICKs) can't preempt it: empirically it ran ~30–86s before the JS stack finally
  // overflowed. The heap budget charges every cell materialized through `to_array`, so the cumulative
  // O(K²) churn trips a SMALL cap fast — bounding allocation, not reductions, is what catches a runaway
  // trapped inside a single native op. Asserted to contain QUICKLY (≪ the old 86s), proving it's the
  // heap cap doing the work, not the eventual stack overflow.
  it("non-converging loop is contained by the heap budget (native-op O(K^2) churn)", async () => {
    const prevBudget = process.env.ARRIVAL_RUN_BUDGET_MS;
    const prevHeap = process.env.ARRIVAL_HEAP_MAX;
    process.env.ARRIVAL_RUN_BUDGET_MS = "15000"; // generous wall-clock — prove the HEAP cap fires first
    process.env.ARRIVAL_HEAP_MAX = "200000"; // 200k cells: O(K^2) churn trips this quickly + deterministically
    const t0 = performance.now();
    try {
      const h = await runNamed(projectWith({ "crasher.scm": NEVER_CONVERGES }), "crasher.scm");
      expect(h.value).toMatchObject({ __timeout__: true });
      // Completing at all (vs the test's 20s timeout) already rules out the old ~86s stack-overflow;
      // the bound stays loose because the materialization cost is sensitive to parallel test load.
      expect(performance.now() - t0).toBeLessThan(15000);
    } finally {
      if (prevBudget === undefined) delete process.env.ARRIVAL_RUN_BUDGET_MS;
      else process.env.ARRIVAL_RUN_BUDGET_MS = prevBudget;
      if (prevHeap === undefined) delete process.env.ARRIVAL_HEAP_MAX;
      else process.env.ARRIVAL_HEAP_MAX = prevHeap;
    }
  }, 20_000);

  it("exponential append-doubling is contained (stack overflow → timeout marker, not OOM)", async () => {
    const prev = process.env.ARRIVAL_RUN_BUDGET_MS;
    process.env.ARRIVAL_RUN_BUDGET_MS = "3000";
    try {
      const h = await runNamed(projectWith({ "crasher.scm": EXPONENTIAL }), "crasher.scm");
      expect(h.value).toMatchObject({ __timeout__: true });
    } finally {
      if (prev === undefined) delete process.env.ARRIVAL_RUN_BUDGET_MS;
      else process.env.ARRIVAL_RUN_BUDGET_MS = prev;
    }
  }, 20_000);

  it("a large LINEAR pass is NOT falsely contained by the heap budget", async () => {
    const prevHeap = process.env.ARRIVAL_HEAP_MAX;
    process.env.ARRIVAL_HEAP_MAX = "1000000"; // 1M cap; ~100k cumulative charge stays well under
    try {
      const h = await runNamed(projectWith({ "ok.scm": LINEAR_OK }), "ok.scm");
      expect(h.value).toBe(5); // 49996..50000 → the real value comes back, no false trip
    } finally {
      if (prevHeap === undefined) delete process.env.ARRIVAL_HEAP_MAX;
      else process.env.ARRIVAL_HEAP_MAX = prevHeap;
    }
  }, 20_000);

  // THE property: value-delivery and provenance are independent failure domains.
  it("a run too large to TRACE still returns its value; provenance degrades gracefully", async () => {
    const prev = process.env.ARRIVAL_TRACE_MAX;
    process.env.ARRIVAL_TRACE_MAX = "5000";
    try {
      const h = await runNamed(projectWith({ "sum.scm": HUGE_BUT_FINISHES }), "sum.scm");
      expect(h.value).toBe(50_000); // the causal value comes back fine
      await expect(h.teleological()).rejects.toThrow(/provenance unavailable/i); // only the trace is too big
    } finally {
      if (prev === undefined) delete process.env.ARRIVAL_TRACE_MAX;
      else process.env.ARRIVAL_TRACE_MAX = prev;
    }
  }, 20_000);
});
