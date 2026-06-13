/**
 * Headless benchmark for the flow-graph build — the "render compute" the UI's
 * TraceGraph runs via traceToFlowGraph. It builds a DETERMINISTIC trace with a
 * stub router (reproducible, no LM Studio), then times each build stage, so we
 * can SEE the impact of every optimization instead of reading it off a live
 * profile. Run: `npm run benchmarks` (opt-in; excluded from the default suite).
 *
 * Scope: this measures the pure compute (snapshot → statechart → forest →
 * bridge). It does NOT measure the React render (beginWork) or the observer's
 * dependency-tracking — those are UI-coupled. Numbers here track algorithmic
 * progress on the build itself; for the full render cost, profile the studio.
 */
import { describe, expect, test } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { TraceRegionFold } from "@here.build/arrival-provenance";
import { snapshotTrace } from "@here.build/arrival-provenance";
import { traceToFlowGraph } from "@here.build/arrival-provenance";
import { traceToFlowGraphNaive } from "@here.build/arrival-provenance";
import { traceToForest } from "@here.build/arrival-provenance";
import { traceToRegions } from "@here.build/arrival-provenance";
import { traceToStatechart } from "@here.build/arrival-provenance";
import { EvalTrace } from "@here.build/arrival-provenance";

/** Deterministic stub: react → {verdict}, reflect → {next}. The tagline grows by
 *  one char per round, so every round mints distinct infers (no cache collisions
 *  collapsing the trace). */
const stub = {
  complete: async (spec: ModelSpec) => {
    const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
    const current = user.split("|")[1] ?? "";
    return { value: { next: `${current}x` } };
  },
};

/** A GEPA-shaped trace: `rounds` tail-recursive iterations, each fanning out
 *  `personas` react infers + one reflect that reads them. ≈ rounds·personas +
 *  rounds infer points, plus the full plumbing tree the build must filter. */
async function buildBenchTrace(rounds: number, personas: number): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter(stub)));
  const trace = new EvalTrace();
  const personaList = Array.from({ length: personas }, (_, i) => `"p${i}"`).join(" ");
  await project.run(
    `
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         (s/object (s/field/string "verdict"))
         (string-append "react/" tagline "/" persona-id))))
(define (next-tagline current reactions)
  (:next (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|"
                                                      (:verdict (car reactions)))))
                (s/object (s/field/string "next"))
                (string-append "reflect/" current)))))
(define (loop tagline iter max-iter)
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list ${personaList}))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 ${rounds})
`,
    { trace },
  );
  return trace;
}

function time(label: string, fn: () => void, runs = 7): string {
  fn(); // warmup (JIT + first-run allocation)
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / runs;
  return `  ${label.padEnd(30)} mean ${mean.toFixed(1).padStart(9)} ms    min ${Math.min(...samples)
    .toFixed(1)
    .padStart(9)} ms`;
}

/** Nodes that would be VISIBLE under a collapse predicate — i.e. NOT inside any
 *  collapsed region (collapse UNMOUNTS descendants). This is the metric that
 *  drives elk-layout + canvas cost (both melt past ~200 nodes) — separate from the
 *  build time above. Because the forest groups by AST scope (a map run 10k times
 *  is ONE node, n=10000), the totals are tiny regardless of iteration count;
 *  collapsing a region hides its BODY SUBTREE, not the repeated runs. */
type CountNode = { id: string; parentId: string | null; boxType: string; collapsedByDefault: boolean };
function visibleUnder(nodes: CountNode[], collapsed: (n: CountNode) => boolean): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hidden = (n: CountNode): boolean => {
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    while (p) {
      if (collapsed(p)) return true;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return false;
  };
  return nodes.filter((n) => !hidden(n)).length;
}

/** Count materialized Region objects in a RegionGraph. `top` = root regions;
 *  `deep` = every region INCLUDING per-pass fanout iterations. The decision rests
 *  on `deep` vs invocation count: deep ≈ distinct scopes ⇒ the regions build
 *  collapses repetition like the forest path (append-only template, cheap); deep ≈
 *  invocations ⇒ `iterations: Region[][]` over-materializes a subtree per pass (the
 *  read-fan's hypothesis — the real fix is template-collapse, not a worker). */
