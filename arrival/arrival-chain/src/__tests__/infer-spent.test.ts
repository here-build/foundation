/**
 * `(infer/spent)` end-to-end — the reflective budget namespace read from scheme.
 *
 * Verifies the fold is real on the canonical `Project.run` path: after an `(infer)`
 * settles, `(infer/spent)` returns the running reference cost of the run's own fresh
 * inferences. A read at a sequence point (after the call's value is consumed) is
 * order-correct; a cache hit adds nothing (free); with no accumulator the namespace
 * is inert (→ 0). These are the reserve-level guarantees — no runtime trap, the
 * value is just vended for the program's own ROI/TCO loop.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { Completion, ModelSpec } from "../model.js";
import { referenceCost } from "../pricing.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";

/** A backend that answers every call with a fixed value + usage, counting calls.
 *  Usage is reported so `(infer/spent)` has a non-zero cost to fold. */
const usageBackend = (usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }) => {
  let n = 0;
  return {
    calls: () => n,
    complete: async (_s: ModelSpec): Promise<Completion> => {
      n += 1;
      return { value: `draw-${n}`, usage };
    },
  };
};

const MODEL = "qwen3.5-9b"; // priced: 0.05/Mtok in, 0.10/Mtok out
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
const oneCall = referenceCost(MODEL, usage); // 0.15

describe("(infer/spent) — reflective budget read", () => {
  it("is zero before any inference fires", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter(usageBackend())));
    const spent = await project.run(`(infer/spent)`);
    expect(spent).toBe(0);
  });

  it("reflects one fresh inference's reference cost after it settles", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter(usageBackend())));
    // `begin` sequences: force the infer (consume its value), THEN read spent.
    const spent = await project.run(`
      (begin
        (car (infer "${MODEL}" "p1" #f #f))
        (infer/spent))
    `);
    expect(spent).toBeCloseTo(oneCall, 9);
  });

  it("accumulates across two distinct fresh inferences", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter(usageBackend())));
    const spent = await project.run(`
      (begin
        (car (infer "${MODEL}" "p1" #f #f))
        (car (infer "${MODEL}" "p2" #f #f))
        (infer/spent))
    `);
    expect(spent).toBeCloseTo(oneCall * 2, 9);
  });

  it("a within-run dedup (single-flight) is FREE — the second call adds nothing", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = usageBackend();
    project.bindInfer(createInferStore(singletonRouter(backend)));
    // identical content tuple twice: the 2nd rides the 1st cell (cache hit this run).
    const spent = await project.run(`
      (begin
        (car (infer "${MODEL}" "same" #f "k"))
        (car (infer "${MODEL}" "same" #f "k"))
        (infer/spent))
    `);
    expect(backend.calls()).toBe(1); // single-flight: one real call
    expect(spent).toBeCloseTo(oneCall, 9); // paid once, not twice
  });

  it("counts fresh calls via (infer/calls)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter(usageBackend())));
    const calls = await project.run(`
      (begin
        (car (infer "${MODEL}" "p1" #f #f))
        (car (infer "${MODEL}" "p2" #f #f))
        (infer/calls))
    `);
    expect(calls).toBe(2);
  });

  it("threads through a sequential ROI loop — spent grows turn over turn", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter(usageBackend())));
    // A named-let loop is the canonical sequence point: each turn fires one infer,
    // then reads spent. Collect the spent-after-each-turn as a list. Because the
    // loop data-depends on the prior turn, the reads are order-correct.
    const trail = await project.run(`
      (let loop ((i 0) (acc '()))
        (if (= i 3)
            (reverse acc)
            (begin
              (car (infer "${MODEL}" (string-append "turn-" (number->string i)) #f #f))
              (loop (+ i 1) (cons (infer/spent) acc)))))
    `);
    // three distinct prompts → three fresh calls → 0.15, 0.30, 0.45
    expect(trail).toHaveLength(3);
    const [a, b, c] = trail as number[];
    expect(a).toBeCloseTo(oneCall, 9);
    expect(b).toBeCloseTo(oneCall * 2, 9);
    expect(c).toBeCloseTo(oneCall * 3, 9);
  });
});
