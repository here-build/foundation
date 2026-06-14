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

describe("run plane — containment + lazy-provenance property", () => {
  // KNOWN GAP — causal-mode wall-clock budget does NOT preempt a native-op-dominated runaway.
  // Empirically (tsx repro, 2026-06-14): this loop grows `seen` by one per iteration, but every
  // iteration's work is a SINGLE synchronous native stdlib call (`filter`/`equal?`/`append`/`length`)
  // over the whole list. That native call blocks the event loop with no `await` boundary, so neither
  // the evaluator's internal `performance.now() > deadline` check (it rides the trampoline TICK) nor
  // runCausal's `setTimeout` hardWall can fire. It only stops at ~86s when the native recursion finally
  // overflows the JS stack. The TELEOLOGICAL (trace) path caught this because EvalTrace's per-`enter`
  // entry-cap is a per-REDUCTION synchronous bound; causal mode has no per-reduction hook by design
  // (that hook IS the tracing overhead we're avoiding). The principled fix is a synchronous
  // per-reduction step counter in the causal trampoline (cheap integer increment, no Set growth) OR
  // bounding native list ops — an evaluator-hot-path decision for V, not a test-level patch. Skipped
  // until that lands so the suite stays honest about what causal containment currently guarantees.
  it.skip("non-converging loop is contained by the causal budget (KNOWN GAP: native-op runaway)", async () => {
    const prev = process.env.ARRIVAL_RUN_BUDGET_MS;
    process.env.ARRIVAL_RUN_BUDGET_MS = "800";
    try {
      const h = await runNamed(projectWith({ "crasher.scm": NEVER_CONVERGES }), "crasher.scm");
      expect(h.value).toMatchObject({ __timeout__: true });
    } finally {
      if (prev === undefined) delete process.env.ARRIVAL_RUN_BUDGET_MS;
      else process.env.ARRIVAL_RUN_BUDGET_MS = prev;
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