type AnyRegion = { kind: string; iterations?: AnyRegion[][] };
function countRegions(graph: { roots: AnyRegion[] }): { top: number; deep: number } {
  let deep = 0;
  const walk = (regions: AnyRegion[]): void => {
    for (const r of regions) {
      deep++;
      if (r.kind === "fanout" && Array.isArray(r.iterations)) for (const pass of r.iterations) walk(pass);
    }
  };
  walk(graph.roots);
  return { top: graph.roots.length, deep };
}

/** The whole point of `TraceRegionFold`: per-tick cost is the incremental Δ, not the
 *  O(N) full rebuild `traceToRegions` pays each frame. We measure the GENUINE streaming
 *  path — a barrier-gated router parks every infer; we pulse it (releasing the currently
 *  parked wave), then applyDelta() (and, periodically, current()) on a fold reading the
 *  LIVE trace, timing each. The MAX per-tick current() on the 500k row must be
 *  MILLISECONDS (the whole point); the one-shot traceToRegions is seconds. */
async function measureStreamingFold(rounds: number, personas: number): Promise<string> {
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  let waiting!: () => void;
  let nextWaiter = new Promise<void>((r) => (waiting = r));

  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(
    createInferStore(
      singletonRouter({
        complete: async (spec: ModelSpec) => {
          const signal = waiting;
          nextWaiter = new Promise<void>((r) => (waiting = r));
          signal();
          await gate;
          const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
          const user = msgs.find((m) => m.role === "user")?.content ?? "";
          if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
          const current = user.split("|")[1] ?? "";
          return { value: { next: `${current}x` } };
        },
      }),
    ),
  );
  const personaList = Array.from({ length: personas }, (_, i) => `"p${i}"`).join(" ");
  const trace = new EvalTrace();
  const done = project.run(
    `
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         (s/object (s/field/string "verdict"))
         (string-append "react/" tagline "/" persona-id))))
(define (next-tagline current reactions)
  (:next (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|"
                                                      (:verdict (car reactions)))))
                (s/object (s/field/string "next"))
                (string-append "reflect/" current)))))
(define (loop tagline iter max-iter)
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list ${personaList}))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 ${rounds})
`,
    { trace },
  );

  const fold = new TraceRegionFold(trace);
  let pulses = 0;
  let currents = 0;
  let totalDelta = 0;
  let maxApply = 0;
  let maxCurrent = 0;
  let lastCurrent = 0;
  // Pulse until the run settles. Each pulse: applyDelta() (timed — the per-tick absorb),
  // then release the parked wave. current() emits the WHOLE graph (O(total regions) per
  // call), so to keep the simulation bounded at scale we time current() only every
  // `sampleEvery` pulses + always at the very end (full-trace worst case = the headline).
  const sampleEvery = Math.max(1, Math.floor(rounds / 24));
  for (let guard = 0; guard < rounds * (personas + 4) + 16; guard++) {
    const parked = await Promise.race([nextWaiter.then(() => true), done.then(() => false)]);
    const a0 = performance.now();
    const delta = fold.applyDelta();
    maxApply = Math.max(maxApply, performance.now() - a0);
    totalDelta += delta;
    pulses += 1;
    if (!parked || pulses % sampleEvery === 0) {
      const c0 = performance.now();
      fold.current();
      lastCurrent = performance.now() - c0;
      maxCurrent = Math.max(maxCurrent, lastCurrent);
      currents += 1;
    }
    if (!parked) break;
    const open = release;
    gate = new Promise<void>((r) => (release = r));
    open();
    await Promise.resolve();
  }
  await done;
  // Final current() on the fully-settled trace (the worst-case per-tick render cost).
  fold.applyDelta();
  {
    const c0 = performance.now();
    fold.current();
    lastCurrent = performance.now() - c0;
    maxCurrent = Math.max(maxCurrent, lastCurrent);
    currents += 1;
  }

  return [
    `  --- streaming fold (per-tick incremental — the win) ---`,
    `  pulses / current() samples         ${pulses} / ${currents}`,
    `  sum delta invocations absorbed     ${totalDelta}`,
    `  MAX applyDelta() per pulse         ${maxApply.toFixed(2)} ms   (O(Δ) index-slice; residual = Hasse reach extension per new point)`,
    `  MAX current() per tick             ${maxCurrent.toFixed(2)} ms   <- must be ms, not s`,
    `  last current() (full trace)        ${lastCurrent.toFixed(2)} ms`,
  ].join("\n");
}

