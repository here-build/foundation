/**
 * Stage 1 of the region-model: a control operator gets a REAL boundary (entrance +
 * exit producers) derived from the existing forest + statechart — no interpreter
 * change. Asserted against the gepa-shaped trace (loop ⊃ map ⊃ react-infer, plus a
 * reflect-infer): the `map` region's EXIT is the react infer inside it, and its
 * ENTRANCE is the reflect infer feeding the next iteration's reacts (the loop-back).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { regionBoundaries } from "../region-boundaries.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "../trace.js";

const LOOP_PROGRAM = `
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         (s/object (s/field/string "verdict"))
         (string-append "react/" tagline "/" persona-id))))
(define (next-tagline current reactions)
  (:next (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|"
                                                      (:verdict (car reactions)))))
                (s/object (s/field/string "next"))
                (string-append "reflect/" current)))))
(define (loop tagline iter max-iter)
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list "p1" "p2"))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 2)
`;
const loopStub = async (spec: ModelSpec) => {
  const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
  const user = msgs.find((m) => m.role === "user")?.content ?? "";
  if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
  const current = user.split("|")[1] ?? "";
  return { value: { next: current === "t0" ? "t1" : "t2" } };
};

async function traceOf(program: string, complete: (spec: ModelSpec) => Promise<{ value: unknown }>): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete })));
  const trace = new EvalTrace();
  await project.run(program, { trace });
  return trace;
}

describe("regionBoundaries", () => {
  it("gives a control region real entrance + exit boundaries", async () => {
    const regions = regionBoundaries(await traceOf(LOOP_PROGRAM, loopStub));

    // The map is a first-class region with a boundary — not transparent.
    const map = regions.find((r) => r.label === "map");
    expect(map).toBeDefined();

    // EXIT = the infer inside the map (react), which feeds the outer reflect.
    expect(map!.exit.some((p) => p.startsWith("infer/chat@"))).toBe(true);
    // ENTRANCE = the loop-back producer (reflect) feeding the next iteration's
    // reacts — an infer OUTSIDE the map.
    expect(map!.entrance.some((p) => p.startsWith("infer/chat@"))).toBe(true);
    // The boundary is real dataflow, not a self-loop: in ≠ out.
    expect(map!.entrance).not.toEqual(map!.exit);

    // The map nests inside the loop body → more than one region.
    expect(regions.length).toBeGreaterThan(1);
  });
});
