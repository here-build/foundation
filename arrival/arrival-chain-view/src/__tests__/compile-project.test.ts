/**
 * Project assembly — the end-to-end step. `compileProject` turns a flat source map
 * into a runnable directory for any of the four corners. These are STRUCTURAL tests
 * (right files, right names, runnable glue); the actual execution against a live
 * endpoint is a manual/__custdev__ run, not a CI gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../compile-project.js";

const fixtureDir = fileURLToPath(new URL("fixtures/", import.meta.url));
const fx = (name: string): string => readFileSync(fixtureDir + name, "utf8");

const FILES: Record<string, string> = {
  "gepa.scm": fx("gepa.scm"),
  "metric.scm": fx("metric.scm"),
  "predict.prompt": fx("predict.prompt"),
  "improve.prompt": fx("improve.prompt"),
  "examples.json": '[{ "id": 1, "input": "hello", "expected": "HELLO" }]\n',
  "seed.txt": "Echo the input.\n",
};

const pathsOf = (files: { path: string }[]): string[] => files.map((f) => f.path).sort();

describe("compileProject — python + dspy", () => {
  it("assembles a runnable tree with no specifier rewriting needed", async () => {
    const files = await compileProject(FILES, "gepa.scm", { language: "py", prompts: "dspy" });
    expect(pathsOf(files)).toEqual(
      [
        "_llm.py",
        "examples.json",
        "improve_prompt.py",
        "main.py",
        "metric.py",
        "predict_prompt.py",
        "requirements.txt",
        "seed.txt",
      ].sort(),
    );
    const gepa = files.find((f) => f.path === "main.py")!.content; // entry → main (collision-safe)
    expect(gepa).toContain("from metric import metric");
    expect(gepa).toContain("run_predict(instruction="); // run-view: cache key dropped
    expect(gepa).not.toContain("run_predict(["); // …no cache-key positional
    expect(gepa).toContain("print("); // entry result surfaced
    expect(files.find((f) => f.path === "predict_prompt.py")!.content).toContain("dspy.Predict");
    expect(files.find((f) => f.path === "requirements.txt")!.content).toContain("dspy");
  });
});

describe("compileProject — js + ax", () => {
  it("assembles a tsx-runnable TS project, specifiers + data imports rewritten", async () => {
    const files = await compileProject(FILES, "gepa.scm", { language: "js", prompts: "ax" });
    const paths = pathsOf(files);
    expect(paths).toContain("main.ts");
    expect(paths).toContain("metric.ts");
    expect(paths).toContain("predict.prompt.ts");
    expect(paths).toContain("_ai.ts");
    expect(paths).toContain("package.json");

    const gepa = files.find((f) => f.path === "main.ts")!.content;
    expect(gepa).toContain('from "./metric.js"'); // .scm → .js
    expect(gepa).toContain('from "./predict.prompt.js"'); // .prompt → .prompt.js
    expect(gepa).toContain("__readText("); // .txt import → readFileSync
    expect(gepa).toContain('with { type: "json" }'); // .json import attribute
    expect(gepa).toContain("console.log"); // entry result surfaced

    expect(files.find((f) => f.path === "metric.ts")!.content).toContain("export { metric };"); // spilled module exported
    expect(files.find((f) => f.path === "package.json")!.content).toContain("tsx");
  });
});

describe("compileProject — guards", () => {
  it("rejects a backend that doesn't match the language", async () => {
    await expect(compileProject(FILES, "gepa.scm", { language: "py", prompts: "ax" })).rejects.toThrow(
      /not a py backend/,
    );
  });
});
