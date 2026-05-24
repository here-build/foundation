/**
 * Convergence-loop demo: refine a question until a stub Mom Test
 * verdict reports `specific=true`. The stub returns failing verdicts
 * with progressively-improved fixes for the first two iterations, then
 * passes — proving the .scm loop terminates on the data-dependent
 * condition rather than at fixed depth.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRegistry } from "../registry.js";

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
  (and (equal? (field v "specific")     #t)
       (equal? (field v "leading")      #f)
       (equal? (field v "hypothetical") #f)))

(define (refine-until-passes q max-iter)
  (define (loop q i)
    (cond ((>= i max-iter) (list q "max-iter-reached"))
          (else
            (let ((v (critique-question q)))
              (if (passes? v)
                (list q (number->string i))
                (loop (field v "fix") (+ i 1)))))))
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
    return verdict;
  });
  return { complete };
};

describe("refine-until — convergence loop", () => {
  it("loops until predicate passes; depth depends on the input", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const backend = momTestStub();
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry(backend), signal: ac.signal }).done;

    const out = await project.run(PROGRAM);

    // Three iterations: initial fails, fix-1 fails, fix-2 passes.
    expect(backend.complete).toHaveBeenCalledTimes(3);
    // Last list element is the iteration count when it converged.
    expect(out).toEqual(["tell me about the last time you faced this problem at work", "2"]);

    ac.abort(); await draining;
  });

  it("replays the whole convergence chain with zero backend calls", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const b1 = momTestStub();
    const ac1 = new AbortController();
    const d1 = startOrchestrator({ project, cache, backends: singletonRegistry(b1), signal: ac1.signal }).done;
    const first = await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(3);
    ac1.abort(); await d1;

    const b2 = momTestStub();
    const ac2 = new AbortController();
    const d2 = startOrchestrator({ project, cache, backends: singletonRegistry(b2), signal: ac2.signal }).done;
    const second = await project.run(PROGRAM);
    expect(b2.complete).toHaveBeenCalledTimes(0);
    expect(second).toEqual(first);
    ac2.abort(); await d2;
  });
});
