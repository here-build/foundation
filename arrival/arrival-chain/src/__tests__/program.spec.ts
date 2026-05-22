import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";

const result = (json: string) => new InferenceResult({ valueJson: json });

describe("Program — versioned source + run against the project task cache", () => {
  it("addProgram creates a file, schedules it, run executes the latest version", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const program = project.addProgram("demo", `
      (define a (car (infer "m" "p1")))
      (car (infer "m" (string-append a "/p2")))
    `);
    project.upsertTask("m", "p1", null).result = result('"X"');
    project.upsertTask("m", "X/p2", null).result = result('"done"');

    expect(project.files.get("demo")).toBe(program);
    expect(project.programs).toContain(program);
    expect(program.versions.length).toBe(1);
    expect(await program.run()).toBe("done");
  });

  it("publish appends a new version; run uses the latest by default", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const program = project.addProgram("demo", `(car (infer "m" "first"))`);
    project.upsertTask("m", "first", null).result = result('"r1"');

    expect(await program.run()).toBe("r1");

    program.publish(`(car (infer "m" "second"))`);
    expect(program.versions.length).toBe(2);
    project.upsertTask("m", "second", null).result = result('"r2"');

    expect(await program.run()).toBe("r2");
  });

  it("ProgramVersion.run pins execution to that specific version", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const program = project.addProgram("demo", `(car (infer "m" "v1"))`);
    program.publish(`(car (infer "m" "v2"))`);
    project.upsertTask("m", "v1", null).result = result('"a"');
    project.upsertTask("m", "v2", null).result = result('"b"');

    expect(await program.versions[0].run()).toBe("a");
    expect(await program.versions[1].run()).toBe("b");
  });
});
