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
import { createInferStore, InferBinding } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";

// A backend whose completions stay pending until the test explicitly resolves
// them by prompt — this reproduces the in-flight window the old
// `cache.upsertTask(...).result = …` poke used to create. Models with no infer
// (e.g. pure arithmetic programs) never call `complete`, so the store is inert.
const deferredBackend = () => {
  const resolvers = new Map<string, (v: { value: unknown }) => void>();
  const complete = (spec: ModelSpec) =>
    new Promise<{ value: unknown }>((resolve) => {
      resolvers.set(spec.prompt, resolve);
    });
  const resolve = (prompt: string, value: unknown) => {
    const r = resolvers.get(prompt);
    if (!r) throw new Error(`no pending infer for prompt ${JSON.stringify(prompt)}`);
    r({ value });
  };
  return { complete, resolve };
};

// The trace-side replacement for `cache.upsertTask(model, prompt, null)`: pull
// the live InferBinding the evaluator stamped for a given prompt.
const bindingFor = (trace: EvalTrace, prompt: string): InferBinding | undefined =>
  [...trace.invocationByTask.keys()].find(
    (k): k is InferBinding => k instanceof InferBinding && k.prompt === prompt,
  );

describe("Layer 2 — EvalTrace records map", () => {
  it("keys records by AST identity; loop bodies accumulate invocations on one node", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: deferredBackend().complete })));
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
    project.bindInfer(createInferStore(singletonRouter({ complete: deferredBackend().complete })));
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
    // A deferred backend leaves the "slow" infer pending forever until we
    // resolve it → a clean in-flight window to inspect.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = deferredBackend();
    project.bindInfer(createInferStore(singletonRouter({ complete: backend.complete })));

    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });

    // Let the evaluator reach the (infer …) call and park on the cell promise.
    await new Promise((r) => setTimeout(r, 30));

    // Find the record for the (infer …) call: it has entered === 1, exited === 0.
    const pending = [...trace.records.values()].filter((r) => r.entered > r.exited);
    expect(pending.length).toBeGreaterThan(0);
    const inferRec = pending.find((r) => r.entered === 1 && r.exited === 0);
    expect(inferRec).toBeDefined();
    const [inv] = inferRec!.bindings;
    expect(inv.state).toBe("running");

    // Now resolve the infer — exit fires, state flips, bindings unchanged.
    backend.resolve("p", "done");
    expect(await inflight).toBe("done");
    expect(inferRec!.exited).toBe(1);
    expect(inferRec!.bindings.size).toBe(1);
    expect(inv.state).toBe("resolved");
  });

  it("MobX reactivity: the `entries` box ticks across enter/exit", async () => {
    // The trace's hot machinery (Invocation/NodeRecord/records) is INTENTIONALLY
    // plain — making 46k-deep loops' invocations each a MobX observable retained
    // ~186MB of admin and GC-froze the tab. The single reactive signal renderers
    // subscribe to is the `entries` box (a monotonic enter-count); per-record
    // fields are read off the PLAIN snapshot the rebuild takes, not observed.
    // So this test now proves reactivity through `entries`, not `rec.exited`.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = deferredBackend();
    project.bindInfer(createInferStore(singletonRouter({ complete: backend.complete })));

    const trace = new EvalTrace();
    const ticks: number[] = [];

    // Autorun subscribing to ONLY the entries box — the renderer's actual signal.
    const dispose = autorun(() => {
      ticks.push(trace.entries);
    });

    const before = trace.entries;
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));
    backend.resolve("p", "done");
    await inflight;
    // Give MobX a microtask to flush.
    await new Promise((r) => setTimeout(r, 0));
    dispose();

    // The autorun fired more than once (the box ticked as the program ran) and
    // the count strictly grew — proving the reactive boundary is live.
    expect(ticks.length).toBeGreaterThan(1);
    expect(trace.entries).toBeGreaterThan(before);
    // The plain snapshot still reflects the resolved transition (read directly).
    const inferRec = [...trace.records.values()].find((r) => r.entered === 1 && r.exited === 1 && [...r.bindings].some((inv) => inv.state === "resolved"));
    expect(inferRec).toBeDefined();
  });

  it("task ↔ invocation linkage: infer rosetta stamps creating invocation", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = deferredBackend();
    project.bindInfer(createInferStore(singletonRouter({ complete: backend.complete })));
    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));

    // The binding was stamped at infer call. Look it up and check trace knows the inv.
    const task = bindingFor(trace, "p")!;
    expect(task).toBeDefined();
    const inv = trace.invocationFor(task);
    expect(inv).toBeDefined();
    expect(inv!.state).toBe("running");
    // The node that birthed this binding is the (infer …) Pair.
    expect((inv!.node.car as { __name__?: string }).__name__).toBe("infer");

    // Resolve and finish — the link survives completion.
    backend.resolve("p", "done");
    await inflight;
    expect(trace.invocationFor(task)).toBe(inv);
    expect(inv!.state).toBe("resolved");
  });

  it("concurrent fan-out: N parallel infer calls produce N invocations with shared parent", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = deferredBackend();
    project.bindInfer(createInferStore(singletonRouter({ complete: backend.complete })));
    const trace = new EvalTrace();

    // 3 distinct prompts → 3 bindings → 3 invocations, all of the same inner
    // (infer …) AST node, all sharing the same parent (the lambda body app).
    const inflight = project.run(
      `(map (lambda (i) (car (infer "slow" i))) (list "a" "b" "c"))`,
      { trace },
    );
    await new Promise((r) => setTimeout(r, 50));

    const tA = bindingFor(trace, "a")!;
    const tB = bindingFor(trace, "b")!;
    const tC = bindingFor(trace, "c")!;
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

    backend.resolve("a", "A");
    backend.resolve("b", "B");
    backend.resolve("c", "C");
    await inflight;
  });

  it("provenance walk: from a live task back to the program root via ancestors()", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = deferredBackend();
    project.bindInfer(createInferStore(singletonRouter({ complete: backend.complete })));
    const trace = new EvalTrace();
    const inflight = project.run(`(car (infer "slow" "p"))`, { trace });
    await new Promise((r) => setTimeout(r, 30));

    const task = bindingFor(trace, "p")!;
    const inv = trace.invocationFor(task)!;
    const chain = inv.ancestors();
    // The chain ends at a root invocation (parent === null).
    expect(chain[chain.length - 1].parent).toBeNull();
    // The first link is the (infer …) form itself.
    expect((chain[0].node.car as { __name__?: string }).__name__).toBe("infer");
    // The parent of the infer call is the (car …) form.
    expect((chain[1].node.car as { __name__?: string }).__name__).toBe("car");

    backend.resolve("p", "done");
    await inflight;
  });

  it("runTraced: returns the parsed user forms with identities matching the records map", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: deferredBackend().complete })));
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
    project.bindInfer(createInferStore(singletonRouter({ complete: deferredBackend().complete })));
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
