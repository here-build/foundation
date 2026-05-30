/**
 * trace → statechart extraction, proven against a REAL gepa-loop trace.
 *
 * The point of this test is epistemic: `statechart.ts`'s edge rule
 * (`⋃ child.provenance` recovers an infer's upstream infers) is a CLAIM about
 * how §5 provenance propagates through nested arg sub-expressions and across a
 * tail-recursive loop. Rather than trust the reasoning, we run the actual
 * gepa-until-plateau program with a trace attached and assert the DAG shape:
 *   - react and reflect collapse to ONE cell each (Pair identity), counts = #fires
 *   - react sits at layer 0, reflect at layer 1 (within-iteration flow)
 *   - react→reflect is `forward`; reflect→react is the `loopback` (↺)
 * If the propagation model were wrong, the cross-infer edges wouldn't form.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { EvalTrace } from "../trace.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";
import { backwardCone, forwardCone, traceToStatechart, type Statechart } from "../statechart.js";

// Trimmed gepa harness — react fans out over personas, reflect proposes the
// next tagline, loop is a tail call. (Same shape as gepa-loop.test.ts; kept
// self-contained so a change to that file's preamble can't silently shift this
// structural assertion.)
const PROGRAM = `
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         (s/object (s/field/string "verdict"))
         (string-append "react/" tagline "/" persona-id))))

;; next-tagline consumes a reaction's value (field of the first react result),
;; so reflect causally depends on react — that's the forward edge under test.
(define (next-tagline current reactions)
  (field (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|"
                                                      (field (car reactions) "verdict"))))
                (s/object (s/field/string "next"))
                (string-append "reflect/" current)))
         "next"))

(define (loop tagline iter max-iter)
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list "p1"))))
    (if (>= iter max-iter)
        tagline
        (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))

(loop "t0" 0 2)
`;

function stubBackend() {
  const complete = async (spec: ModelSpec) => {
    const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = parsed.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
    if (user.startsWith("REFLECT|")) {
      const [, current] = user.split("|");
      return { value: { next: current === "t0" ? "t1" : "t2" } };
    }
    throw new Error(`unexpected: ${user}`);
  };
  return { complete };
}

describe("traceToStatechart — gepa-loop causal DAG", () => {
  it("collapses react/reflect to one cell each, with forward + loopback edges", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);

    const ac = new AbortController();
    const draining = startOrchestrator({
      cache,
      router: singletonRouter(stubBackend()),
      signal: ac.signal,
    }).done;

    const trace = new EvalTrace();
    await project.run(PROGRAM, { trace });
    ac.abort();
    await draining;

    const chart = traceToStatechart(trace);

    // Two distinct infer Pairs (react-cell's, next-tagline's) → two cells.
    expect(chart.nodes).toHaveLength(2);

    const byLayer = (l: number) => chart.nodes.filter((n) => n.layer === l);
    const react = byLayer(0)[0];
    const reflect = byLayer(1)[0];
    expect(react).toBeDefined();
    expect(reflect).toBeDefined();

    // react fires at iter 0,1,2 (1 persona) → 3; reflect fires at iter 0,1 → 2.
    expect(react!.count).toBe(3);
    expect(reflect!.count).toBe(2);
    expect(chart.layerCount).toBe(2);

    // The structural payoff: react→reflect (within-iteration) is forward;
    // reflect→react (iter k seeds iter k+1) collapses to the loop-back edge.
    const fwd = chart.edges.find((e) => e.from === react!.id && e.to === reflect!.id);
    const back = chart.edges.find((e) => e.from === reflect!.id && e.to === react!.id);
    expect(fwd?.kind).toBe("forward");
    expect(back?.kind).toBe("loopback");
  });
});

describe("forwardCone / backwardCone — why & blast reachability", () => {
  // a → b → c (forward edges), plus a stray d with no edges.
  const linear: Statechart = {
    nodes: [
      { id: 0, count: 1, layer: 0, label: "a" },
      { id: 1, count: 1, layer: 1, label: "b" },
      { id: 2, count: 1, layer: 2, label: "c" },
      { id: 9, count: 1, layer: 0, label: "d" },
    ],
    edges: [
      { from: 0, to: 1, kind: "forward" },
      { from: 1, to: 2, kind: "forward" },
    ],
    layerCount: 3,
  };

  it("blast radius is the transitive downstream set, excluding self", () => {
    expect([...forwardCone(linear, 0)].sort()).toEqual([1, 2]);
    expect([...forwardCone(linear, 2)]).toEqual([]); // leaf — nothing re-fires
    expect([...forwardCone(linear, 9)]).toEqual([]); // isolated
  });

  it("causal why is the transitive upstream set, excluding self", () => {
    expect([...backwardCone(linear, 2)].sort()).toEqual([0, 1]);
    expect([...backwardCone(linear, 0)]).toEqual([]); // source — nothing caused it
  });

  it("a loop-back cycle entangles both nodes in each direction (terminates, no self)", () => {
    // react ⇄ reflect: forward react→reflect, loopback reflect→react.
    const loop: Statechart = {
      nodes: [
        { id: 0, count: 3, layer: 0, label: "react" },
        { id: 1, count: 2, layer: 1, label: "reflect" },
      ],
      edges: [
        { from: 0, to: 1, kind: "forward" },
        { from: 1, to: 0, kind: "loopback" },
      ],
      layerCount: 2,
    };
    // Each reaches the OTHER (and would reach self via the cycle, but self is
    // excluded) — the honest "tight loop is mutually entangled" answer.
    expect([...forwardCone(loop, 0)]).toEqual([1]);
    expect([...backwardCone(loop, 0)]).toEqual([1]);
    expect([...forwardCone(loop, 1)]).toEqual([0]);
    expect([...backwardCone(loop, 1)]).toEqual([0]);
  });
});
