/**
 * The NAIVE flow-graph builder verifies it: (a) skips the MDL compressor (no
 * folding to a bit-budget — totalBits === rawBits), (b) marks fan-outs/loops as
 * iteration series (collapsedByDefault by structure), (c) merges stacked
 * containers (a `filter` nested in a `map` → one "map ▸ filter" node), and
 * (d) wires provenance edges. Contrasted against the optimized builder on the
 * same traces. Reuses the trace-building harness from trace-to-forest.test.ts.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "../trace.js";
import { traceToFlowGraph } from "../trace-to-flow-graph.js";
import { traceToFlowGraphNaive } from "../trace-to-flow-graph-naive.js";

async function traceOf(
  program: string,
  complete: (spec: ModelSpec) => Promise<{ value: unknown }>,
): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete })));
  const trace = new EvalTrace();
  await project.run(program, { trace });
  return trace;
}

const userOf = (spec: ModelSpec): string => {
  const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
  return msgs.find((m) => m.role === "user")?.content ?? "";
};

// A gepa-shaped trace: a tail-recursive loop, a ×2 map fan-out, two infer points,
// react → reflect dataflow (verbatim from trace-to-forest.test.ts).
const LOOP_PROGRAM = `
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
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list "p1" "p2"))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 2)
`;
const loopStub = async (spec: ModelSpec) => {
  const user = userOf(spec);
  if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
  const current = user.split("|")[1] ?? "";
  return { value: { next: current === "t0" ? "t1" : "t2" } };
};

// A stacked-container trace: a map whose sole body is a filter (filter inside map).
const STACK_PROGRAM = `
(define (judge x)
  (:ok (car (infer/chat "fast"
              (list (infer/chat/user (string-append "J|" x)))
              (s/object (s/field/string "ok"))
              (string-append "j/" x)))))
(map (lambda (grp) (filter (lambda (x) (equal? (judge x) "yes")) grp))
     (list (list "a" "b") (list "c" "d")))
`;
const stackStub = async (_spec: ModelSpec) => ({ value: { ok: "yes" } });

describe("traceToFlowGraphNaive", () => {
  it("skips MDL and marks fan-outs/loops as iteration series", async () => {
    const naive = traceToFlowGraphNaive(await traceOf(LOOP_PROGRAM, loopStub));

    // No compression: the chosen description IS the raw one.
    expect(naive.totalBits).toBe(naive.rawBits);

    // Every unfold (map) / loop box is an iteration series, by STRUCTURE — not a
    // bit-budget verdict the way the MDL builder decides.
    const iters = naive.nodes.filter((n) => n.boxType === "unfold" || n.boxType === "loop");
    expect(iters.length).toBeGreaterThan(0);
    expect(iters.every((n) => n.collapsedByDefault)).toBe(true);
    expect(naive.nodes.some((n) => n.boxType === "loop")).toBe(true);
    expect(naive.nodes.some((n) => n.label === "map")).toBe(true);

    // The map region carries its boundary: entrance (loop-back reflect) + exit (react).
    const mapNode = naive.nodes.find((n) => n.label === "map");
    expect(mapNode?.entrance?.length ?? 0).toBeGreaterThan(0);
    expect(mapNode?.exit?.length ?? 0).toBeGreaterThan(0);

    // Provenance wired: the two infer points produce causal edges.
    expect(naive.edges.length).toBeGreaterThan(0);
  });

  it("merges stacked containers: a filter inside a map becomes one node", async () => {
    const trace = await traceOf(STACK_PROGRAM, stackStub);
    const naive = traceToFlowGraphNaive(trace);
    const opt = traceToFlowGraph(trace);

    // Naive collapses the map ⊃ filter chain into one labelled node.
    const merged = naive.nodes.find((n) => n.label.includes("▸"));
    expect(merged).toBeDefined();
    expect(merged!.label).toContain("map");
    expect(merged!.label).toContain("filter");
    // The inner container no longer stands alone.
    expect(naive.nodes.some((n) => n.label === "filter")).toBe(false);

    // The optimized builder does NOT merge — map and filter stay separate nodes.
    expect(opt.nodes.some((n) => n.label === "map")).toBe(true);
    expect(opt.nodes.some((n) => n.label === "filter")).toBe(true);
  });
});
