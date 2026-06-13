/**
 * trace → candidate-box forest, against a REAL gepa trace. Asserts the core
 * meaningful structure (loop ⊃ {map ⊃ react-infer, reflect-infer}) with correct
 * types and measured-occurrence multiplicities, tolerating extra macro-internal
 * boxes (a known v1 limitation — accessor macros like `field`/`@` expand to a
 * `cond` the classifier currently sees; topology of the core is exact).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import { collapseMDL, type CandidateBox } from "@here.build/arrival-provenance";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { traceToForest, type ForestOptions } from "@here.build/arrival-provenance";
import { EvalTrace } from "@here.build/arrival-provenance";

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

/** Flatten the forest; find boxes by id-head prefix. */
function flatten(forest: CandidateBox[]): CandidateBox[] {
  const out: CandidateBox[] = [];
  const walk = (b: CandidateBox) => {
    out.push(b);
    b.children.forEach(walk);
  };
  forest.forEach(walk);
  return out;
}
const byHead = (boxes: CandidateBox[], head: string) => boxes.filter((b) => b.id.startsWith(`${head}@`) || b.id === head);

describe("traceToForest — real gepa trace", () => {
  it("extracts the correct box TYPES and fan-out multiplicities", async () => {
    const forest = traceToForest(await gepaTrace());
    const all = flatten(forest);

    // Exactly one loop box (the recursive `loop` application), correctly NOT
    // over-firing on the body's re-entered let/if (STRUCTURAL_FORMS excluded).
    const loops = all.filter((b) => b.type === "loop");
    expect(loops).toHaveLength(1);

    // The map is an unfold; its react-inference child is a leaf fanning out ×2
    // (the two personas) — the load-bearing multiplicity, measured exactly.
    const map = byHead(all, "map")[0]!;
    expect(map.type).toBe("unfold");
    const reactInfer = map.children.find((b) => b.type === "leaf");
    expect(reactInfer).toBeDefined();
    expect(reactInfer!.n).toBeCloseTo(2, 5);

    // The reflect inference is a leaf (provenance point), distinct Pair from react.
    const leaves = all.filter((b) => b.type === "leaf" && b.id.startsWith("infer/chat@"));
    expect(leaves.length).toBeGreaterThanOrEqual(2); // react + reflect, distinct locations
  });

  it("nests a tail-recursive loop's body under the loop box, ×K iterations", async () => {
    // FIXED (was the v1 gap): the loop box is the recursive function's BODY scope,
    // entered K=3× (every iteration, including the first top-level call) — so it
    // counts ITERATIONS not back-edges, and the per-iteration work nests under it.
    const forest = traceToForest(await gepaTrace());
    const loop = forest.find((b) => b.type === "loop");
    expect(loop).toBeDefined();
    expect(loop!.n).toBeCloseTo(3, 5); // iterations, not 2 back-edges

    // The map is no longer orphaned at root — it nests directly under the loop,
    // and its react fan-out (×2 personas) under the map.
    expect(forest.some((b) => b.id.startsWith("map@"))).toBe(false);
    const all = flatten(forest);
    const map = byHead(all, "map")[0]!;
    expect(map.type).toBe("unfold");
    expect(loop!.children.includes(map)).toBe(true);
    expect(map.children.find((b) => b.type === "leaf")!.n).toBeCloseTo(2, 5);
  });

  it("feeds the optimizer end-to-end: the loop and the react fan-out collapse", async () => {
    const forest = traceToForest(await gepaTrace());
    const { decisions } = collapseMDL(forest);
    const all = flatten(forest);
    const loop = all.find((b) => b.type === "loop")!;
    const map = byHead(all, "map")[0]!;
    const reactInfer = map.children.find((b) => b.type === "leaf")!;
    expect(decisions.get(loop.id)).toBe("collapsed");
    expect(decisions.get(reactInfer.id)).toBe("collapsed");
  });

  it('promotes a user define to a FORCED box (the panel hook)', async () => {
    const opts: ForestOptions = { promoted: new Map([["react-cell", "forced"]]) };
    const forest = traceToForest(await gepaTrace(), opts);
    const all = flatten(forest);
    const reactCell = byHead(all, "react-cell");
    expect(reactCell).toHaveLength(1);
    expect(reactCell[0]!.force).toBe("collapsed");
    // It now sits between the map and the react inference (children re-parent to it).
    expect(reactCell[0]!.children.some((b) => b.type === "leaf")).toBe(true);
    // And the optimizer honors the force.
    expect(collapseMDL(forest).decisions.get(reactCell[0]!.id)).toBe("collapsed");
  });

  it("is transparent to user defines by default (scheme A — no react-cell box)", async () => {
    const forest = traceToForest(await gepaTrace());
    expect(byHead(flatten(forest), "react-cell")).toHaveLength(0);
  });
});

describe("TCO detection — tailPosition flows from the evaluator to the trace", () => {
  it("marks the recursive loop call as a tail call; non-tail work as not", async () => {
    const trace = await gepaTrace();
    const all = [...trace.records.values()].flatMap((r) => [...r.bindings]);
    const headOf = (i: { node: unknown }) =>
      ((i.node as { car?: { __name__?: unknown } })?.car?.__name__ as string | undefined) ?? "?";

    // The recursive `(loop …)` call (head "loop" with a same-Pair ancestor) is
    // in tail position → a tail call. Detected from the evaluator's own flag,
    // not inferred from the (flattened) trace shape.
    const recursiveLoopCalls = all.filter((i) => {
      if (headOf(i) !== "loop") return false;
      for (let p = i.parent; p; p = p.parent) if (p.node === i.node) return true;
      return false;
    });
    expect(recursiveLoopCalls.length).toBeGreaterThan(0);
    expect(recursiveLoopCalls.every((i) => i.tailPosition)).toBe(true);

    // The map (a let-binding RHS) and the inferences (arguments to `car`) are
    // NOT in tail position — so we can tell a tail loop from stack-growing work.
    const maps = all.filter((i) => headOf(i) === "map");
    expect(maps.length).toBeGreaterThan(0);
    expect(maps.every((i) => !i.tailPosition)).toBe(true);
    expect(all.filter((i) => i.isProvenancePoint).every((i) => !i.tailPosition)).toBe(true);
  });
});
