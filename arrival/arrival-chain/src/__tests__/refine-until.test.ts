/**
 * Convergence-loop demo: refine a question until a stub Mom Test
 * verdict reports `specific=true`. The stub returns failing verdicts
 * with progressively-improved fixes for the first two iterations, then
 * passes — proving the .scm loop terminates on the data-dependent
 * condition rather than at fixed depth.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";

const PROGRAM = `
(define MomTestSchema
  (s/object
    (s/field/boolean "leading")
    (s/field/boolean "hypothetical")
    (s/field/boolean "specific")
    (s/field/string  "fix")))

(define (critique-question q)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub-system")
               (infer/chat/user q))
         MomTestSchema
         q)))

(define (passes? v)
  (and (equal? (:specific v)     #t)
       (equal? (:leading v)      #f)
       (equal? (:hypothetical v) #f)))

(define (refine-until-passes q max-iter)
  (define (loop q i)
    (cond ((>= i max-iter) (list q "max-iter-reached"))
          (else
            (let ((v (critique-question q)))
              (if (passes? v)
                (list q (number->string i))
                (loop (:fix v) (+ i 1)))))))
  (loop q 0))

(refine-until-passes "would you use a tool like this?" 5)
`;

/** Stub: first two prompts fail with progressively-tighter fixes; third passes. */
const momTestStub = () => {
  const fixesByInput: Record<string, { leading: boolean; hypothetical: boolean; specific: boolean; fix: string }> = {
    "would you use a tool like this?": {
      leading: false, hypothetical: true, specific: false,
      fix: "have you ever tried a tool for this in the past?",
    },
    "have you ever tried a tool for this in the past?": {
      leading: false, hypothetical: false, specific: false,
      fix: "tell me about the last time you faced this problem at work",
    },
    "tell me about the last time you faced this problem at work": {
      leading: false, hypothetical: false, specific: true,
      fix: "",
    },
  };
  const complete = vi.fn(async (spec: ModelSpec) => {
    const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = parsed.find((m) => m.role === "user")?.content ?? "";
    const verdict = fixesByInput[user];
    if (!verdict) throw new Error(`stub: unexpected user prompt: ${user}`);
    return { value: verdict };
  });
  return { complete };
};

describe("refine-until — convergence loop", () => {
  it("loops until predicate passes; depth depends on the input", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = momTestStub();
    project.bindInfer(createInferStore(singletonRouter(backend)));

    const out = await project.run(PROGRAM);

    // Three iterations: initial fails, fix-1 fails, fix-2 passes.
    expect(backend.complete).toHaveBeenCalledTimes(3);
    // Last list element is the iteration count when it converged.
    expect(out).toEqual(["tell me about the last time you faced this problem at work", "2"]);
  });

  it("replays the whole convergence chain with zero backend calls", async () => {
    // The InferStore IS the session cache; bound once, a second run of the same
    // program replays from content cells without re-hitting the backend.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = momTestStub();
    project.bindInfer(createInferStore(singletonRouter(backend)));

    const first = await project.run(PROGRAM);
    const callsAfterFirst = backend.complete.mock.calls.length;
    expect(callsAfterFirst).toBe(3);

    const second = await project.run(PROGRAM);
    // No new backend calls on the replay run.
    expect(backend.complete.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });
});
