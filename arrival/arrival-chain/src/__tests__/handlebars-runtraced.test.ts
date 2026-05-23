import { describe, expect, it } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { EvalTrace } from "../trace.js";

describe("hbs via runTraced (browser path)", () => {
  it("dict + en-to-fr template works in runTraced", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("fr-of-en.hbs", `French of: {{english}}`);
    const trace = new EvalTrace();
    const src = `
      (define fr-of-en (lambda (english) (car (infer "fast" ((require "fr-of-en.hbs") english)))))
      (fr-of-en "spill the beans")
    `;
    const seed = setInterval(() => {
      for (const t of cache.tasks.values()) {
        if (t.result === null) t.result = new InferenceResult({ valueJson: JSON.stringify("vendre la mèche") });
      }
    }, 5);
    try {
      const { finished } = await project.runTraced(src, { trace });
      const r = await finished;
      expect(r).toBe("vendre la mèche");
    } finally { clearInterval(seed); }
    expect(cache.tasks.size).toBe(1);
    const [task] = [...cache.tasks.values()];
    expect(task.prompt).toBe("French of: spill the beans");
  });
});
