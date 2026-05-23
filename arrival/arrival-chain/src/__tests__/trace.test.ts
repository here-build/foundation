/**
 * Layer 2: NodeRecord map + MobX reactivity over the arrival-scheme tap.
 *
 * Builds a `Map<Pair, NodeRecord>` keyed by AST identity; verifies that
 * `bindings` is monotonic, counters track entered/exited, Invocation state
 * flips on completion, and MobX observers fire on changes.
 */
import { describe, expect, it } from "vitest";
import { autorun } from "mobx";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { EvalTrace, type NodeRecord } from "../trace.js";

const result = (json: string) => new InferenceResult({ valueJson: json });

describe("Layer 2 — EvalTrace records map", () => {
  it("keys records by AST identity; loop bodies accumulate invocations on one node", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const trace = new EvalTrace();
    await project.run("(map (lambda (x) (* x x)) '(1 2 3))", { trace });

    // The inner (* x x) Pair is the SAME node across three iterations.
    // No other form in this program is entered three times.
    const buckets = [...trace.records.values()].map((r) => r.entered).sort((a, b) => a - b);
    expect(buckets).toContain(3);

    // Every record should have entered === bindings.size (monotonic, no removal)
    // and entered === exited (this is a fully-synchronous program).
    for (const rec of trace.records.values()) {
      expect(rec.bindings.size).toBe(rec.entered);
      expect(rec.exited).toBe(rec.entered);
      for (const inv of rec.bindings) {
        expect(inv.state).toBe("resolved");
      }
    }
  });

  it("monotonic bindings: completed invocations stay in the set with state flipped", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const trace = new EvalTrace();
    await project.run("(+ 1 2)", { trace });

    // Find the user's (+ 1 2) form among records. Built-in preamble contributes
    // other entries; we identify ours as the top-level form (parent === null).
    const userForms = [...trace.records.values()].filter((r) =>
      [...r.bindings].some((inv) => inv.parent === null && (inv.node.car as { __name__?: string })?.__name__ === "+"),
    );
    expect(userForms).toHaveLength(1);
    const [rec] = userForms;
    expect(rec.entered).toBe(1);
    expect(rec.exited).toBe(1);
    expect(rec.bindings.size).toBe(1);
    const [inv] = rec.bindings;
    expect(inv.state).toBe("resolved");
    expect(inv.parent).toBeNull();
  });

  it("during a pending async form: exited < entered, invocation is running", async () => {
    // Use a tier with no registered backend AND no pre-seeded result → task
    // stays pending forever, giving us a clean in-flight window to inspect.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("slow", "stub:slow");

    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });

    // Let the evaluator reach the (infer …) call and park on the task promise.
    await new Promise((r) => setTimeout(r, 30));

    // Find the record for the (infer …) call: it has entered === 1, exited === 0.
    const pending = [...trace.records.values()].filter((r) => r.entered > r.exited);
    expect(pending.length).toBeGreaterThan(0);
    const inferRec = pending.find((r) => r.entered === 1 && r.exited === 0);
    expect(inferRec).toBeDefined();
    const [inv] = inferRec!.bindings;
    expect(inv.state).toBe("running");

    // Now resolve the task — exit fires, state flips, bindings unchanged.
    cache.upsertTask("slow", "p", null).result = result('"done"');
    expect(await inflight).toBe("done");
    expect(inferRec!.exited).toBe(1);
    expect(inferRec!.bindings.size).toBe(1);
    expect(inv.state).toBe("resolved");
  });

  it("MobX reactivity: observers fire on enter/exit", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("slow", "stub:slow");

    const trace = new EvalTrace();
    let snapshots: Array<{ entered: number; exited: number }> = [];
    let interestingRec: NodeRecord | undefined;

    // Start an autorun that, once a record appears, snapshots its counters.
    const dispose = autorun(() => {
      if (!interestingRec) {
        // Find the (infer …) record once it shows up.
        for (const rec of trace.records.values()) {
          if (rec.entered === 1 && rec.exited === 0) {
            interestingRec = rec;
            break;
          }
        }
      }
      if (interestingRec) {
        snapshots.push({ entered: interestingRec.entered, exited: interestingRec.exited });
      }
    });

    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));
    cache.upsertTask("slow", "p", null).result = result('"done"');
    await inflight;
    // Give MobX a microtask to flush.
    await new Promise((r) => setTimeout(r, 0));
    dispose();

    // We should have at least one snapshot with exited=0 (in-flight) and one
    // with exited=1 (resolved) — proving reactivity ran across the transition.
    expect(snapshots.some((s) => s.exited === 0)).toBe(true);
    expect(snapshots.some((s) => s.exited === 1)).toBe(true);
  });

  it("task ↔ invocation linkage: infer rosetta stamps creating invocation", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("slow", "stub:slow");
    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));

    // The task was upserted at infer call. Look it up by key and check trace knows the inv.
    const task = cache.upsertTask("slow", "p", null);
    const inv = trace.invocationFor(task);
    expect(inv).toBeDefined();
    expect(inv!.state).toBe("running");
    // The node that birthed this task is the (infer …) Pair.
    expect((inv!.node.car as { __name__?: string }).__name__).toBe("infer");

    // Resolve and finish — the link survives completion.
    task.result = result('"done"');
    await inflight;
    expect(trace.invocationFor(task)).toBe(inv);
    expect(inv!.state).toBe("resolved");
  });

  it("concurrent fan-out: N parallel infer calls produce N invocations with shared parent", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("slow", "stub:slow");
    const trace = new EvalTrace();

    // 3 distinct prompts → 3 tasks → 3 invocations, all of the same inner
    // (infer …) AST node, all sharing the same parent (the lambda body app).
    const inflight = project.run(
      `(map (lambda (i) (car (infer "slow" i))) (list "a" "b" "c"))`,
      { trace },
    );
    await new Promise((r) => setTimeout(r, 50));

    const tA = cache.upsertTask("slow", "a", null);
    const tB = cache.upsertTask("slow", "b", null);
    const tC = cache.upsertTask("slow", "c", null);
    const iA = trace.invocationFor(tA);
    const iB = trace.invocationFor(tB);
    const iC = trace.invocationFor(tC);
    expect(iA).toBeDefined();
    expect(iB).toBeDefined();
    expect(iC).toBeDefined();
    // Three distinct invocations off the same AST node.
    expect(iA!.node).toBe(iB!.node);
    expect(iB!.node).toBe(iC!.node);
    expect(new Set([iA, iB, iC]).size).toBe(3);

    tA.result = result('"A"');
    tB.result = result('"B"');
    tC.result = result('"C"');
    await inflight;
  });

  it("provenance walk: from a live task back to the program root via ancestors()", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.setModel("slow", "stub:slow");
    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));

    const task = cache.upsertTask("slow", "p", null);
    const inv = trace.invocationFor(task)!;
    const chain = inv.ancestors();
    // The chain ends at a root invocation (parent === null).
    expect(chain[chain.length - 1].parent).toBeNull();
    // The first link is the (infer …) form itself.
    expect((chain[0].node.car as { __name__?: string }).__name__).toBe("infer");
    // The parent of the infer call is the (car …) form.
    expect((chain[1].node.car as { __name__?: string }).__name__).toBe("car");

    task.result = result('"done"');
    await inflight;
  });

  it("runTraced: returns the parsed user forms with identities matching the records map", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const trace = new EvalTrace();
    const { userForms, finished } = await project.runTraced("(+ 1 2)", { trace });
    await finished;

    expect(userForms.length).toBe(1);
    const [userPlus] = userForms;
    // The Pair the caller renders MUST be the same identity used by the tap.
    expect(trace.records.has(userPlus as never)).toBe(true);
    const rec = trace.records.get(userPlus as never)!;
    expect(rec.entered).toBe(1);
    expect(rec.exited).toBe(1);
    // Records should NOT contain preamble forms (only the user (+ 1 2)).
    expect(trace.records.size).toBe(1);
  });

  it("Invocation ancestors() walks the dynamic stack to root", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const trace = new EvalTrace();
    await project.run("(+ (* 2 3) 1)", { trace });

    // Find the deepest invocation — the one whose node is (* 2 3).
    // It should walk: (* 2 3) → (+ (* 2 3) 1) → null.
    let deepest: import("../trace.js").Invocation | undefined;
    for (const rec of trace.records.values()) {
      for (const inv of rec.bindings) {
        if (inv.parent && !deepest) deepest = inv;
        if (inv.parent && inv.parent.parent === null) deepest = inv;
      }
    }
    expect(deepest).toBeDefined();
    const chain = [...deepest!.ancestors()];
    expect(chain.length).toBe(2);
    expect(chain[1].parent).toBeNull();
  });
});
