import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { inferKey, seededCache } from "./_seeded-cache.js";

const neverBackend = singletonRouter({
  complete: async () => {
    throw new Error("backend hit — expected a content-cache replay");
  },
});

describe("infer/chat — role-tagged message list", () => {
  it("serialises (role content) pairs into a canonical JSON prompt", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (s: ModelSpec) => ({ value: `recv:${s.prompt}` }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer/chat "fast"
        (list (infer/chat/system "be terse")
              (infer/chat/user   "hello")))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].prompt).toBe(
      '[{"role":"system","content":"be terse"},{"role":"user","content":"hello"}]',
    );
  });

  it("dedupes identical message lists to a single task", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "ok" }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    const program = `
      (infer/chat "fast"
        (list (infer/chat/system "be terse")
              (infer/chat/user   "hello")))
    `;
    await project.run(program);
    await project.run(program);

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("different messages produce different tasks", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "ok" }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer/chat "fast" (list (infer/chat/user "first")))
      (infer/chat "fast" (list (infer/chat/user "second")))
    `);

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("cache-key composes with infer/chat the same way as infer", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "ok" }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (map (lambda (i)
             (car (infer/chat "fast" (list (infer/chat/user "same")) #f (number->string i))))
           (list 0 1 2))
    `);

    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("infer/chat seeds and replays from a pre-populated cache without the worker", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const canonical = '[{"role":"system","content":"sys"},{"role":"user","content":"u"}]';
    project.bindInfer(createInferStore(neverBackend, seededCache({ [inferKey("fast", canonical)]: "hit" })));

    const value = await project.run(`
      (car (infer/chat "fast"
             (list (infer/chat/system "sys")
                   (infer/chat/user   "u"))))
    `);

    expect(value).toBe("hit");
  });
});
