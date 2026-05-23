import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { runWorker } from "../worker.js";

const counterStub = () => {
  let n = 0;
  const complete = vi.fn(async (_s: ModelSpec) => `draw-${n++}`);
  return { complete };
};

// (infer tier prompt schema cache-key)
//   schema    = #f for "no schema"
//   cache-key = #f for "no distinguisher"

describe("infer — cache-key for multi-replay sampling", () => {
  it("identical args + same cache-key collapses to a single task", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const backend = counterStub();
    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: backend, signal: ac.signal });

    await project.run(`
      (car (infer "m" "same" #f "k1"))
      (car (infer "m" "same" #f "k1"))
    `);

    expect(backend.complete).toHaveBeenCalledTimes(1);
    expect(cache.tasks.size).toBe(1);
    ac.abort();
    await draining;
  });

  it("identical args + DIFFERENT cache-key produces N distinct tasks", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const backend = counterStub();
    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: backend, signal: ac.signal });

    await project.run(`
      (map (lambda (i) (car (infer "m" "same" #f (number->string i))))
           (list 0 1 2))
    `);

    expect(backend.complete).toHaveBeenCalledTimes(3);
    expect(cache.tasks.size).toBe(3);
    ac.abort();
    await draining;
  });

  it('omitting cache-key is distinct from cache-key "0"', async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("m", "same", null, null).result = new InferenceResult({ valueJson: '"no-key"' });
    cache.upsertTask("m", "same", null, "0").result = new InferenceResult({ valueJson: '"key-zero"' });

    const a = await project.run(`(car (infer "m" "same"))`);
    const b = await project.run(`(car (infer "m" "same" #f "0"))`);

    expect(a).toBe("no-key");
    expect(b).toBe("key-zero");
  });

  it("schema and cache-key compose positionally", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("m", "p", "S", "k").result = new InferenceResult({ valueJson: '"hit"' });

    const value = await project.run(`(car (infer "m" "p" "S" "k"))`);
    expect(value).toBe("hit");
  });
});

describe("infer — always-list return shape", () => {
  it("wraps a scalar result in a single-element list", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("m", "p", null, null).result = new InferenceResult({ valueJson: '"hi"' });

    const value = await project.run(`(infer "m" "p")`);
    expect(value).toEqual(["hi"]);
  });

  it("passes a structured array through as-is", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("m", "p", null, null).result = new InferenceResult({ valueJson: '["a","b","c"]' });

    const value = await project.run(`(infer "m" "p")`);
    expect(value).toEqual(["a", "b", "c"]);
  });
});
