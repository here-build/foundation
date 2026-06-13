/**
 * Run model — apiCalls (reverse-membrane), sandbox (forward-membrane),
 * and hypothesis counterfactual replays.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { RunError, RunResult } from "../run.js";
import { EvalTrace } from "../trace.js";

const fresh = () => {
  const project = ArrivalChain.bootstrap(new Project()).root;
  return { project };
};

const waitFor = async (cond: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("Project.invoke — reverse-membrane apiCall Run", () => {
  it("mints a Run under the target file, resolves with value", async () => {
    const { project } = fresh();
    project.addFile("math.scm", `(define (double x) (* x 2))`);
    const program = project.findFile("math.scm")!;

    const run = project.invoke({ id: "t1", file: "math.scm", name: "double", args: [21] });

    expect(program.apiCalls.get("t1")).toBe(run);
    expect(run.status).toBe("pending");
    expect(run.hasInput).toBe(true);
    expect(run.name).toBe("double");
    expect(run.args).toEqual([21]);
    expect(run.versionIndex).toBe(0);

    await waitFor(() => run.status !== "pending");
    expect(run.status).toBe("resolved");
    expect(run.output).toBeInstanceOf(RunResult);
    expect((run.output as RunResult).value).toBe(42);
  });

  it("preserves object/array args through json/parse round-trip", async () => {
    const { project } = fresh();
    project.addFile(
      "lib.scm",
      `(define (echo-name obj) (@ obj "name"))
       (define (sum xs) (apply + xs))`,
    );

    const a = project.invoke({ id: "obj", file: "lib.scm", name: "echo-name", args: [{ name: "v" }] });
    const b = project.invoke({ id: "arr", file: "lib.scm", name: "sum", args: [[1, 2, 3, 4]] });

    await waitFor(() => a.status !== "pending" && b.status !== "pending");
    expect((a.output as RunResult).value).toBe("v");
    expect((b.output as RunResult).value).toBe(10);
  });

  it("failure path writes RunError with status=failed", async () => {
    const { project } = fresh();
    project.addFile("bad.scm", `(define (boom) (not-a-real-symbol))`);
    const run = project.invoke({ id: "f1", file: "bad.scm", name: "boom", args: [] });
    await waitFor(() => run.status !== "pending");
    expect(run.status).toBe("failed");
    expect(run.output).toBeInstanceOf(RunError);
  });

  it("missing file throws synchronously", () => {
    const { project } = fresh();
    expect(() => project.invoke({ id: "x", file: "ghost.scm", name: "f", args: [] })).toThrow(/not found/);
  });

  it("duplicate id within same program throws synchronously", () => {
    const { project } = fresh();
    project.addFile("a.scm", `(define (f) 1)`);
    project.invoke({ id: "dup", file: "a.scm", name: "f", args: [] });
    expect(() => project.invoke({ id: "dup", file: "a.scm", name: "f", args: [] })).toThrow(/already exists/);
  });

  it("records every infer call in run.effects as the trace (kind-tagged keys)", async () => {
    const { project } = fresh();
    const complete = vi.fn(async (s: { prompt: string }) => ({ value: `seen:${s.prompt}` }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    project.addFile(
      "ai.scm",
      `(define (ask)
         (string-append
           (car (infer "m" "p1")) "/"
           (car (infer "m" "p2"))))`,
    );
    const run = project.invoke({ id: "ai1", file: "ai.scm", name: "ask", args: [] });
    await waitFor(() => run.status !== "pending");

    expect(run.status).toBe("resolved");
    expect((run.output as RunResult).value).toBe("seen:p1/seen:p2");
    expect(run.effects.length).toBe(2);
    // Effect keys are kind-tagged: ["infer", model, prompt, schema, cacheKey].
    expect(run.effects[0]).toBe(JSON.stringify(["infer", "m", "p1", null, null]));
    expect(run.effects[1]).toBe(JSON.stringify(["infer", "m", "p2", null, null]));
  });
});

describe("Project.sandboxRun — forward-membrane sandbox Run", () => {
  it("mints a sandbox Run with no input, populates inferences", async () => {
    const { project } = fresh();
    project.bindInfer(createInferStore(singletonRouter({ complete: async () => ({ value: "ok" }) })));

    project.addFile("main.scm", `(car (infer "m" "hi"))`);
    const program = project.findFile("main.scm")!;
    const { run, finished } = project.sandboxRun({ id: "s1", file: "main.scm" });
    // sandboxRun auto-creates the draft and writes the Run under draft.sandbox
    expect(program.draft).not.toBeNull();
    expect(program.draft!.sandbox.get("s1")).toBe(run);
    expect(run.hasInput).toBe(false);
    expect(run.versionIndex).toBe(0);

    await finished;
    expect(run.status).toBe("resolved");
    expect((run.output as RunResult).value).toBe("ok");
    expect(run.effects.length).toBe(1);
    expect(run.effects[0]).toBe(JSON.stringify(["infer", "m", "hi", null, null]));
  });
});

describe("Project.sandboxRunTraced — studio sandbox with userForms", () => {
  it("writes to the file's draft (auto-created), never publishes a version", async () => {
    const { project } = fresh();
    project.addFile("a.scm", `(define (f) 1)\n(f)`);
    const program = project.findFile("a.scm")!;
    expect(program.versions.length).toBe(1);
    expect(program.draft).toBeNull();

    // Same source as the deployed version — draft is materialized but versions
    // are untouched; sandbox run lands under the draft.
    const r1 = await project.sandboxRunTraced({
      id: "s1",
      file: "a.scm",
      source: `(define (f) 1)\n(f)`,
      trace: new EvalTrace(),
    });
    await r1.finished;
    expect(program.versions.length).toBe(1);
    expect(program.draft).not.toBeNull();
    expect(program.draft!.sandbox.get("s1")).toBe(r1.run);
    expect(r1.run.versionIndex).toBe(0);
    expect((r1.run.output as RunResult).value).toBe(1);

    // Different source — still no new version; draft.source updates, the new
    // sandbox run reads from the updated draft.
    const r2 = await project.sandboxRunTraced({
      id: "s2",
      file: "a.scm",
      source: `(define (f) 2)\n(f)`,
      trace: new EvalTrace(),
    });
    await r2.finished;
    expect(program.versions.length).toBe(1);
    expect(program.draft!.source).toBe(`(define (f) 2)\n(f)`);
    expect(r2.run.versionIndex).toBe(0); // pinned to basedOnVersion, NOT a new version
    expect((r2.run.output as RunResult).value).toBe(2);
  });

  it("promoteDraft appends a new version and clears the draft", () => {
    const { project } = fresh();
    project.addFile("a.scm", `(define (f) 1)`);
    const program = project.findFile("a.scm")!;
    project.editDraftSource({ file: "a.scm", source: `(define (f) 2)` });
    expect(program.versions.length).toBe(1);
    expect(program.draft).not.toBeNull();

    const version = project.promoteDraft({ file: "a.scm" });
    expect(program.versions.length).toBe(2);
    expect(version.source).toBe(`(define (f) 2)`);
    expect(program.draft).toBeNull();
  });

  it("discardDraft drops the draft (and its sandbox runs) without publishing", () => {
    const { project } = fresh();
    project.addFile("a.scm", `(define (f) 1)`);
    const program = project.findFile("a.scm")!;
    project.editDraftSource({ file: "a.scm", source: `(define (f) 999)` });
    expect(program.draft).not.toBeNull();
    project.discardDraft({ file: "a.scm" });
    expect(program.draft).toBeNull();
    expect(program.versions.length).toBe(1);
    expect(program.versions[0]!.source).toBe(`(define (f) 1)`);
  });

  it("returns userForms (the parsed top-level Pairs for tap-attached UI)", async () => {
    const { project } = fresh();
    project.addFile("b.scm", `(+ 1 2)\n(* 3 4)`);
    const { userForms, finished } = await project.sandboxRunTraced({
      id: "u",
      file: "b.scm",
      source: `(+ 1 2)\n(* 3 4)`,
      trace: new EvalTrace(),
    });
    await finished;
    expect(userForms.length).toBe(2);
  });
});

describe("Project.runHypothesis — counterfactual replay", () => {
  it("substitutes a tweaked infer result, leaves other cells intact", async () => {
    const { project } = fresh();
    const complete = vi.fn(async (s: { prompt: string }) => ({ value: `real:${s.prompt}` }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    project.addFile(
      "branch.scm",
      `(define (run)
         (string-append (car (infer "m" "a")) "+" (car (infer "m" "b"))))`,
    );
    const original = project.invoke({ id: "orig", file: "branch.scm", name: "run", args: [] });
    await waitFor(() => original.status !== "pending");
    expect((original.output as RunResult).value).toBe("real:a+real:b");
    expect(original.effects.length).toBe(2);

    // Tweak the FIRST inference. The `tweaks` counterfactual surface keys by the
    // UNTAGGED content tuple (model="m", prompt="a", schema=null, cacheKey=null) —
    // distinct from the kind-tagged effect key the effect-log uses.
    const aTuple = JSON.stringify(["m", "a", null, null]);
    const tweaks = new Map<string, string>([[aTuple, JSON.stringify("forced-a")]]);

    const { hypothesis, finished } = project.runHypothesis({ id: "h1", run: original, tweaks });
    const v = await finished;
    expect(v).toBe("forced-a+real:b");
    expect(hypothesis.status).toBe("resolved");
    // Hypothesis effects should only contain the non-tweaked cell (kind-tagged);
    // the tweaked branch short-circuits before any cache lookup.
    expect(hypothesis.effects.length).toBe(1);
    expect(hypothesis.effects[0]).toBe(JSON.stringify(["infer", "m", "b", null, null]));
    expect(original.hypotheses.get("h1")).toBe(hypothesis);
  });

  it("hypothesis runs against the pinned version, not the latest", async () => {
    const { project } = fresh();
    project.addFile("v.scm", `(define (f) 1)`);
    const run = project.invoke({ id: "r", file: "v.scm", name: "f", args: [] });
    await waitFor(() => run.status !== "pending");
    expect((run.output as RunResult).value).toBe(1);

    // Bump the file to a new version with different behavior.
    const program = project.findFile("v.scm")!;
    project.transact(() => program.publish(`(define (f) 999)`));

    const { hypothesis, finished } = project.runHypothesis({
      id: "h",
      run,
      tweaks: new Map(),
    });
    const v = await finished;
    expect(v).toBe(1); // pinned to original version, NOT 999
    expect(hypothesis.status).toBe("resolved");
  });
});
