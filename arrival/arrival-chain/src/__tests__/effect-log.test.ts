/**
 * effect-log — the per-run record of every external effect + deterministic replay
 * + provenance forward-cone partial invalidation.
 *
 * The properties under test are the warrant behind born-legible replay:
 *   - keys are kind-tagged → the three effect kinds share one map without collision
 *   - a FULL log replays with ZERO external hits (a run is a pure function of its
 *     files + its effects, so substituting the recorded effects reproduces it)
 *   - partial invalidation = subtract a changed node's forward-cone: only the
 *     blast radius re-runs against the live plane; everything upstream/parallel
 *     replays from the log (the minimal recomputation)
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import type { DataEffect, DataEffectResolver } from "../data-effects.js";
import {
  dataEffectKey,
  effectKey,
  effectKeysByInvocation,
  effectLogCollector,
  httpEffectKey,
  inferEffectKey,
  invalidateForwardCone,
  invalidatedEffectKeys,
  sqlEffectKey,
  subtractKeys,
  type EffectLog,
} from "../effect-log.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { forwardCone, traceToStatechart } from "../statechart.js";
import { EvalTrace } from "../trace.js";

const fresh = () => ArrivalChain.bootstrap(new Project()).root;

// ── 1. Key algebra: tagging keeps the kinds disjoint ────────────────────────

describe("effect key algebra — kind tagging prevents infer/data collision", () => {
  it("an infer and a sql with identical content payload mint DIFFERENT keys", () => {
    // The collision the tag prevents: a prompt that is literally "select 1" and a
    // SQL query "select 1" would alias if keys weren't tagged by kind.
    const inferK = inferEffectKey("m", "select 1", null, null);
    const sqlK = sqlEffectKey("m", "select 1", "[]");
    expect(inferK).not.toBe(sqlK);
    expect(inferK).toBe(JSON.stringify(["infer", "m", "select 1", null, null]));
    expect(sqlK).toBe(JSON.stringify(["sql", "m", "select 1", "[]"]));
  });

  it("effectKey is the shared lowering: [kind, ...payload]", () => {
    expect(effectKey("http", ["GET", "api", "/x", "{}"])).toBe(JSON.stringify(["http", "GET", "api", "/x", "{}"]));
    expect(httpEffectKey("get", "api", "/x", "{}")).toBe(JSON.stringify(["http", "GET", "api", "/x", "{}"]));
  });

  it("dataEffectKey canonicalises query/headers/body order — same key regardless of object key order", () => {
    const a = dataEffectKey({
      kind: "http",
      method: "GET",
      label: "w",
      path: "/f",
      query: { city: "berlin", units: "c" },
    });
    const b = dataEffectKey({
      kind: "http",
      method: "GET",
      label: "w",
      path: "/f",
      query: { units: "c", city: "berlin" },
    });
    expect(a).toBe(b); // key-order-independent
    const c = dataEffectKey({
      kind: "http",
      method: "GET",
      label: "w",
      path: "/f",
      query: { city: "paris", units: "c" },
    });
    expect(a).not.toBe(c); // value-sensitive
  });

  it("dataEffectKey is method- and param-sensitive", () => {
    const get = dataEffectKey({ kind: "http", method: "GET", label: "w", path: "/f" });
    const post = dataEffectKey({ kind: "http", method: "POST", label: "w", path: "/f" });
    expect(get).not.toBe(post);
    const q1 = dataEffectKey({ kind: "sql", label: "db", query: "select $1", params: [1] });
    const q2 = dataEffectKey({ kind: "sql", label: "db", query: "select $1", params: [2] });
    expect(q1).not.toBe(q2);
  });
});

// ── 2. Full-log replay: zero external hits ──────────────────────────────────

const seenBackend = () => {
  const complete = vi.fn(async (s: ModelSpec) => ({ value: `seen:${s.prompt}` }));
  return { complete };
};

describe("effect-log replay — a full log reproduces a run with ZERO external hits", () => {
  it("collects a run's log, then replays it against a THROWING backend", async () => {
    // First run: real backend, collect the effect-log via onEffectResult.
    const realProject = fresh();
    const backend = seenBackend();
    realProject.bindInfer(createInferStore(singletonRouter(backend)));
    const program = `(string-append (car (infer "m" "p1")) "/" (car (infer "m" "p2")))`;
    const collector = effectLogCollector();
    const keys: string[] = [];
    const value = await realProject.run(program, {
      onEffect: (k) => keys.push(k),
      onEffectResult: collector.record,
    });
    expect(value).toBe("seen:p1/seen:p2");
    expect(backend.complete).toHaveBeenCalledTimes(2);
    // The log holds one entry per distinct effect, kind-tagged.
    expect([...collector.log.keys()]).toEqual([
      inferEffectKey("m", "p1", null, null),
      inferEffectKey("m", "p2", null, null),
    ]);
    expect(keys).toEqual([...collector.log.keys()]); // onEffect mirrors the key sequence

    // Replay: a backend that THROWS if ever reached. Binding the full log means it
    // never is — every effect short-circuits to its recorded value.
    const replayProject = fresh();
    const throwing = {
      complete: vi.fn(async () => {
        throw new Error("replay must not reach the backend");
      }),
    };
    replayProject.bindInfer(createInferStore(singletonRouter(throwing)));
    const replayValue = await replayProject.run(program, { effectLog: collector.log });
    expect(replayValue).toBe("seen:p1/seen:p2"); // identical result
    expect(throwing.complete).not.toHaveBeenCalled(); // ZERO external hits
  });

  it("a MISSING log entry falls through to the backend (replay is per-effect)", async () => {
    const project = fresh();
    const backend = seenBackend();
    project.bindInfer(createInferStore(singletonRouter(backend)));
    const program = `(string-append (car (infer "m" "a")) "/" (car (infer "m" "b")))`;
    // Log holds only the FIRST effect; the second has no entry → backend fires once.
    const partialLog: EffectLog = new Map([[inferEffectKey("m", "a", null, null), JSON.stringify("logged:a")]]);
    const value = await project.run(program, { effectLog: partialLog });
    expect(value).toBe("logged:a/seen:b");
    expect(backend.complete).toHaveBeenCalledTimes(1); // only the un-logged effect
  });
});

// ── 3. invocation → effect key ──────────────────────────────────────────────

describe("effectKeysByInvocation — the cone-id → effect-key bridge", () => {
  it("maps every infer invocation id to its kind-tagged key", async () => {
    const project = fresh();
    project.bindInfer(createInferStore(singletonRouter(seenBackend())));
    const trace = new EvalTrace();
    await project.run(`(string-append (car (infer "m" "p1")) (car (infer "m" "p2")))`, { trace });
    const map = effectKeysByInvocation(trace);
    const keys = new Set(map.values());
    expect(keys.has(inferEffectKey("m", "p1", null, null))).toBe(true);
    expect(keys.has(inferEffectKey("m", "p2", null, null))).toBe(true);
    // Every entry is a tagged infer key (the only effect kind in this run).
    for (const k of map.values()) expect(k.startsWith(`["infer"`)).toBe(true);
  });
});

// ── 4. Partial invalidation: subtract the forward-cone ──────────────────────

// A→B pipeline: stage-2 ("B") reads stage-1's ("A") output, so B causally
// depends on A. One react/reflect pair, no loop, so each fires once — the
// clean two-cell DAG to test cone subtraction on.
const PIPELINE = `
(define a (car (infer "m" "A")))
(define b (car (infer/chat "m"
                  (list (infer/chat/user (string-append "B<-" a)))
                  #f
                  "bkey")))
(string-append a "/" b)
`;

const pipelineBackend = () => {
  const complete = vi.fn(async (s: ModelSpec) => {
    // infer "A" → plain prompt "A"; infer/chat "B" → JSON messages containing "B<-".
    if (s.prompt === "A") return { value: "Aout" };
    if (s.prompt.includes("B<-")) return { value: "Bout" };
    throw new Error(`unexpected prompt: ${s.prompt}`);
  });
  return { complete };
};

describe("partial invalidation — re-run only the changed node's forward-cone", () => {
  it("the causal DAG is A → B (B depends on A)", async () => {
    const project = fresh();
    project.bindInfer(createInferStore(singletonRouter(pipelineBackend())));
    const trace = new EvalTrace();
    await project.run(PIPELINE, { trace });
    const chart = traceToStatechart(trace);
    expect(chart.nodes.length).toBe(2);
    // Two layers: A at 0, B at 1; one forward edge A→B.
    const a = chart.nodes.find((n) => n.layer === 0)!;
    const b = chart.nodes.find((n) => n.layer === 1)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect([...forwardCone(chart, a.id)]).toEqual([b.id]); // changing A re-fires B
    expect([...forwardCone(chart, b.id)]).toEqual([]); // B is a leaf
  });

  it("changing the UPSTREAM node invalidates BOTH effects (cone = {A, B})", async () => {
    const project = fresh();
    project.bindInfer(createInferStore(singletonRouter(pipelineBackend())));
    const trace = new EvalTrace();
    const collector = effectLogCollector();
    await project.run(PIPELINE, { trace, onEffectResult: collector.record });
    expect(collector.log.size).toBe(2);

    const chart = traceToStatechart(trace);
    const a = chart.nodes.find((n) => n.layer === 0)!;
    // Invalidate A's cell: cone = {A, B} ⇒ both keys removed from the replay log.
    const invalid = invalidatedEffectKeys(trace, chart, [a.id]);
    expect(invalid.size).toBe(2);
    const replayLog = subtractKeys(collector.log, invalid);
    expect(replayLog.size).toBe(0); // nothing left to replay — both re-run
  });

  it("changing the LEAF node replays the upstream, re-runs ONLY the leaf", async () => {
    // Original run builds the log.
    const orig = fresh();
    orig.bindInfer(createInferStore(singletonRouter(pipelineBackend())));
    const trace = new EvalTrace();
    const collector = effectLogCollector();
    const v0 = await orig.run(PIPELINE, { trace, onEffectResult: collector.record });
    expect(v0).toBe("Aout/Bout");

    const chart = traceToStatechart(trace);
    const b = chart.nodes.find((n) => n.layer === 1)!;
    // Subtract B's forward-cone (just B itself — it's a leaf): A stays in the log.
    const replayLog = invalidateForwardCone(collector.log, trace, [b.id]);
    expect(replayLog.has(inferEffectKey("m", "A", null, null))).toBe(true); // A replays
    expect(replayLog.size).toBe(1);

    // Re-run with the subtracted log + a backend that ONLY answers B and FAILS on A.
    // If A were re-run (cone wrong), the backend would throw — proving A replayed.
    const rerun = fresh();
    const bOnly = {
      complete: vi.fn(async (s: ModelSpec) => {
        if (s.prompt === "A") throw new Error("A must replay from the log, not re-run");
        if (s.prompt.includes("B<-")) return { value: "Bout2" };
        throw new Error(`unexpected: ${s.prompt}`);
      }),
    };
    rerun.bindInfer(createInferStore(singletonRouter(bOnly)));
    const v1 = await rerun.run(PIPELINE, { effectLog: replayLog });
    expect(v1).toBe("Aout/Bout2"); // A from the log, B freshly re-run
    expect(bOnly.complete).toHaveBeenCalledTimes(1); // ONLY the leaf hit the backend
    expect(bOnly.complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("B<-") }));
  });
});

// ── 5. Loop / fan-out: a cell's ALL per-fire keys invalidate together ────────

// One infer cell fired across a 3-element fan-out → ONE cell, THREE distinct
// content keys. Invalidating the cell must invalidate all three (not just the
// representative iteration).
const FANOUT = `
(map (lambda (p) (car (infer "m" (string-append "P|" p)))) (list "a" "b" "c"))
`;

describe("partial invalidation — a fan-out cell invalidates ALL its per-fire keys", () => {
  it("invalidating the cell removes every iteration's key from the replay log", async () => {
    const project = fresh();
    project.bindInfer(createInferStore(singletonRouter(seenBackend())));
    const trace = new EvalTrace();
    const collector = effectLogCollector();
    await project.run(FANOUT, { trace, onEffectResult: collector.record });
    expect(collector.log.size).toBe(3); // three distinct prompts → three keys

    const chart = traceToStatechart(trace);
    expect(chart.nodes.length).toBe(1); // ONE cell (Pair identity), count 3
    expect(chart.nodes[0]!.count).toBe(3);

    const invalid = invalidatedEffectKeys(trace, chart, [chart.nodes[0]!.id]);
    expect(invalid.size).toBe(3); // all three per-fire keys, not just the representative
    const replayLog = subtractKeys(collector.log, invalid);
    expect(replayLog.size).toBe(0);
  });
});

// ── 6. Data effects (http/sql) cross the SAME record+replay seam as infer ────

describe("data effects — record into the log + replay with zero data hits", () => {
  it("an http GET records a tagged key + replays its recorded value", async () => {
    const project = fresh();
    // Inference is unused here, but Project requires a bound store before running.
    project.bindInfer(createInferStore(singletonRouter(seenBackend())));

    const liveResolver: DataEffectResolver = vi.fn(async (_ctx, effect: DataEffect) => {
      if (effect.kind === "http") {
        const query = effect.query as Record<string, string> | undefined;
        return { status: 200, city: query?.city ?? "?" };
      }
      throw new Error(`unexpected effect: ${effect.kind}`);
    });
    const program = `(@ (http/get "weather" "/forecast" (dict :query (dict :city "berlin"))) "city")`;
    const collector = effectLogCollector();
    const keys: string[] = [];
    const value = await project.run(program, {
      data: liveResolver,
      onEffect: (k) => keys.push(k),
      onEffectResult: collector.record,
    });
    expect(value).toBe("berlin");
    expect(liveResolver).toHaveBeenCalledTimes(1);
    // The recorded key is the kind-tagged data key (http), disjoint from any infer key.
    const expectedKey = dataEffectKey({
      kind: "http",
      method: "GET",
      label: "weather",
      path: "/forecast",
      query: { city: "berlin" },
    });
    expect(keys).toEqual([expectedKey]);
    expect(collector.log.has(expectedKey)).toBe(true);

    // Replay: a resolver that THROWS if reached. The full log short-circuits it.
    const replayProject = fresh();
    replayProject.bindInfer(createInferStore(singletonRouter(seenBackend())));
    const throwingResolver: DataEffectResolver = vi.fn(async () => {
      throw new Error("replay must not reach the data resolver");
    });
    const replayValue = await replayProject.run(program, { data: throwingResolver, effectLog: collector.log });
    expect(replayValue).toBe("berlin"); // identical, from the log
    expect(throwingResolver).not.toHaveBeenCalled(); // ZERO data hits
  });

  it("a data effect becomes a forward-cone node feeding a downstream infer", async () => {
    // sql/query → infer reads the row: the infer causally depends on the sql, so
    // invalidating the sql cell invalidates BOTH (the cone reaches the infer).
    const project = fresh();
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async (s: ModelSpec) => ({ value: `ranked:${s.prompt}` }),
        }),
      ),
    );
    const sqlResolver: DataEffectResolver = async (_ctx, effect) => {
      if (effect.kind === "sql") return [{ name: "alice" }];
      throw new Error("unexpected");
    };
    const program = `
(define rows (sql/query "db" "select name from users" (list)))
(define top (@ (car rows) "name"))
(car (infer "m" (string-append "rank|" top)))
`;
    const trace = new EvalTrace();
    const collector = effectLogCollector();
    const value = await project.run(program, { data: sqlResolver, trace, onEffectResult: collector.record });
    expect(value).toBe("ranked:rank|alice");
    expect(collector.log.size).toBe(2); // one sql key + one infer key

    const chart = traceToStatechart(trace);
    expect(chart.nodes.length).toBe(2); // sql node → infer node
    const sql = chart.nodes.find((n) => n.layer === 0)!;
    const infer = chart.nodes.find((n) => n.layer === 1)!;
    expect([...forwardCone(chart, sql.id)]).toEqual([infer.id]); // sql feeds infer
    // Invalidating the sql cell invalidates both effects (cone = {sql, infer}).
    const invalid = invalidatedEffectKeys(trace, chart, [sql.id]);
    expect(invalid.size).toBe(2);
    expect(subtractKeys(collector.log, invalid).size).toBe(0);
  });
});
