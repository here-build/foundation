import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { runProjectWorker } from "../worker.js";

describe("infer/chat — role-tagged message list", () => {
  it("serialises (role content) pairs into a canonical JSON prompt", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (s: ModelSpec) => `recv:${s.prompt}`);
    const ac = new AbortController();
    const draining = runProjectWorker(project, { backends: { complete }, signal: ac.signal });

    await project.run(`
      (infer/chat "fast"
        (list (infer/chat/system "be terse")
              (infer/chat/user   "hello")))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].prompt).toBe(
      '[{"role":"system","content":"be terse"},{"role":"user","content":"hello"}]',
    );
    ac.abort(); await draining;
  });

  it("dedupes identical message lists to a single task", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => "ok");
    const ac = new AbortController();
    const draining = runProjectWorker(project, { backends: { complete }, signal: ac.signal });

    const program = `
      (infer/chat "fast"
        (list (infer/chat/system "be terse")
              (infer/chat/user   "hello")))
    `;
    await project.run(program);
    await project.run(program);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(project.tasks.size).toBe(1);
    ac.abort(); await draining;
  });

  it("different messages produce different tasks", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => "ok");
    const ac = new AbortController();
    const draining = runProjectWorker(project, { backends: { complete }, signal: ac.signal });

    await project.run(`
      (infer/chat "fast" (list (infer/chat/user "first")))
      (infer/chat "fast" (list (infer/chat/user "second")))
    `);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(project.tasks.size).toBe(2);
    ac.abort(); await draining;
  });

  it("cache-key composes with infer/chat the same way as infer", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => "ok");
    const ac = new AbortController();
    const draining = runProjectWorker(project, { backends: { complete }, signal: ac.signal });

    await project.run(`
      (map (lambda (i)
             (car (infer/chat "fast" (list (infer/chat/user "same")) #f (number->string i))))
           (list 0 1 2))
    `);

    expect(complete).toHaveBeenCalledTimes(3);
    expect(project.tasks.size).toBe(3);
    ac.abort(); await draining;
  });

  it("infer/chat seeds and replays from a pre-populated cache without the worker", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const canonical = '[{"role":"system","content":"sys"},{"role":"user","content":"u"}]';
    project.upsertTask("fast", canonical, null, null).result = new InferenceResult({ valueJson: '"hit"' });

    const value = await project.run(`
      (car (infer/chat "fast"
             (list (infer/chat/system "sys")
                   (infer/chat/user   "u"))))
    `);

    expect(value).toBe("hit");
  });
});
