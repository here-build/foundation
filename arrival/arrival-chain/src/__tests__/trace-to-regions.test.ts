/**
 * traceToRegions — the region tree behind the blueprint render. On the gepa-loop
 * trace (a ×2 react fan-out inside a TCO loop) it must surface the `map` as a
 * CONTAINER with its iterations kept distinct (each a body with an infer leaf),
 * plus the provenance wires. The enclosing TCO `loop` is itself a container — its
 * K body entries peeled into distinct iterations (the recursion no longer flattens).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { traceToRegions, type Region } from "../trace-to-regions.js";
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
  const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
  project.bindCache(cache);
  const ac = new AbortController();
  const draining = startOrchestrator({
    cache,
    router: singletonRouter({
      complete: async (spec: ModelSpec) => {
        const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
        const user = msgs.find((m) => m.role === "user")?.content ?? "";
        if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
        const current = user.split("|")[1] ?? "";
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

const fanouts = (rs: Region[]): Extract<Region, { kind: "fanout" }>[] =>
  rs.flatMap((r) => (r.kind === "fanout" ? [r, ...r.iterations.flatMap(fanouts)] : []));
const leaves = (rs: Region[]): Extract<Region, { kind: "leaf" }>[] =>
  rs.flatMap((r) => (r.kind === "leaf" ? [r] : r.iterations.flatMap(leaves)));

describe("traceToRegions", () => {
  it("surfaces the map as a fan-out container with distinct iterations", async () => {
    const { roots, edges } = traceToRegions(await gepaTrace());

    const maps = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "map"));
    expect(maps.length).toBeGreaterThan(0);
    // The ×2 react fan-out: two distinct iterations (the tabs), each a body that
    // contains an infer leaf — NOT collapsed to one shape.
    const map = maps[0]!;
    expect(map.iterations.length).toBe(2);
    // `(list "p1" "p2")` → 2 invocations incoming, both meaningful (each infers).
    expect(map.incoming).toBe(2);
    expect(map.stages).toEqual([{ label: "map", id: map.id }]);
    for (const iter of map.iterations) expect(leaves(iter).length).toBeGreaterThan(0);
    // gepa-loop calls `(infer/chat …)` directly → direct-infer leaves.
    expect(leaves(map.iterations[0]!).every((l) => l.nodeKind === "direct")).toBe(true);

    // Provenance wires are present (react → reflect at least).
    expect(edges.length).toBeGreaterThan(0);
  });

  it("labels .prompt invocations by their run-X binding, direct infers by infer/chat", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("analyze.prompt", `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}} {{message}}\n`);
    project.addFile("decide.prompt", `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}} {{message}} {{analysis}}\n`);
    const ac = new AbortController();
    const draining = startOrchestrator({
      cache,
      router: singletonRouter({ complete: async (_s: ModelSpec) => ({ value: "v" }) }),
      signal: ac.signal,
    }).done;
    const trace = new EvalTrace();
    await project.run(
      `
(define run-analyze (require "analyze.prompt"))
(define run-decide  (require "decide.prompt"))
(define (direct m) (car (infer/chat "fast" (list (infer/chat/user m)) #f (string-append "d/" m))))
(let* ((a (run-analyze (list "ia" "m") :instruction "ia" :message "m"))
       (d (run-decide  (list "id" "m" a) :instruction "id" :message "m" :analysis a)))
  (direct "x"))
`,
      { trace },
    );
    ac.abort();
    await draining;

    const ls = leaves(traceToRegions(trace).roots);
    const labels = new Map(ls.map((l) => [l.label, l.nodeKind]));
    // The two .prompt calls read by their binding, the direct infer by its head.
    expect(labels.get("run-analyze")).toBe("prompt");
    expect(labels.get("run-decide")).toBe("prompt");
    expect(labels.get("infer/chat")).toBe("direct");

    // Each .prompt leaf carries its `resultWithProvenance` metadata — the card's
    // structured source: file + model + the LOSSLESS folded kwargs (the whole point
    // of binding at the node rather than reconstructing from the rendered prompt).
    const analyzeLeaf = ls.find((l) => l.label === "run-analyze")!;
    expect(analyzeLeaf.meta).toMatchObject({
      kind: "prompt",
      path: "analyze.prompt",
      model: "fast",
      inputs: { instruction: "ia", message: "m" },
    });
    expect(analyzeLeaf.state).toBe("resolved");
    // The result is unwrapped to plain JS — NOT the raw AValue envelope scheme sees
    // (`{ provenance, kind, __string__ }`), which would otherwise leak into the card.
    expect(analyzeLeaf.value).not.toMatchObject({ __string__: expect.anything() });
    // A direct `(infer …)` has no structured node metadata.
    expect(ls.find((l) => l.label === "infer/chat")!.meta).toBeUndefined();
  });

  it("attributes a value PACKED INTO A LIST to its field — per-element provenance survives the array", async () => {
    // V's bug: two react producers feed a reflect `.prompt` whose `:failures`
    // input is `(list a b)`. A whole-value compare can't match — the slot holds
    // `[va, vb]`, not `va` — so both edges land on the reflect block unfielded.
    // The SOUND path threads each element's origin through the rosetta membrane:
    // `inputsProvenance.failures = [pointA, pointB]`, so both edges attribute to
    // `failures` instead of the block in general.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("react.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nREACT {{tagline}}\n`);
    project.addFile("reflect.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nREFLECT {{failures}}\n`);
    const ac = new AbortController();
    const draining = startOrchestrator({
      cache,
      router: singletonRouter({ complete: async (s: ModelSpec) => ({ value: s.prompt }) }),
      signal: ac.signal,
    }).done;
    const trace = new EvalTrace();
    await project.run(
      `
(define run-react   (require "react.prompt"))
(define run-reflect (require "reflect.prompt"))
(let* ((a (run-react "ka" :tagline "p1"))
       (b (run-react "kb" :tagline "p2")))
  (run-reflect "kr" :failures (list a b)))
`,
      { trace },
    );
    ac.abort();
    await draining;

    const { roots, edges } = traceToRegions(trace);
    const ls = leaves(roots);
    const reflect = ls.find((l) => l.label === "run-reflect")!;
    const reacts = ls.filter((l) => l.label === "run-react").map((l) => l.id);
    expect(reacts.length).toBe(2);
    // Both react→reflect edges exist AND both name the `failures` field.
    const intoReflect = edges.filter((e) => e.to === reflect.id && reacts.includes(e.from));
    expect(intoReflect.length).toBe(2);
    expect(intoReflect.every((e) => e.field === "failures")).toBe(true);
  });

  it("wraps the TCO loop in one container with its body entries as distinct iterations", async () => {
    const { roots } = traceToRegions(await gepaTrace());

    // The self-recursive `loop` (3 body entries via TCO) is ONE container, not a
    // flattened spine — the recursion no longer escapes detection.
    const loops = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "loop"));
    expect(loops.length).toBe(1);
    const loop = loops[0]!;
    // `(loop "t0" 0 2)` → iters 0,1,2; the last terminates (no `reflect` seeding a
    // 4th), but each entry still ran its ×2 react fan-out.
    expect(loop.iterations.length).toBe(3);
    for (const iter of loop.iterations) expect(leaves(iter).length).toBeGreaterThan(0);

    // Bounded: 3 iters × (2 react + reflect) — a handful, not hundreds.
    expect(leaves(roots).length).toBeGreaterThan(0);
    expect(leaves(roots).length).toBeLessThan(40);
  });

  it("boxes a loop that ran ONE body entry and never recursed (the midway case)", async () => {
    // `(loop "t0" 0 0)` terminates on the first iteration: `(>= 0 0)` is true, so
    // the recursive `(loop …)` call NEVER fires. Dynamic `hasSelfAncestor` therefore
    // sees no recursion and would leave it unboxed — exactly the stall V hit, where
    // a streaming loop shows no container until its successor enters. The STATIC
    // reader knows `loop` tail-recurses from its `(define …)`, so the single body
    // entry is a loop container from the start.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const ac = new AbortController();
    const draining = startOrchestrator({
      cache,
      router: singletonRouter({ complete: async (_s: ModelSpec) => ({ value: { verdict: "click" } }) }),
      signal: ac.signal,
    }).done;
    const trace = new EvalTrace();
    await project.run(PROGRAM.replace('(loop "t0" 0 2)', '(loop "t0" 0 0)'), { trace });
    ac.abort();
    await draining;

    const { roots } = traceToRegions(trace);
    const loops = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "loop"));
    expect(loops.length).toBe(1);
    expect(loops[0]!.iterations.length).toBe(1); // the one body entry, boxed
    expect(leaves(loops[0]!.iterations.flat()).length).toBeGreaterThan(0);
  });
});
