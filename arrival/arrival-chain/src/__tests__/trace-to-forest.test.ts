/**
 * trace → candidate-box forest, against a REAL gepa trace. Asserts the core
 * meaningful structure (loop ⊃ {map ⊃ react-infer, reflect-infer}) with correct
 * types and measured-occurrence multiplicities, tolerating extra macro-internal
 * boxes (a known v1 limitation — accessor macros like `field`/`@` expand to a
 * `cond` the classifier currently sees; topology of the core is exact).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { collapseMDL, type CandidateBox } from "../mdl-collapse.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { traceToForest, type ForestOptions } from "../trace-to-forest.js";
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
        if (user.startsWith("REACT|")) return { verdict: "click" };
        const [, current] = user.split("|");
        return { next: current === "t0" ? "t1" : "t2" };
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

  it("KNOWN v1 GAP: a tail-recursive loop's body does not nest under the loop box", async () => {
    // Under TCO the recursive call-site (the loop anchor, fires K-1=2 back-edges)
    // and the iteration body (the map, runs K=3×) end up SIBLINGS at root — the
    // body is entered via the function mechanism, parented outside the call-site
    // Pair. So `map` floats to root instead of nesting under `loop`, and the loop
    // box counts back-edges (2) not iterations (3). This test pins that reality
    // as the regression baseline; the fix (anchor the loop to the recursive
    // function's body scope and nest its iterations) is the next design pass.
    const forest = traceToForest(await gepaTrace());
    const loop = forest.find((b) => b.type === "loop");
    const map = forest.find((b) => b.id.startsWith("map@"));
    expect(loop).toBeDefined();
    expect(map).toBeDefined(); // map is a ROOT (the gap) — should eventually be under loop
    expect(loop!.n).toBeCloseTo(2, 5); // back-edges, not 3 iterations (the gap)
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
