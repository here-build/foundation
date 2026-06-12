import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { EvalTrace } from "../trace.js";
import { buildUneval } from "../uneval.js";

describe("buildUneval — selector-eval + provenance extraction", () => {
  it("uneval('(car result)') picks the effective value and its provenance", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "evil.exe" }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));
    const trace = new EvalTrace();
    // `result` = a list whose head is an infer output (carries provenance), tail a bare literal.
    // `noise` is an unrelated define — the slice must PRUNE it.
    const src = `
      (define noise (infer "fast" "irrelevant noise"))
      (define verdict (infer "fast" "name the malware"))
      (list verdict "benign")
    `;
    const { finished, env, result } = await project.runTraced(src, { trace });
    await finished;

    const container = buildUneval({ env, result: await result, trace, source: src, forms: [] });

    // The head selector picks the infer output (a list) — provenance-bearing.
    const head = await container.uneval("(car result)");
    expect(head.value).toEqual(["evil.exe"]);
    expect(head.provenance.length).toBeGreaterThan(0);
    expect(head.program).toContain("(car result)");
    // The program is the SLICE: the verdict derivation, with the unrelated `noise` form pruned.
    expect(head.program).toContain("verdict");
    expect(head.program).not.toContain("noise");
    expect(head.points.length).toBeGreaterThan(0);

    // A different leaf of the same structure selects its own effective value.
    const tail = await container.uneval("(car (cdr result))");
    expect(tail.value).toBe("benign");
    expect(Array.isArray(tail.provenance)).toBe(true);
  });
});
