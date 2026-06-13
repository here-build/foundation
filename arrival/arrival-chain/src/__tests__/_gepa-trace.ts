/**
 * Shared gepa-trace harness — a real `EvalTrace` from running the canonical
 * gepa-until-plateau program through the single-flight `InferStore` with a stub
 * router.
 *
 * Extracted so new trace-consumer tests stop re-pasting it (it was duplicated
 * across trace-to-forest / statechart / trace-to-flow-graph). NOT a `.test.ts`
 * file, so vitest's test-include glob never runs it as a suite. The older copies
 * can migrate to this when next touched.
 */
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "../trace.js";

export const GEPA_PROGRAM = `
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

export async function gepaTrace(): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(
    createInferStore(
      singletonRouter({
        complete: async (spec: ModelSpec) => {
          const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
          const user = parsed.find((m) => m.role === "user")?.content ?? "";
          if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
          const [, current] = user.split("|");
          return { value: { next: current === "t0" ? "t1" : "t2" } };
        },
      }),
    ),
  );
  const trace = new EvalTrace();
  await project.run(GEPA_PROGRAM, { trace });
  return trace;
}
