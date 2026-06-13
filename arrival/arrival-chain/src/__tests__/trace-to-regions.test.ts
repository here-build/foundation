/**
 * traceToRegions — the region tree behind the blueprint render. On the gepa-loop
 * trace (a ×2 react fan-out inside a TCO loop) it must surface the `map` as a
 * CONTAINER with its iterations kept distinct (each a body with an infer leaf),
 * plus the provenance wires. The enclosing TCO `loop` is itself a container — its
 * K body entries peeled into distinct iterations (the recursion no longer flattens).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { traceToRegions, type Region } from "@here.build/arrival-provenance";
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
          const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
          const user = msgs.find((m) => m.role === "user")?.content ?? "";
          if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
          const current = user.split("|")[1] ?? "";
          return { value: { next: current === "t0" ? "t1" : "t2" } };
        },
      }),
    ),
  );
  const trace = new EvalTrace();
  await project.run(PROGRAM, { trace });
  return trace;
}

const fanouts = (rs: Region[]): Extract<Region, { kind: "fanout" }>[] =>
  rs.flatMap((r) => (r.kind === "fanout" ? [r, ...r.iterations.flatMap(fanouts)] : []));
const leaves = (rs: Region[]): Extract<Region, { kind: "leaf" }>[] =>
  rs.flatMap((r) => (r.kind === "leaf" ? [r] : r.kind === "fanout" ? r.iterations.flatMap(leaves) : []));
const decisions = (rs: Region[]): Extract<Region, { kind: "decision" }>[] =>
  rs.flatMap((r) => (r.kind === "decision" ? [r] : r.kind === "fanout" ? r.iterations.flatMap(decisions) : []));

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

    // The program's STATEMENT OUTPUT is a terminal node, wired from a producer.
    const outs = roots.filter((r): r is Extract<Region, { kind: "output" }> => r.kind === "output");
    expect(outs.length).toBe(1);
    const out = outs[0]!;
    expect(out.value).not.toBe(undefined);
    // At least one edge sinks into it (its immediate producer).
    expect(edges.some((e) => e.to === out.id)).toBe(true);
  });

  it("exposes each container's boundary ports — regions ARE boxes (Stage 2a)", async () => {
    const { roots } = traceToRegions(await gepaTrace());

    // The react fan-out (`map`) is a hermetic box: its react infers feed the reflect
    // OUTSIDE it (→ an OUTPUT port), and the reflect loop-back feeds the next
    // iteration's reacts (→ an INPUT port). Ports are keyed by STRUCTURAL producer
    // scope, so the ×2 react fan-out — two values, ONE source location — emits ONE
    // output port, not two.
    const map = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "map"))[0]!;
    const reactScopes = new Set(leaves(map.iterations.flat()).map((l) => l.scope));
    // ONE output port per structural react producer (not one per value).
    expect(map.outputs.length).toBe(1);
    expect(reactScopes.has(map.outputs[0]!.producer)).toBe(true);
    // The boundary is keyed by scope-id (`head@line:col`), never per-iteration value.
    expect(map.outputs[0]!.producer).toMatch(/@\d+:\d+$/);
    // Every output producer is genuinely INSIDE the map; no input producer is.
    expect(map.outputs.every((p) => reactScopes.has(p.producer))).toBe(true);
    expect(map.inputs.every((p) => !reactScopes.has(p.producer))).toBe(true);

    // The TCO loop is also a box: its internal reflect feeds the program OUTPUT
    // outside the loop → a non-empty OUTPUT port set.
    const loop = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "loop"))[0]!;
    expect(loop.outputs.length).toBeGreaterThan(0);
  });

  it("labels .prompt invocations by their run-X binding, direct infers by infer/chat", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: async (_s: ModelSpec) => ({ value: "v" }) })));
    project.addFile("analyze.prompt", `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}} {{message}}\n`);
    project.addFile("decide.prompt", `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}} {{message}} {{analysis}}\n`);
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
    project.bindInfer(createInferStore(singletonRouter({ complete: async (s: ModelSpec) => ({ value: s.prompt }) })));
    project.addFile("react.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nREACT {{tagline}}\n`);
    project.addFile("reflect.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nREFLECT {{failures}}\n`);
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

  it("splits one producer feeding TWO slots into two field-qualified edges", async () => {
    // V: a template `message: is ${score} fair for ${result}` reads two slots; the
    // SAME producer can land in both. The structural Hasse edge producer→consumer is
    // one fact, but it carries two field-to-field flows. We must emit one edge PER
    // (producer, slot), not collapse to a single arbitrary field — so the consumer's
    // two field-rows each get their own wire from the producer.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: async (s: ModelSpec) => ({ value: s.prompt }) })));
    project.addFile("score.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nSCORE {{seed}}\n`);
    project.addFile("judge.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nJUDGE {{score}} AND {{also}}\n`);
    const trace = new EvalTrace();
    await project.run(
      `
(define run-score (require "score.prompt"))
(define run-judge (require "judge.prompt"))
(let ((s (run-score "ks" :seed "x")))
  (run-judge "kj" :score (list s) :also (list s)))
`,
      { trace },
    );

    const { roots, edges } = traceToRegions(trace);
    const ls = leaves(roots);
    const judge = ls.find((l) => l.label === "run-judge")!;
    const score = ls.find((l) => l.label === "run-score")!;
    const intoJudge = edges.filter((e) => e.to === judge.id && e.from === score.id);
    // Two field-qualified edges — one per slot the producer flowed into.
    expect(intoJudge.length).toBe(2);
    expect(new Set(intoJudge.map((e) => e.field))).toEqual(new Set(["score", "also"]));
  });

  it("labels a FIELD-PLUCK edge — a single plucked field flows into the slot, not the whole value", async () => {
    // 01-linear-chain: `(b (refine :idea (field a "idea")))`. spark's value is a record
    // `{idea, energy}`; only its `idea` field lands in refine's `:idea` slot. The whole
    // spark value is NOT present in the slot — a pluck is, so the gate must recognise a
    // MEMBER of the producer flowing in, and label the edge with the consumer slot.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async (s: ModelSpec) => (/SPARK/.test(s.prompt) ? { value: { idea: "vivid", energy: 0.7 } } : { value: s.prompt }),
        }),
      ),
    );
    project.addFile("spark.prompt", `---\nmodel: fast\noutput:\n  idea: string\n  energy: number\n---\n{{role "user"}}\nSPARK {{topic}}\n`);
    project.addFile("refine.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nREFINE {{idea}}\n`);
    const trace = new EvalTrace();
    await project.run(
      `
(define spark  (require "spark.prompt"))
(define refine (require "refine.prompt"))
(let ((a (spark "ks" :topic "t")))
  (refine "kr" :idea (field a "idea")))
`,
      { trace },
    );

    const { roots, edges } = traceToRegions(trace);
    const ls = leaves(roots);
    const refine = ls.find((l) => l.label === "refine")!;
    const spark = ls.find((l) => l.label === "spark")!;
    const intoRefine = edges.filter((e) => e.to === refine.id && e.from === spark.id);
    expect(intoRefine.length).toBe(1);
    expect(intoRefine[0]!.field).toBe("idea");
  });

  it("does NOT wire a producer that merely INFLUENCED a literal slot (Where-vs-Why)", async () => {
    // `inputsProvenance` carries a slot's influenced-BY provenance, but field wiring
    // wants value-flowed-FROM. Here `s`'s value gates a branch whose RESULT is a fixed
    // literal `"Reply with a label."` — so the literal carries `s`'s provenance (it was
    // CHOSEN because of s) yet none of s's value appears in it. The note slot must get
    // NO field-qualified wire from the score producer (the gepa seed-instruction bug).
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: async (s: ModelSpec) => ({ value: s.prompt }) })));
    project.addFile("score.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nSCORE {{seed}}\n`);
    project.addFile("note.prompt", `---\nmodel: fast\n---\n{{role "user"}}\nNOTE {{note}}\n`);
    const trace = new EvalTrace();
    await project.run(
      `
(define run-score (require "score.prompt"))
(define run-note  (require "note.prompt"))
(let ((s (run-score "ks" :seed "x")))
  (run-note "kn" :note (if (eq? s s) "Reply with a label." "other")))
`,
      { trace },
    );

    const { roots, edges } = traceToRegions(trace);
    const ls = leaves(roots);
    const note = ls.find((l) => l.label === "run-note")!;
    const score = ls.find((l) => l.label === "run-score")!;
    // No field-qualified wire from score into the literal note slot.
    const fielded = edges.filter((e) => e.to === note.id && e.from === score.id && e.field !== undefined);
    expect(fielded.length).toBe(0);
  });

  it("DISSOLVES a static-test branch (no dynamic provenance) even when both arms run", async () => {
    // `pick` branches on the sign of n. Over (1 -1 2 -2) the `if` takes BOTH arms — it's
    // LIVE — but `(> n 0)` reads only `n`, a literal-list element: no inference feeds the
    // test, so its outcome was fixed before the run. By V's dynamic-provenance rule that's
    // DEGENERATE (`(if {10 + 20 < 50} …)`-grade) → the decision dissolves, leaving just the
    // gated infer leaves, no `<>` marker. `always`'s constant `(if #t …)` dissolves too.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete: async (s: ModelSpec) => ({ value: s.prompt.slice(-12) }) })));
    const trace = new EvalTrace();
    await project.run(
      `
(define (pick n)
  (if (> n 0)
      (car (infer/chat "fast" (list (infer/chat/user "POS")) #f (string-append "p/" (number->string n))))
      (car (infer/chat "fast" (list (infer/chat/user "NEG")) #f (string-append "n/" (number->string n))))))
(define (always n)
  (if #t
      (car (infer/chat "fast" (list (infer/chat/user "ALWAYS")) #f (string-append "a/" (number->string n))))
      "never"))
(for-each pick (list 1 -1 2 -2))
(for-each always (list 1 2))
`,
      { trace },
    );

    const { roots } = traceToRegions(trace);
    // No `<>` marker survives: every `if` here tests static data, so all dissolve —
    // never a container either (branches never become fanouts).
    const marks = decisions(roots).filter((d) => d.label === "if");
    expect(marks.length).toBe(0);
    expect(fanouts(roots).some((f) => f.stages.some((s) => s.label === "if"))).toBe(false);
    // The gated work is untouched: all 6 inference leaves (pick 4 + always 2) still
    // render and stay reachable — dissolving the decision keeps its content.
    const allLeaves = leaves(roots);
    expect(allLeaves.length).toBe(6);
  });

  it("renders a bare-symbol decision bound to an inference field, polarised present/absent", async () => {
    // `route` branches on `big`, a LOCAL bound to the `big` field PLUCKED off an infer
    // (`(:big (car (infer …)))`). The test is a bare symbol, so its outcome is resolved by
    // walking up to the binding `let` and reading the plucked value — and because that
    // value traces to an inference, the decision is DYNAMIC (renders, not degenerate). Over
    // (x y) one comes back truthy and one false → `big is present` / `big is absent`.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async (spec: ModelSpec) => {
            const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
            const user = msgs.find((m) => m.role === "user")?.content ?? "";
            if (user.startsWith("G|")) return { value: { big: user.endsWith("x") } };
            return { value: "leaf" };
          },
        }),
      ),
    );
    const trace = new EvalTrace();
    await project.run(
      `
(define (route tag)
  (let ((big (:big (car (infer/chat "fast"
                                    (list (infer/chat/user (string-append "G|" tag)))
                                    (s/object (s/field/boolean "big"))
                                    (string-append "g/" tag))))))
    (if big
        (car (infer/chat "fast" (list (infer/chat/user "BIG")) #f (string-append "b/" tag)))
        (car (infer/chat "fast" (list (infer/chat/user "SMALL")) #f (string-append "s/" tag))))))
(for-each route (list "x" "y"))
`,
      { trace },
    );

    const { roots, edges } = traceToRegions(trace);
    const conditions = decisions(roots)
      .filter((d) => d.label === "if")
      .map((d) => d.condition)
      .sort();
    expect(conditions).toEqual(["big is absent", "big is present"]);

    // Two edge kinds. Every edge is tagged data | control. Each `if` decision PRODUCES
    // a control signal: a control edge FROM the knot to the arm it gated this run.
    expect(edges.every((e) => e.kind === "data" || e.kind === "control")).toBe(true);
    const ifIds = new Set(decisions(roots).filter((d) => d.label === "if").map((d) => d.id));
    const control = edges.filter((e) => e.kind === "control");
    expect(control.length).toBeGreaterThan(0);
    expect(control.every((e) => ifIds.has(e.from))).toBe(true);
    // The control arm target is a rendered region (no float): the arm is the infer leaf
    // the chosen branch produced, never a dangling id.
    const ids = new Set([...leaves(roots).map((l) => l.id), ...fanouts(roots).map((f) => f.id), ...ifIds]);
    expect(control.every((e) => ids.has(e.to))).toBe(true);
  });

  it("wires an inference-derived operand into the decision as a DATA edge (through plumbing)", async () => {
    // `r` is bound to `(:verdict (car (infer …)))` — the operand isn't an inference
    // itself, it's a field PLUCK off one. Its value still traces, through provenance,
    // back to that infer. So the decision must CONSUME a data wire from the verdict
    // infer, not merely read the value as static text. The branch goes both ways over
    // (x y) → it's live and renders a `<>` decision.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async (spec: ModelSpec) => {
            const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
            const user = msgs.find((m) => m.role === "user")?.content ?? "";
            if (user.startsWith("R|")) return { value: { verdict: user.endsWith("x") ? "go" : "stop" } };
            return { value: "leaf" };
          },
        }),
      ),
    );
    const trace = new EvalTrace();
    await project.run(
      `
(define (route tag)
  (let ((r (:verdict (car (infer/chat "fast"
                                      (list (infer/chat/user (string-append "R|" tag)))
                                      (s/object (s/field/string "verdict"))
                                      (string-append "r/" tag))))))
    (if (equal? r "go")
        (car (infer/chat "fast" (list (infer/chat/user "A")) #f (string-append "a/" tag)))
        (car (infer/chat "fast" (list (infer/chat/user "B")) #f (string-append "b/" tag))))))
(for-each route (list "x" "y"))
`,
      { trace },
    );

    const { roots, edges } = traceToRegions(trace);
    const ifIds = new Set(decisions(roots).filter((d) => d.label === "if").map((d) => d.id));
    expect(ifIds.size).toBeGreaterThan(0);
    const leafIds = new Set(leaves(roots).map((l) => l.id));
    // A DATA edge sinks INTO a decision, sourced from a rendered infer leaf — the
    // operand's value arrives as dataflow, not as a baked annotation.
    const dataIn = edges.filter((e) => e.kind === "data" && ifIds.has(e.to));
    expect(dataIn.length).toBeGreaterThan(0);
    expect(dataIn.every((e) => leafIds.has(e.from))).toBe(true);

    // The wired operand `r` shows NAME ONLY in the pill — no inline value glyph — since
    // its value arrives on the data wire. `(if (equal? r "go") …)` reads `r is "go"` on
    // the match arm, `r is not "go"` on the other.
    const conds = decisions(roots).filter((d) => d.label === "if").map((d) => d.condition ?? "");
    expect(conds.length).toBeGreaterThan(0);
    expect(conds.every((c) => /^r is( not)? "go"$/.test(c))).toBe(true);
  });

  it("wraps the TCO loop in one container with its body entries as distinct iterations", async () => {
    const { roots } = traceToRegions(await gepaTrace());

    // The self-recursive `loop` (3 body entries via TCO) is ONE container, not a
    // flattened spine — the recursion no longer escapes detection.
    const loops = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "loop"));
    expect(loops.length).toBe(1);
    const loop = loops[0]!;
    // It's flagged a TCO self-recursion loop (not a map/filter fan-out) so the
    // render draws the loop-back recursion arc.
    expect(loop.loop).toBe(true);
    // A map fan-out, by contrast, carries no loop flag.
    expect(fanouts(roots).filter((f) => f.stages.some((s) => s.label === "map")).every((f) => !f.loop)).toBe(true);
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
    project.bindInfer(createInferStore(singletonRouter({ complete: async (_s: ModelSpec) => ({ value: { verdict: "click" } }) })));
    const trace = new EvalTrace();
    await project.run(PROGRAM.replace('(loop "t0" 0 2)', '(loop "t0" 0 0)'), { trace });

    const { roots } = traceToRegions(trace);
    const loops = fanouts(roots).filter((f) => f.stages.some((s) => s.label === "loop"));
    expect(loops.length).toBe(1);
    expect(loops[0]!.iterations.length).toBe(1); // the one body entry, boxed
    expect(leaves(loops[0]!.iterations.flat()).length).toBeGreaterThan(0);
  });
});