describe("flow-graph build — benchmark", () => {
  // Scale here to stress the O(n) / O(n²) terms. Trace-build (setup) grows too.
  const SIZES: Array<[rounds: number, personas: number]> = [
    [12, 6],
    [40, 16],
    [80, 24],
    [1000, 24], // ~500k invocations — the real host test-pipeline ceiling (V)
  ];

  for (const [rounds, personas] of SIZES) {
    test(`rounds=${rounds} personas=${personas}`, async () => {
      const trace = await buildBenchTrace(rounds, personas);
      const snap = snapshotTrace(trace);
      const infers = snap.invocations.filter((i) => i.isProvenancePoint).length;

      const mdl = traceToFlowGraph(trace);
      const naive = traceToFlowGraphNaive(trace);
      const regionCounts = countRegions(traceToRegions(trace));
      const repeating = (n: CountNode) => n.boxType === "loop" || n.boxType === "unfold";

      // The per-tick streaming measurement (re-builds its own gated trace of the same
      // shape) — the whole point of the fold.
      const streamingReport = await measureStreamingFold(rounds, personas);

      console.log(
        [
          `\n=== trace: rounds=${rounds} personas=${personas} → ${snap.invocations.length} invocations, ${infers} infer points ===`,
          // Fewer samples for the heavy builds at 500k (each call is seconds).
          time("snapshotTrace", () => snapshotTrace(trace), rounds >= 1000 ? 3 : 7),
          time("traceToForest", () => traceToForest(trace), rounds >= 1000 ? 2 : 7),
          time("traceToStatechart", () => traceToStatechart(trace), rounds >= 1000 ? 2 : 7),
          time("traceToFlowGraph (MDL)", () => traceToFlowGraph(trace), rounds >= 1000 ? 2 : 7),
          time("traceToFlowGraphNaive", () => traceToFlowGraphNaive(trace), rounds >= 1000 ? 2 : 7),
          time("traceToRegions (from-scratch)", () => traceToRegions(trace), rounds >= 1000 ? 2 : 7),
          time("TraceRegionFold.fromTrace (one-shot)", () => TraceRegionFold.fromTrace(trace), rounds >= 1000 ? 2 : 7),
          streamingReport,
          // The regions-path collapse metric (the A2 decision): deep ≈ distinct
          // scopes ⇒ collapses (cheap, no worker); deep ≈ invocations ⇒ per-pass
          // over-materialization (template-collapse is the real fix).
          `  --- regions build (use-region-graph / RegionView path) ---`,
          `  region nodes · top-level           ${regionCounts.top}`,
          `  region nodes · deep (w/ iterations) ${regionCounts.deep}`,
          `  collapse ratio invocations:deep    ${(snap.invocations.length / Math.max(1, regionCounts.deep)).toFixed(1)}:1`,
          // The render-cost metric: VISIBLE nodes (elk + canvas melt past ~200).
          // Totals are tiny because the forest groups by AST scope — the iteration
          // count never inflates node count; collapsing hides a region's body.
          `  --- nodes (grouped by AST scope, NOT per run) ---`,
          `  total nodes (MDL build)            ${mdl.nodes.length}`,
          `  repeating regions (loop+unfold)    ${mdl.nodes.filter(repeating).length}`,
          `  visible · MDL bit-budget fold      ${visibleUnder(mdl.nodes, (n) => n.collapsedByDefault)}`,
          `  visible · ONLY loop+unfold folded  ${visibleUnder(mdl.nodes, repeating)}`,
          `  visible · ALL expanded (no fold)   ${mdl.nodes.length}`,
        ].join("\n"),
      );

      // Sanity: a broken build fails loud rather than silently benchmarking nothing.
      expect(traceToFlowGraph(trace).nodes.length).toBeGreaterThan(0);
      expect(traceToFlowGraphNaive(trace).nodes.length).toBeGreaterThan(0);
      expect(regionCounts.deep).toBeGreaterThan(0);
    }, 600_000);
  }
});
