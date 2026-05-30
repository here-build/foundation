/**
 * trace → unified flow-graph, against the REAL gepa trace. This is the
 * correlation layer: forest regions (containment) + statechart layers/edges
 * (causality) merged into one id space. The tests pin the things that would
 * silently break the renderer — a dropped bridge, a mis-parented leaf, an edge
 * that points at a non-existent node, an inverted cone.
 *
 * (Harness replicated from trace-to-forest.test.ts / statechart.test.ts; a
 * shared `_gepa-trace.ts` helper would DRY all three — left for a focused
 * follow-up so this commit stays scoped to the new builder.)
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { traceToStatechart } from "../statechart.js";
import {
  flowBackwardCone,
  flowForwardCone,
  traceToFlowGraph,
  type FlowGraph,
  type FlowGraphNode,
} from "../trace-to-flow-graph.js";
import { EvalTrace } from "../trace.js";
import { startOrchestrator } from "../worker.js";

const PROGRAM = `
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         (s/object (s/field/string "verdict"))
         (string-append "react/" tagline "/" persona-id))))
(define (next-tagline current reactions)
  (field (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|"
                                                      (field (car reactions) "verdict"))))
                (s/object (s/field/string "next"))
                (string-append "reflect/" current)))
         "next"))
(define (loop tagline iter max-iter)
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list "p1" "p2"))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 2)
`;

async function gepaTrace(): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
  project.bindCache(cache);
  const ac = new AbortController();
  const draining = startOrchestrator({
    cache,
    router: singletonRouter({
      complete: async (spec: ModelSpec) => {
        const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
        const user = parsed.find((m) => m.role === "user")?.content ?? "";
        if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
        const [, current] = user.split("|");
        return { value: { next: current === "t0" ? "t1" : "t2" } };
      },
    }),
    signal: ac.signal,
  }).done;
  const trace = new EvalTrace();
  await project.run(PROGRAM, { trace });
  ac.abort();
  await draining;
  return trace;
}

const byId = (g: FlowGraph) => new Map(g.nodes.map((n) => [n.id, n]));
const inferLeaves = (g: FlowGraph): FlowGraphNode[] => g.nodes.filter((n) => n.id.startsWith("infer/chat@"));

describe("traceToFlowGraph — unified model over the real gepa trace", () => {
  it("bridges every causal chart node to exactly one flow node (no collisions)", async () => {
    const trace = await gepaTrace();
    const chart = traceToStatechart(trace);
    const graph = traceToFlowGraph(trace);

    // The bridge is a bijection on provenance-point Pairs: one flow node carries
    // a layer per chart node, and no scope-id collided.
    expect(graph.warnings).toEqual([]);
    const layered = graph.nodes.filter((n) => n.layer !== null);
    expect(layered).toHaveLength(chart.nodes.length);
    expect(chart.nodes.length).toBeGreaterThan(0);
  });

  it("nests the react fan-out leaf under the map region with ×2 multiplicity", async () => {
    const graph = traceToFlowGraph(await gepaTrace());
    const nodes = byId(graph);

    const map = graph.nodes.find((n) => n.id.startsWith("map@"));
    expect(map).toBeDefined();
    expect(map!.boxType).toBe("unfold");

    const react = inferLeaves(graph).find((n) => n.parentId === map!.id);
    expect(react).toBeDefined();
    expect(react!.kind).toBe("leaf");
    expect(react!.count).toBe(2); // two personas — the load-bearing fan-out

    // Every parentId resolves to a real node (no dangling containment).
    for (const n of graph.nodes) if (n.parentId !== null) expect(nodes.has(n.parentId)).toBe(true);
  });

  it("carries causal edges (react→reflect forward, plus a loopback) in scope-id space", async () => {
    const graph = traceToFlowGraph(await gepaTrace());
    const nodes = byId(graph);

    const map = graph.nodes.find((n) => n.id.startsWith("map@"))!;
    const react = inferLeaves(graph).find((n) => n.parentId === map.id)!;
    const reflect = inferLeaves(graph).find((n) => n.id !== react.id)!;

    // react is upstream of reflect → a forward edge between their scopes.
    expect(graph.edges).toContainEqual({ from: react.id, to: reflect.id, kind: "forward" });
    // The tail-recursion shows up as at least one loopback (reflect seeds the
    // next iteration's react, collapsed onto the same cells).
    expect(graph.edges.some((e) => e.kind === "loopback")).toBe(true);

    // No edge points at a node that isn't in the graph.
    for (const e of graph.edges) {
      expect(nodes.has(e.from)).toBe(true);
      expect(nodes.has(e.to)).toBe(true);
    }
  });

  it("surfaces the optimizer's fold decisions and a valid bit-budget", async () => {
    const graph = traceToFlowGraph(await gepaTrace());
    const map = graph.nodes.find((n) => n.id.startsWith("map@"))!;
    const react = inferLeaves(graph).find((n) => n.parentId === map.id)!;

    // The ×2 react fan-out folds by default (matches the forest end-to-end test).
    expect(react.collapsedByDefault).toBe(true);
    // Compression anchor holds.
    expect(graph.totalBits).toBeLessThanOrEqual(graph.rawBits);
  });

  it("promotes a user define to a forced, pre-folded region", async () => {
    const graph = traceToFlowGraph(await gepaTrace(), { promoted: new Map([["react-cell", "forced"]]) });
    const reactCell = graph.nodes.filter((n) => n.id.startsWith("react-cell@"));
    expect(reactCell).toHaveLength(1);
    expect(reactCell[0]!.forced).toBe(true);
    expect(reactCell[0]!.collapsedByDefault).toBe(true);
  });

  it("computes why/blast cones in the flow-graph id space", async () => {
    const graph = traceToFlowGraph(await gepaTrace());
    const map = graph.nodes.find((n) => n.id.startsWith("map@"))!;
    const react = inferLeaves(graph).find((n) => n.parentId === map.id)!;
    const reflect = inferLeaves(graph).find((n) => n.id !== react.id)!;

    // Blast radius of react reaches reflect; the why of reflect reaches react.
    expect(flowForwardCone(graph, react.id).has(reflect.id)).toBe(true);
    expect(flowBackwardCone(graph, reflect.id).has(react.id)).toBe(true);
    // Self never appears in its own cone.
    expect(flowForwardCone(graph, react.id).has(react.id)).toBe(false);
  });
});
