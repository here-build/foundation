import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";

describe("demo flow: hbs + dict + infer", () => {
  it("end-to-end with stubbed infer", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (s: ModelSpec) => {
      const isFrOfEn = s.prompt.startsWith("French of:");
      return { value: isFrOfEn ? "vendre la mèche" : "spill the beans" };
    });
    project.bindInfer(createInferStore(singletonRouter({ complete })));
    project.addFile("fr-of-en.hbs", `French of: {{english}}`);
    project.addFile("en-of-fr.hbs", `English of: {{french}}`);
    const program = project.addProgram("demo.scm", `
      (define fr-of-en (lambda (english) (car (infer "fast" ((require "fr-of-en.hbs") english)))))
      (define en-of-fr (lambda (french)  (car (infer "fast" ((require "en-of-fr.hbs") french)))))
      (define (round-trip english)
        (list english (fr-of-en english) (en-of-fr (fr-of-en english))))
      (round-trip "spill the beans")
    `);
    const r = await program.run();
    expect(r).toEqual(["spill the beans", "vendre la mèche", "spill the beans"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
