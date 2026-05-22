import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";

describe("project/get — read-only env access from scheme", () => {
  it("reads a single-component path", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.setEnv("product-name", "Visual Studio");

    const value = await project.run(`(project/get "product-name")`);
    expect(value).toBe("Visual Studio");
  });

  it("reads a nested path", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.setEnv("audience", "count", 5);

    const value = await project.run(`(project/get "audience" "count")`);
    expect(value).toBe(5);
  });

  it("supports string, number, and boolean values", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.setEnv("s", "hello");
    project.setEnv("n", 42);
    project.setEnv("b", true);

    const out = await project.run(`
      (list (project/get "s") (project/get "n") (project/get "b"))
    `);
    expect(out).toEqual(["hello", 42, true]);
  });

  it("threads project env into an infer prompt", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.setEnv("product-name", "Lens");
    project.upsertTask("fast", "Greet Lens", null, null).result = new InferenceResult({ valueJson: '"hi Lens"' });

    const value = await project.run(`
      (car (infer "fast" (string-append "Greet " (project/get "product-name"))))
    `);
    expect(value).toBe("hi Lens");
  });

  it("throws on a missing env entry", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    await expect(project.run(`(project/get "absent")`)).rejects.toThrow(/no env entry at path/);
  });
});
