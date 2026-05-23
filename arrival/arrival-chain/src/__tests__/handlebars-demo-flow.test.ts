import { describe, expect, it } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";

describe("demo flow: hbs + dict + infer", () => {
  it("end-to-end with stubbed infer", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("fr-of-en.hbs", `French of: {{english}}`);
    project.addFile("en-of-fr.hbs", `English of: {{french}}`);
    const program = project.addProgram("demo.scm", `
      (define fr-of-en (lambda (english) (car (infer "fast" ((require "fr-of-en.hbs") english)))))
      (define en-of-fr (lambda (french)  (car (infer "fast" ((require "en-of-fr.hbs") french)))))
      (define (round-trip english)
        (list english (fr-of-en english) (en-of-fr (fr-of-en english))))
      (round-trip "spill the beans")
    `);
    const seed = setInterval(() => {
      for (const t of cache.tasks.values()) {
        if (t.result !== null) continue;
        const isFrOfEn = t.prompt.startsWith("French of:");
        t.result = new InferenceResult({ valueJson: JSON.stringify(isFrOfEn ? "vendre la mèche" : "spill the beans") });
      }
    }, 5);
    try {
      const r = await program.run();
      expect(r).toEqual(["spill the beans", "vendre la mèche", "spill the beans"]);
    } finally { clearInterval(seed); }
    expect(cache.tasks.size).toBe(2);
  });
});
