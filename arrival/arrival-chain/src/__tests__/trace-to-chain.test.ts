/**
 * traceToChain — the UNGROUPED provenance chain (one node per infer CALL), the
 * from-scratch minimal model behind the trace's plain chain view. Contrasted
 * against the scope-collapsed statechart on the same gepa trace: same flow, more
 * nodes (every call, not ×N-collapsed).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { traceToStatechart } from "../statechart.js";
import { traceToChain } from "../trace-to-chain.js";
import { EvalTrace } from "../trace.js";

const PROGRAM = `
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

async function gepaTrace(): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(
    createInferStore(
      singletonRouter({
        complete: async (spec: ModelSpec) => {
          const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
          const user = parsed.find((m) => m.role === "user")?.content ?? "";
          if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
          const [, current] = user.split("|");
          return { value: { next: current === "t0" ? "t1" : "t2" } };
        },
      }),
    ),
  );
  const trace = new EvalTrace();
  await project.run(PROGRAM, { trace });
  return trace;
}

describe("traceToChain — ungrouped provenance chain", () => {
  it("emits one node per provenance-point CALL (ungrouped), strictly more than the collapsed statechart", async () => {
    const trace = await gepaTrace();
    const chain = traceToChain(trace);
    const grouped = traceToStatechart(trace);

    // The gepa loop runs react ×(2 personas · iters) + reflect ×iters — ungrouped,
    // each is its own node, so strictly more than the scope-collapsed statechart.
    expect(chain.nodes.length).toBeGreaterThan(grouped.nodes.length);
    expect(chain.nodes.length).toBeGreaterThanOrEqual(6); // ≥ the react fan-out across iters
  });

  it("wires upstream→consumer edges, layered and acyclic (no loopback)", async () => {
    const chain = traceToChain(await gepaTrace());

    expect(chain.edges.length).toBeGreaterThan(0);
    // react → reflect within an iter, reflect → next-iter react across — a deepening
    // chain, not the grouped 2-cycle, so more than 2 layers.
    expect(chain.layerCount).toBeGreaterThan(2);
    // Ungrouped, provenance flows producer→consumer with producer minted first, so
    // every edge runs low id → high id: a pure DAG, no back-edges to classify.
    for (const e of chain.edges) expect(e.from).toBeLessThan(e.to);
  });
});
