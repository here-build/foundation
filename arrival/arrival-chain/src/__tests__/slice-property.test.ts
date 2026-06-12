import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { EvalTrace } from "../trace.js";
import { buildSlice, defineNameOf, writeForm, lastTopLevelForm } from "../slice.js";

// THE CORE GUARANTEE AS AN EXECUTABLE INVARIANT: for any program, slicing by its output and
// re-running the slice reproduces the value — AND the slice is a strict subset (it pruned the
// noise we injected). Enumerated combinatorially (no RNG — Math.random is unavailable here and
// reproducibility matters) over output shapes × intermediate-define patterns × data kinds.

const fresh = () => {
  const p = ArrivalChain.bootstrap(new Project()).root;
  p.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (s: ModelSpec) => ({ value: `out:${s.prompt}` })) })));
  return p;
};

// A "noise" define that must NEVER appear in a slice of something that doesn't reference it.
const NOISE = `(define noise_marker (string-append (car (infer "fast" "noise")) "_NZ"))`;

// Output expressions that bind/consume an upstream `ev`, across combinator shapes + data kinds.
const OUTPUTS = [
  `ev`,
  `(string-append "P:" ev)`,
  `(list ev "lit")`,
  `(if #t ev "none")`,
  `(car (list ev "x"))`,
  `(vector ev 2 3)`,
  `(list #\\a ev)`,
  `\`(tag ,ev)`,
];

// Intermediate define chains feeding `ev` (each ends binding `ev`).
const CHAINS = [
  `(define ev (car (infer "fast" "E")))`,
  `(define raw (car (infer "fast" "E")))\n(define ev (string-append raw "!"))`,
  `(define k "K")\n(define ev (string-append (car (infer "fast" "E")) k))`,
];

describe("buildSlice — property: slice re-runs to the value AND prunes noise", () => {
  for (const chain of CHAINS) {
    for (const out of OUTPUTS) {
      it(`out=${out} | chain=${chain.split("\n").length} forms`, async () => {
        const src = `${NOISE}\n${chain}\n${out}`;
        const trace = new EvalTrace();
        const original = await (await fresh().runTraced(src, { trace })).finished;

        const outForm = lastTopLevelForm(trace);
        const slice = buildSlice(trace, outForm);
        const terminal = defineNameOf(outForm) ?? writeForm(outForm);
        const program = `${slice.program}\n${terminal}`.trim();

        // Invariant 1: pruned the unreferenced noise define.
        expect(program).not.toContain("noise_marker");
        // Invariant 2: no corrupt render.
        expect(program).not.toContain("[object");
        // Invariant 3 (the core guarantee): re-runs to exactly the original value.
        const rerun = await (await fresh().runTraced(program, { trace: new EvalTrace() })).finished;
        expect(rerun).toEqual(original);
      });
    }
  }
});
