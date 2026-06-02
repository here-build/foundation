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
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { snapshotTrace } from "../trace-snapshot.js";
import { traceToFlowGraph } from "../trace-to-flow-graph.js";
import { traceToFlowGraphNaive } from "../trace-to-flow-graph-naive.js";
import { traceToForest } from "../trace-to-forest.js";
import { traceToStatechart } from "../statechart.js";
import { EvalTrace } from "../trace.js";
import { startOrchestrator } from "../worker.js";

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
  const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
  project.bindCache(cache);
  const ac = new AbortController();
  const draining = startOrchestrator({ cache, router: singletonRouter(stub), signal: ac.signal }).done;
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
  ac.abort();
  await draining;
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
  return `  ${label.padEnd(30)} mean ${mean.toFixed(1).padStart(9)} ms    min ${Math.min(...samples).toFixed(1).padStart(9)} ms`;
}

describe("flow-graph build — benchmark", () => {
  // Scale here to stress the O(n) / O(n²) terms. Trace-build (setup) grows too.
  const SIZES: Array<[rounds: number, personas: number]> = [
    [12, 6],
    [40, 16],
  ];

  for (const [rounds, personas] of SIZES) {
    test(`rounds=${rounds} personas=${personas}`, async () => {
      const trace = await buildBenchTrace(rounds, personas);
      const snap = snapshotTrace(trace);
      const infers = snap.invocations.filter((i) => i.isProvenancePoint).length;

      console.log(
        [
          `\n=== trace: rounds=${rounds} personas=${personas} → ${snap.invocations.length} invocations, ${infers} infer points ===`,
          time("snapshotTrace", () => snapshotTrace(trace)),
          time("traceToForest", () => traceToForest(trace)),
          time("traceToStatechart", () => traceToStatechart(trace)),
          time("traceToFlowGraph (MDL)", () => traceToFlowGraph(trace)),
          time("traceToFlowGraphNaive", () => traceToFlowGraphNaive(trace)),
        ].join("\n"),
      );

      // Sanity: a broken build fails loud rather than silently benchmarking nothing.
      expect(traceToFlowGraph(trace).nodes.length).toBeGreaterThan(0);
      expect(traceToFlowGraphNaive(trace).nodes.length).toBeGreaterThan(0);
    }, 120_000);
  }
});
