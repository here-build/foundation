/**
 * The execution circuit-breaker reaches the sandbox eval loop.
 *
 * arrival-scheme's trampoline checks `signal`/`budgetMs` at the TICK boundary
 * and exec/execExpr forward them — but project.run() never passed them through,
 * so a runaway program (infinite recursion, or an infinitely-expanding user
 * macro) could not be cut. This guards the wiring
 *   runner → entryFile.run → project.run → exec.
 *
 * The two breakers are NOT interchangeable — a subtlety worth stating so nobody
 * re-discovers it the hard way:
 *
 *   • budgetMs is a SYNCHRONOUS deadline (`performance.now() > deadline`) checked
 *     at the TICK boundary, so it cuts a pure-CPU runaway even when the event
 *     loop is starved. THIS is the breaker for runaway macro expansion / tight
 *     loops.
 *   • A live, timer-based `signal` (AbortSignal.timeout) does NOT preempt a
 *     pure-CPU spin: the trampoline yields only a microtask (evaluator.ts:833,
 *     `await Promise.resolve()`), which starves the macrotask timer queue, so the
 *     timer never fires and `signal.aborted` stays false. `signal` lands at
 *     IO/await boundaries (between infer calls) or as a pre-aborted fast-fail —
 *     which is what the second test asserts.
 *
 * Tail-recursive ⇒ TCO ⇒ a clean infinite loop that spins the trampoline rather
 * than overflowing the stack — so the only thing that ends it is the breaker.
 */
import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";

const router = () => singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "x" })) });
const SPIN = `(define (spin) (spin)) (spin)`;

describe("execution breaker reaches the eval loop", () => {
  it(
    "a wall-clock budget cuts a pure-CPU runaway",
    async () => {
      await expect(
        runPipeline({
          files: { "main.scm": SPIN },
          entry: "main.scm",
          router: router(),
          budgetMs: 50,
        }),
      ).rejects.toThrow(/budget/i);
    },
    5000,
  );

  it(
    "a pre-aborted signal fails fast (signal is threaded end-to-end)",
    async () => {
      await expect(
        runPipeline({
          files: { "main.scm": SPIN },
          entry: "main.scm",
          router: router(),
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow();
    },
    5000,
  );
});
