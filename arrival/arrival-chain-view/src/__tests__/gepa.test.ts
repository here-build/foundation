/**
 * The golden: the full GEPA example chain → formatted JS read-view. The snapshot
 * IS the golden artifact; the explicit fragment assertions encode the INTENT
 * (the bug-fixes over the hand-written gepa.ts), so the snapshot can't silently
 * drift away from correctness.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectToJs } from "../project.js";

// Self-contained fixtures (copied from examples/host-gepa). The golden stays
// stable regardless of edits to the live example — which is actively authored.
const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string) => readFileSync(fixtureDir + name, "utf8");

// `.scm` spill resolution reads sibling sources (here, metric.scm). Pure injection.
const requireSource = (path: string): string | undefined => {
  try {
    return read(path);
  } catch {
    return undefined;
  }
};

describe("gepa.scm → JS read-view", () => {
  it("projects to formatted JS (golden snapshot)", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource });
    expect(out).toMatchSnapshot();
  });

  it("imports resolve to the right shapes", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource });
    expect(out).toContain('import { metric } from "./metric.scm";'); // .scm bare spill → named
    expect(out).toContain('import examples from "./examples.json";'); // .json → default (not * as)
    expect(out).toContain('import runPredict from "./predict.prompt";'); // .prompt → default
    expect(out).toContain('import runImprove from "./improve.prompt";');
    expect(out).toContain('import seed from "./seed.txt";'); // inline require hoisted
  });

  it("fixes the hand-written gepa.ts bugs", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource });
    expect(out).toContain("[...pool, ...pool.map(mutate)]"); // append, not R.append
    expect(out).not.toContain("R.append");
    expect(out).not.toContain("R.maxBy");
    expect(out).not.toContain("R.sum");
    expect(out).not.toContain("Symbol("); // kwargs are an options object, not Symbol pairs
    expect(out).not.toContain("await import"); // read-view is synchronous: no async seed import
  });

  it("emits the right top-level shape", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource });
    expect(out).toContain("const dominates = (a, b) =>"); // dominates? → dominates
    expect(out).toContain("const ask = (instruction, input) =>"); // run-predict → runPredict call
    expect(out).toContain("gepa(seed, 4);"); // top-level expression → statement
  });

  it("preserves the leading doc comments (legibility)", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource });
    expect(out).toContain("// Pareto frontier"); // a `;;` comment carried into the read-view
  });

  it("is deterministic", async () => {
    const a = await projectToJs(read("gepa.scm"), { requireSource });
    const b = await projectToJs(read("gepa.scm"), { requireSource });
    expect(a).toBe(b);
  });
});
