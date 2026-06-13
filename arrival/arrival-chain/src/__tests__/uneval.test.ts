import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";
import { buildUneval } from "@here.build/arrival-provenance";

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
    const { finished, env, result, userForms } = await project.runTraced(src, { trace });
    await finished;

    const container = buildUneval({ env, result: await result, trace, source: src, forms: userForms });

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

  // Swarm-2 #8: a program whose own output binding is named `result` must not collapse to a
  // degenerate `(define result result)` — the let-wrap binds locally and the slice re-runs.
  it("handles a program whose output is itself named `result`", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "evil.exe" })) })));
    const trace = new EvalTrace();
    const src = `
      (define result (string-append "X:" (car (infer "fast" "A"))))
      result
    `;
    const { finished, env, result, userForms } = await project.runTraced(src, { trace });
    await finished;
    const container = buildUneval({ env, result: await result, trace, source: src, forms: userForms });

    const picked = await container.uneval("(string-append result \"_SEL\")");
    expect(picked.value).toBe("X:evil.exe_SEL");
    expect(picked.program).not.toContain("(define result result)");

    // Re-run the emitted program in a fresh project — it must reproduce the picked value.
    const p2 = ArrivalChain.bootstrap(new Project()).root;
    p2.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "evil.exe" })) })));
    const rerun = await (await p2.runTraced(picked.program, { trace: new EvalTrace() })).finished;
    expect(rerun).toBe("X:evil.exe_SEL");
  });
});
