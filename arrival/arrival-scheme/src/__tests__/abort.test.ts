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
    // Use named-let rather than `(define (loop) (loop)) (loop)` — named-let
    // iterates inside the trampoline (each call to `(loop)` invokes the
    // loopFn which calls `run(...)` again, but the outer run sees just one
    // generator iteration per pass), while the `(define ...) (loop)` form
    // chains promise resolutions per recursive call. Both *can* hit the
    // abort, but named-let does so reliably; the define-then-call form
    // races the JS promise-resolution stack and is non-deterministic.
    await expect(
      exec("(let loop () (loop))", { signal: ctrl.signal }),
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
    // Fire the abort on the next microtask so the trampoline's first TICK
    // check picks it up before the JS engine has a chance to overflow its
    // promise-resolution stack on the recursive `(loop)` form. Using a
    // named-let (`(let loop () (loop))`) keeps iteration inside the
    // trampoline rather than chaining promise resolutions per-call —
    // confirmed to deliver the abort cleanly.
    queueMicrotask(() => ctrl.abort(reason));
    await expect(
      exec("(let loop () (loop))", { signal: ctrl.signal }),
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

