import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
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

// Intermediate define chains feeding `ev` (each ends binding `ev`). The last is TRANSITIVE
// (a → b → ev) so the closure fixpoint actually iterates more than one hop.
const CHAINS = [
  { src: `(define ev (car (infer "fast" "E")))`, defines: 1 },
  { src: `(define raw (car (infer "fast" "E")))\n(define ev (string-append raw "!"))`, defines: 2 },
  { src: `(define k "K")\n(define ev (string-append (car (infer "fast" "E")) k))`, defines: 2 },
  { src: `(define a (car (infer "fast" "E")))\n(define b (string-append a "-b"))\n(define ev (string-append b "-ev"))`, defines: 3 },
];

describe("buildSlice — property: slice re-runs to the value AND prunes noise", () => {
  for (const chain of CHAINS) {
    for (const out of OUTPUTS) {
      it(`out=${out} | chain=${chain.defines}-define`, async () => {
        const src = `${NOISE}\n${chain.src}\n${out}`;
        const trace = new EvalTrace();
        const original = await (await fresh().runTraced(src, { trace })).finished;

        const outForm = lastTopLevelForm(trace);
        const slice = buildSlice(trace, outForm);
        const terminal = defineNameOf(outForm) ?? writeForm(outForm);
        const program = `${slice.program}\n${terminal}`.trim();

        // Invariant 1: pruned the unreferenced noise define...
        expect(program).not.toContain("noise_marker");
        // ...and kept EXACTLY the chain's defines (strict, non-empty subset — not a degenerate
        // empty slice that would also satisfy "no noise"); the noise define (a +1) is excluded.
        expect(slice.formNodes).toHaveLength(chain.defines);
        // Invariant 2: no corrupt render.
        expect(program).not.toContain("[object");
        // Invariant 3 (the core guarantee): re-runs to exactly the original value.
        const rerun = await (await fresh().runTraced(program, { trace: new EvalTrace() })).finished;
        expect(rerun).toEqual(original);
      });
    }
  }
});
