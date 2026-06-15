import { createInferStore, type ModelSpec, singletonRouter } from "@here.build/arrival-inference";
import { exec, schemeToJs, sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { discoveryCapabilities } from "../packs/index.js";
import { Project } from "../project.js";

/** A discovery env (the read tier) over a project + a stub infer for the run plane. */
async function discoveryFor(files: Record<string, string>) {
  const project = ArrivalChain.bootstrap(new Project()).root;
  const complete = vi.fn(async (_s: ModelSpec) => ({ value: "hello" }));
  project.bindInfer(createInferStore(singletonRouter({ complete })));
  for (const [path, source] of Object.entries(files)) project.addFile(path, source);
  const packs = discoveryCapabilities().map((cap) => cap.lower({ config: { project } }));
  // Capabilities lower to `EnvPack<SchemeEnv>`; pin `E` to the concrete base so `.env` is `Environment`.
  const base = sandboxedEnv.inherit("discovery-test");
  const env = (await assembleEnv<typeof base>(base, packs)).env;
  // `exec` returns one result per top-level form; our exprs are single forms, so take the last.
  return async (expr: string): Promise<unknown> => {
    const results = schemeToJs(await exec(expr, { env }), {}) as unknown[];
    return Array.isArray(results) ? results.at(-1) : results;
  };
}

describe("require/* planes + why/where/how", () => {
  it("source channel: require/string reads text, require/ast reads forms", async () => {
    const run = await discoveryFor({ "main.scm": "(define greeting (infer 'fast' 'hi))\ngreeting" });
    expect(await run('(require/string "main.scm")')).toContain("define greeting");
    const ast = await run('(require/ast "main.scm")');
    expect(Array.isArray(ast)).toBe(true);
    expect((ast as unknown[]).length).toBeGreaterThan(0);
  });

  it("run channel: require/eval returns a handle the trichotomy projects", async () => {
    const run = await discoveryFor({ "main.scm": `(define verdict (car (infer "fast" "name it")))\nverdict` });
    // result-value reads the transparent value.
    expect(await run('(result-value (require/eval "main.scm"))')).toBe("hello");
    // why = lineage points (the infer read), how = the runnable slice, where = source locations.
    expect(await run('(why (require/eval "main.scm"))')).toHaveLength(1);
    expect(await run('(how (require/eval "main.scm"))')).toContain("verdict");
    const where = await run('(where (require/eval "main.scm"))');
    expect(Array.isArray(where)).toBe(true);
    expect((where as string[]).some((s) => s.includes("@"))).toBe(true);
  });

  it("require/call invokes one named fn with a wire-safe dict arg", async () => {
    const run = await discoveryFor({ "greet.scm": `(define (greet d) (string-append "hi " (@ d "name")))` });
    expect(await run('(result-value (require/call "greet.scm" :greet (dict :name "x")))')).toBe("hi x");
  });

  it("isolation: a run cannot call reflection — (why) is unbound in the run plane", async () => {
    const run = await discoveryFor({ "bad.scm": "(why 1)" });
    await expect(run('(require/eval "bad.scm")')).rejects.toThrow(/why/i);
  });

  it("choke IN: a non-wire-safe arg (a closure) is rejected at require/call", async () => {
    const run = await discoveryFor({ "greet.scm": `(define (greet d) "ok")` });
    await expect(run('(require/call "greet.scm" :greet (dict :f (lambda (x) x)))')).rejects.toThrow(/wire-unsafe/i);
  });

  it("choke OUT: a run returning a closure is rejected", async () => {
    const run = await discoveryFor({ "fn.scm": "(lambda (x) x)" });
    await expect(run('(require/eval "fn.scm")')).rejects.toThrow(/wire-unsafe/i);
  });

  it("budgets an unbounded run — returns a partial-trace handle, never hangs", async () => {
    const prev = process.env.ARRIVAL_RUN_BUDGET_MS;
    process.env.ARRIVAL_RUN_BUDGET_MS = "600";
    try {
      const run = await discoveryFor({ "loop.scm": "(define (spin n) (spin (+ n 1)))\n(spin 0)" });
      const v = (await run('(result-value (require/eval "loop.scm"))')) as Record<string, unknown>;
      expect(v).toMatchObject({ __timeout__: true });
      expect(typeof v.budgetMs).toBe("number");
    } finally {
      if (prev === undefined) delete process.env.ARRIVAL_RUN_BUDGET_MS;
      else process.env.ARRIVAL_RUN_BUDGET_MS = prev;
    }
  }, 10_000);

  it("dag renders the run's computation graph as sexpr (the console overview)", async () => {
    const run = await discoveryFor({ "main.scm": `(define a (infer "fast" "x"))\n(define b (infer "fast" "y"))\n(list a b)` });
    const dag = (await run('(dag (require/eval "main.scm"))')) as string;
    expect(typeof dag).toBe("string");
    expect(dag).toContain("(dag");
    expect(dag).toContain("(nodes");
    expect(dag).toContain("(node");
  });
});
