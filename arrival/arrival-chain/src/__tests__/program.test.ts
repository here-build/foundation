import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { inferKey, seededCache } from "./_seeded-cache.js";

const neverBackend = singletonRouter({
  complete: async () => {
    throw new Error("backend hit — expected a content-cache replay");
  },
});

describe("Program — versioned source + run against the project inference store", () => {
  it("addProgram creates a file, schedules it, run executes the latest version", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(neverBackend, seededCache({ [inferKey("m", "p1")]: "X", [inferKey("m", "X/p2")]: "done" })),
    );
    const program = project.addProgram("demo", `
      (define a (car (infer "m" "p1")))
      (car (infer "m" (string-append a "/p2")))
    `);

    expect(project.files.get("demo")).toBe(program);
    expect(program.versions.length).toBe(1);
    expect(await program.run()).toBe("done");
  });

  it("publish appends a new version; run uses the latest by default", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(neverBackend, seededCache({ [inferKey("m", "first")]: "r1", [inferKey("m", "second")]: "r2" })),
    );
    const program = project.addProgram("demo", `(car (infer "m" "first"))`);

    expect(await program.run()).toBe("r1");

    program.publish(`(car (infer "m" "second"))`);
    expect(program.versions.length).toBe(2);

    expect(await program.run()).toBe("r2");
  });

  it("ProgramVersion.run pins execution to that specific version", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(neverBackend, seededCache({ [inferKey("m", "v1")]: "a", [inferKey("m", "v2")]: "b" })),
    );
    const program = project.addProgram("demo", `(car (infer "m" "v1"))`);
    program.publish(`(car (infer "m" "v2"))`);

    expect(await program.versions[0].run()).toBe("a");
    expect(await program.versions[1].run()).toBe("b");
  });
});
