import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { EvalTrace } from "../trace.js";
import { buildSlice } from "../slice.js";
import { AValue } from "@here.build/arrival-scheme";

/** Infer mock that echoes the prompt back (so each call's output is identifiable in the slice). */
const echoInfer = () => vi.fn(async (s: ModelSpec) => ({ value: `out:${s.prompt}` }));

describe("buildSlice — reverse-chain slice (naive baseline)", () => {
  it("prunes an unrelated form (dynamic cone) and pulls in a referenced literal (static closure)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: echoInfer() })));
    const trace = new EvalTrace();
    // form 0: unused infer — NOT depended on (must be PRUNED).
    // form 1: a pure-literal define `tag` — has no provenance point, referenced by form 2
    //         (must be KEPT via the static closure, else form 2 is unrunnable).
    // form 2: the value — references tag + a depended-on infer.
    // form 3: bare reference = the run output.
    const src = `
      (define unused (infer "fast" "irrelevant"))
      (define tag "malware")
      (define hit (list (car (infer "fast" "name")) tag))
      hit
    `;
    const { finished, result } = await project.runTraced(src, { trace });
    await finished;
    const value = await result;
    expect(value).toBeInstanceOf(AValue);

    const slice = buildSlice(trace, (value as AValue).provenance);

    // Dynamic cone PRUNES the unrelated form.
    expect(slice.program).not.toContain("unused");
    expect(slice.program).not.toContain("irrelevant");
    // The depended-on derivation is kept.
    expect(slice.program).toContain("name");
    expect(slice.program).toContain("(define hit");
    // Static closure pulls in the referenced literal define (runnability).
    expect(slice.program).toContain("(define tag");
    // The cone exposes the read ids (the attestation join key).
    expect(slice.points.length).toBeGreaterThan(0);
  });

  it("the sliced program re-runs to the same value", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: echoInfer() })));
    const trace = new EvalTrace();
    const src = `
      (define noise (infer "fast" "noise"))
      (define answer (car (infer "fast" "verdict")))
      answer
    `;
    const { finished, result } = await project.runTraced(src, { trace });
    const original = await finished;
    const value = await result;

    const slice = buildSlice(trace, (value as AValue).provenance);
    // Slice omits the noise form.
    expect(slice.program).not.toContain("noise");

    // Re-run the slice + the value-yielding reference: it reproduces the original output.
    const project2 = ArrivalChain.bootstrap(new Project()).root;
    project2.bindInfer(createInferStore(singletonRouter({ complete: echoInfer() })));
    const rerun = await project2.runTraced(`${slice.program}\nanswer`, { trace: new EvalTrace() });
    expect(await rerun.finished).toBe(original);
  });
});
