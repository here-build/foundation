import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { inferKey, seededCache } from "./_seeded-cache.js";

const echoStub = (delayMs = 0) =>
  vi.fn(async (s: ModelSpec) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { value: `echo(${s.model}):${s.prompt}` };
  });

describe("Project.run — the converge kernel", () => {
  it("converges a chain of dependent infers", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = echoStub();
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    const value = await project.run(`
      (define a (car (infer "m" "p1")))
      (car (infer "m" (string-append a "/p2")))
    `);

    expect(String(value)).toContain("echo(m):");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("replays from a pre-populated cache without touching the model", async () => {
    // Cache as continuation: seed the entities directly, no backend needed.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async () => {
            throw new Error("backend hit — expected a content-cache replay");
          },
        }),
        seededCache({ [inferKey("m", "seed")]: "X", [inferKey("m", "xX")]: "done" }),
      ),
    );

    const value = await project.run(`(car (infer "m" (string-append "x" (car (infer "m" "seed")))))`);

    expect(value).toBe("done");
  });

  it("auto-parallelizes (map infer …) — frontier resolves concurrently", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = echoStub(60);
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    const t0 = Date.now();
    await project.run(`
      (apply string-append
        (map (lambda (n) (car (infer "m" n)))
             (list "n0" "n1" "n2" "n3" "n4" "n5" "n6" "n7")))
    `);
    const elapsed = Date.now() - t0;

    expect(complete).toHaveBeenCalledTimes(8);
    expect(elapsed).toBeLessThan(300); // 8 × 60 = 480 sequential
  });

  it("dedups identical specs to a single backend call within a run", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = echoStub();
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (apply string-append
        (map (lambda (_) (car (infer "m" "same"))) (list 1 2 3 4 5)))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
