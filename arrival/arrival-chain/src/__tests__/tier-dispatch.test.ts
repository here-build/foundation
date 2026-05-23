import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { runWorker } from "../worker.js";

const echoBackend = () => {
  const complete = vi.fn(async (s: ModelSpec) => `${s.model}::${s.prompt}`);
  return { complete };
};

describe("worker — multi-provider tier dispatch via project.models", () => {
  it("routes each tier to the configured provider with the concrete model name", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("fast", "openai", "gpt-4o-mini");
    project.setModel("high", "anthropic", "claude-sonnet-4-6");

    const openai = echoBackend();
    const anthropic = echoBackend();

    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: { openai, anthropic }, signal: ac.signal });

    await project.run(`
      (define a (car (infer "fast" "p1")))
      (car (infer "high" (string-append a "/p2")))
    `);

    // Each provider got exactly one call. The 'model' field carries
    // the concrete model name (not the tier).
    expect(openai.complete).toHaveBeenCalledTimes(1);
    expect(openai.complete.mock.calls[0][0]).toMatchObject({ model: "gpt-4o-mini", prompt: "p1" });

    expect(anthropic.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-4-6" });

    ac.abort();
    await draining;
  });

  it("cache key is the tier — swapping the concrete model preserves past results", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("fast", "openai", "gpt-4o-mini");

    const openai = echoBackend();
    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: { openai }, signal: ac.signal });

    const first = await project.run(`(car (infer "fast" "hello"))`);
    expect(openai.complete).toHaveBeenCalledTimes(1);
    ac.abort(); await draining;

    // Repoint "fast" to a different concrete model. The cache key
    // doesn't carry the concrete model, so re-running the same program
    // should hit the existing task, not produce a new one.
    project.setModel("fast", "openai", "gpt-5-future");

    const openai2 = echoBackend();
    const ac2 = new AbortController();
    const draining2 = runWorker({ project, cache, backends: { openai: openai2 }, signal: ac2.signal });

    const second = await project.run(`(car (infer "fast" "hello"))`);
    expect(openai2.complete).toHaveBeenCalledTimes(0); // cache hit
    expect(second).toBe(first);
    ac2.abort(); await draining2;
  });

  it("fails the task with InferenceError when the tier isn't configured", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // No setModel call.

    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: { openai: { complete: vi.fn() } }, signal: ac.signal });

    await expect(project.run(`(infer "fast" "x")`)).rejects.toThrow(/no model configured for tier "fast"/);

    ac.abort();
    await draining;
  });

  it("fails when the configured provider has no registered backend", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("fast", "anthropic", "claude-sonnet-4-6");

    const ac = new AbortController();
    const draining = runWorker({ project, cache, backends: { openai: { complete: vi.fn() } }, signal: ac.signal });

    await expect(project.run(`(infer "fast" "x")`)).rejects.toThrow(/no backend registered for provider "anthropic"/);

    ac.abort();
    await draining;
  });

  it("backwards-compatible: a single ModelBackend bypasses project.models entirely", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // No setModel — single-backend mode treats the tier string as the
    // concrete model directly, so this path doesn't need configuration.
    cache.upsertTask("fast", "x", null).result = new InferenceResult({ valueJson: '"cached"' });

    const value = await project.run(`(car (infer "fast" "x"))`);
    expect(value).toBe("cached");
  });
});
