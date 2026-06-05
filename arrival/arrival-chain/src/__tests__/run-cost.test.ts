import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { runCostSummary, summarizeCosts, type TaskCost } from "../run-cost.js";
import { EvalTrace } from "../trace.js";

// qwen3.5-9b prices a {1M in, 1M out} call at $0.05 + $0.10 = $0.15 (see pricing.test.ts).
const USAGE = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
const UNIT = 0.15;
const task = (over: Partial<TaskCost>): TaskCost => ({
  model: "qwen3.5-9b",
  usage: USAGE,
  freshThisRun: true,
  calls: 1,
  ...over,
});

describe("summarizeCosts — pure arithmetic", () => {
  it("a single fresh task is all spent, nothing saved", () => {
    const r = summarizeCosts([task({ freshThisRun: true })]);
    expect(r.spent).toBeCloseTo(UNIT, 9);
    expect(r.saved).toBeCloseTo(0, 9);
    expect(r.projected).toBeCloseTo(UNIT, 9);
  });

  it("a replayed task is nothing spent, all saved", () => {
    const r = summarizeCosts([task({ freshThisRun: false })]);
    expect(r.spent).toBeCloseTo(0, 9);
    expect(r.saved).toBeCloseTo(UNIT, 9);
    expect(r.projected).toBeCloseTo(UNIT, 9);
  });

  it("within-run dedup: one fresh task hit 3× is paid once; the 2 reuses are saved", () => {
    const r = summarizeCosts([task({ freshThisRun: true, calls: 3 })]);
    expect(r.spent).toBeCloseTo(UNIT, 9); // the cache fires ONE worker, paid once
    expect(r.saved).toBeCloseTo(2 * UNIT, 9); // 2 invocations reused the result
    expect(r.projected).toBeCloseTo(3 * UNIT, 9); // cold deploy would compute all 3
  });

  it("spent + saved === projected (the uncached-sum invariant)", () => {
    const r = summarizeCosts([
      task({ freshThisRun: true, calls: 2 }),
      task({ freshThisRun: false, calls: 1 }),
      task({ model: "gpt-4o-mini", freshThisRun: true, calls: 1 }),
    ]);
    expect(r.spent + r.saved).toBeCloseTo(r.projected, 9);
  });

  it("an empty run costs nothing", () => {
    expect(summarizeCosts([])).toEqual({ spent: 0, saved: 0, projected: 0 });
  });
});

describe("runCostSummary — fresh run pays, replay is saved (end-to-end)", () => {
  it("fresh → spent>0/saved=0; replay → spent=0/saved=what-the-fresh-run-paid", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "ok", usage: USAGE }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    const program = `(infer "fast" "hello")`;

    // Run 1: the task is minted fresh — one model call, fully spent.
    const t1 = new EvalTrace();
    await project.run(program, { trace: t1 });
    const c1 = runCostSummary(t1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(c1.spent).toBeGreaterThan(0);
    expect(c1.saved).toBeCloseTo(0, 9);
    expect(c1.spent + c1.saved).toBeCloseTo(c1.projected, 9);

    // Run 2: same tuple → content-addressed cache hit, no new model call. The
    // invocation binds to an already-resolved task → fully saved.
    const t2 = new EvalTrace();
    await project.run(program, { trace: t2 });
    const c2 = runCostSummary(t2);
    expect(complete).toHaveBeenCalledTimes(1); // NOT called again
    expect(c2.spent).toBeCloseTo(0, 9);
    expect(c2.saved).toBeGreaterThan(0);
    expect(c2.saved).toBeCloseTo(c1.spent, 9); // the replay saved exactly what run 1 paid
    expect(c2.spent + c2.saved).toBeCloseTo(c2.projected, 9);
  });
});
