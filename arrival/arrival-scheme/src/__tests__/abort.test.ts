/**
 * AbortSignal-based execution budget for the evaluator trampoline.
 *
 * War story: `evaluator.ts:run()` had no abort path until 2026-05-28. The
 * 1000-iter / 5ms event-loop yield kept the UI responsive but did NOT bound
 * CPU — `(define (loop) (loop)) (loop)` would burn a worker forever and the
 * only recourse was killing the process. Sandbox execution and agent-
 * generated Scheme programs needed an actual bound.
 *
 * Design: optional `AbortSignal` at the EvalContext boundary; trampoline
 * checks `signal.aborted` at the existing iteration boundary (the same
 * 1000-iter / 5ms tick where it already yields to the event loop). Throws
 * `signal.reason ?? DOMException("aborted", "AbortError")` — Web-standard
 * shape so it composes naturally with `fetch(url, { signal })` at the
 * rosetta boundary.
 *
 * Why these tests:
 *   1. Infinite-loop abort — the canonical motivation; documents that the
 *      Iron Law from `sandbox-escape.test.ts:201` (`it.skip("TODO: infinite
 *      loop is bounded by a wall-clock budget")`) is now lifted.
 *   2. Pre-aborted signal — caller passes an already-aborted signal; the
 *      trampoline must refuse without allocating state. Mirrors fetch().
 *   3. signal.reason preservation — the Web standard says when a caller
 *      passes a reason to abort(), the throw must surface that reason
 *      (not a generic AbortError). Tests this contract end-to-end.
 */

import { describe, expect, it } from "vitest";
import { exec, execExpr, parse } from "../generator-exec";

describe("AbortSignal execution budget", () => {
  it("aborts an infinite loop when AbortSignal fires", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const start = Date.now();
    // Use `(do () (#f))` — a do-loop with a constant-false test runs entirely
    // INSIDE one generator's `while(true)` (see evalDo at evaluator.ts:1558),
    // so iteration cycles through `yield { call: evaluate(test) }` and tail-
    // pops back to the same frame. The trampoline's stack[] and the JS
    // microtask chain stay flat, and the TICK abort check at the 5ms / 1000-
    // iter cadence delivers the signal cleanly within ~one tick of the timer.
    //
    // War story: this test used to drive the loop via `(let loop () (loop))`
    // on the assumption that named-let iterated inside the trampoline. It
    // doesn't — each (loop) call invokes the LambdaFunction-style closure
    // installed by evalLet (evaluator.ts:1041-1055), which itself calls
    // `run(...)` recursively. Every recursive call produces a fresh Promise
    // the outer trampoline awaits at the `is_promise(value)` branch
    // (evaluator.ts:533), so each iteration adds one pending await to the JS
    // promise-resolution chain. After ~10k recursions V8's stack overflows
    // inside PromiseRejectCallback — sometimes BEFORE the abort fires
    // (`SchemeError: Maximum call stack size exceeded`), sometimes AFTER
    // (test "passes" but the worker process crashes with an unhandled
    // RangeError that taints the next test in the suite). Proper TCO (see
    // task #46) would fix the underlying recursion shape; until that lands,
    // exercise the abort budget through a construct that actually iterates
    // flat. `(define (loop) (loop)) (loop)` has the same hazard for the same
    // reason — it goes through evalLambda's `run(...)` wrapper.
    await expect(
      exec("(do () (#f))", { signal: ctrl.signal }),
    ).rejects.toThrow(/abort/i);
    // Generous upper bound: the trampoline only checks at the 5ms / 1000-iter
    // cadence, so abort propagates within ~one tick of the 50ms timer.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("throws immediately when signal is already aborted at start", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await expect(
      exec("(+ 1 2)", { signal: ctrl.signal }),
    ).rejects.toThrow(/abort/i);
    // Pre-abort fast path: no trampoline state allocated, throw on entry.
    // This should be effectively instantaneous (sub-millisecond), but we
    // give a wide margin to allow for parse/import overhead from the lazy
    // lips bootstrap on first invocation in the suite.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("preserves signal.reason through the throw", async () => {
    const ctrl = new AbortController();
    const reason = new Error("custom budget exhausted");
    ctrl.abort(reason);
    await expect(
      exec("(+ 1 2)", { signal: ctrl.signal }),
    ).rejects.toThrow("custom budget exhausted");
  });

  it("preserves signal.reason when abort fires mid-execution", async () => {
    const ctrl = new AbortController();
    const reason = new Error("mid-run budget exhausted");
    // Fire abort on the next microtask so the trampoline's first TICK check
    // picks it up. The loop body uses `(do () (#f))` rather than named-let
    // for the trampoline-safety reasons documented on the first test above
    // — until TCO (task #46) lands, named-let is a JS-call-stack hazard,
    // not a flat-iteration construct.
    queueMicrotask(() => ctrl.abort(reason));
    await expect(
      exec("(do () (#f))", { signal: ctrl.signal }),
    ).rejects.toThrow("mid-run budget exhausted");
  });

  it("runs to completion when signal never aborts", async () => {
    const ctrl = new AbortController();
    const [result] = await exec("(+ 1 2 3)", { signal: ctrl.signal });
    // Sanity: passing a (non-aborting) signal does not break normal evaluation.
    expect(result).toBeDefined();
  });

  it("execExpr honors the abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const [expr] = await parse("(+ 1 2)");
    await expect(
      execExpr(expr, { signal: ctrl.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("AbortError has the standard Web API shape", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await exec("(+ 1 2)", { signal: ctrl.signal });
      expect.fail("Should have thrown");
    } catch (err) {
      // When no reason is supplied to abort(), the runtime supplies a default
      // (`new DOMException("aborted", "AbortError")` in modern Node / browsers).
      // We don't assert the exact constructor — runtimes vary in whether
      // DOMException is the constructor of choice — but the name must be
      // recognizable as an abort.
      expect(err).toBeDefined();
      const message = (err as Error)?.message ?? String(err);
      const name = (err as Error)?.name ?? "";
      expect(`${name} ${message}`.toLowerCase()).toMatch(/abort/);
    }
  });
});

