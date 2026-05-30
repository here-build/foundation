import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";

const echoStub = (delayMs = 0) =>
  vi.fn(async (s: ModelSpec) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { value: `echo(${s.model}):${s.prompt}` };
  });

describe("Project.run — the converge kernel", () => {
  it("converges a chain of dependent infers", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = echoStub();
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter({ complete }), signal: ac.signal });

    const value = await project.run(`
      (define a (car (infer "m" "p1")))
      (car (infer "m" (string-append a "/p2")))
    `);

    expect(String(value)).toContain("echo(m):");
    expect(complete).toHaveBeenCalledTimes(2);
    ac.abort();
    await draining;
  });

  it("replays from a pre-populated cache without touching the model", async () => {
    // Cache as continuation: seed the entities directly, no worker needed.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("m", "seed", null).result = new InferenceResult({ valueJson: '"X"' });
    cache.upsertTask("m", "xX", null).result = new InferenceResult({ valueJson: '"done"' });

    const value = await project.run(`(car (infer "m" (string-append "x" (car (infer "m" "seed")))))`);

    expect(value).toBe("done");
  });

  it("auto-parallelizes (map infer …) — frontier resolves concurrently", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = echoStub(60);
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter({ complete }), signal: ac.signal });

    const t0 = Date.now();
    await project.run(`
      (apply string-append
        (map (lambda (n) (car (infer "m" n)))
             (list "n0" "n1" "n2" "n3" "n4" "n5" "n6" "n7")))
    `);
    const elapsed = Date.now() - t0;

    expect(complete).toHaveBeenCalledTimes(8);
    expect(elapsed).toBeLessThan(300); // 8 × 60 = 480 sequential
    ac.abort();
    await draining;
  });

  it("dedups identical specs to a single task within a run", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = echoStub();
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter({ complete }), signal: ac.signal });

    await project.run(`
      (apply string-append
        (map (lambda (_) (car (infer "m" "same"))) (list 1 2 3 4 5)))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(cache.tasks.size).toBe(1);
    ac.abort();
    await draining;
  });
});
