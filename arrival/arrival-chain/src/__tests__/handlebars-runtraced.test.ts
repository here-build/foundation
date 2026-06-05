import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { EvalTrace } from "../trace.js";

describe("hbs via runTraced (browser path)", () => {
  it("dict + en-to-fr template works in runTraced", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: "vendre la mèche" }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));
    project.addFile("fr-of-en.hbs", `French of: {{english}}`);
    const trace = new EvalTrace();
    const src = `
      (define fr-of-en (lambda (english) (car (infer "fast" ((require "fr-of-en.hbs") english)))))
      (fr-of-en "spill the beans")
    `;
    const { finished } = await project.runTraced(src, { trace });
    const r = await finished;
    expect(r).toBe("vendre la mèche");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].prompt).toBe("French of: spill the beans");
  });
});
