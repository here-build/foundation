/**
 * The trace protocol round-trips (ADR-019 D2). `serializeTrace` → JSON →
 * `loadTraceArtifact` reproduces the same `RegionGraph` the live render path
 * builds — and crucially the artifact is JSON-SAFE: its region `value`/`meta`
 * carry plain JS, not raw scheme `Pair`/boxed-number values, so a trace on disk
 * renders with no re-eval. The gepa loop (a ×2 react fan-out inside a TCO loop)
 * exercises leaves, a fanout with nested iterations, and an output.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { loadTraceArtifact, serializeTrace, TRACE_PROTOCOL_VERSION } from "@here.build/arrival-provenance";
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

/** Every region's scheme-bearing fields, flattened — the surface JSON must survive. */
const valuesOf = (rs: Region[]): unknown[] =>
  rs.flatMap((r) => {
    if (r.kind === "leaf") return [r.value, r.meta];
    if (r.kind === "output") return [r.value];
    if (r.kind === "fanout") return r.iterations.flatMap(valuesOf);
    return [];
  });

describe("trace artifact protocol", () => {
  it("serializes with the current version and a graph", async () => {
    const artifact = serializeTrace(await gepaTrace());
    expect(artifact.version).toBe(TRACE_PROTOCOL_VERSION);
    expect(artifact.graph.roots.length).toBeGreaterThan(0);
  });

  it("round-trips through JSON and reproduces the graph structure", async () => {
    const trace = await gepaTrace();
    const artifact = serializeTrace(trace);

    // The artifact must be literally JSON-safe — no scheme Pair/boxed value
    // survives `lowerRegion`, so stringify/parse is lossless.
    const wire = JSON.parse(JSON.stringify(artifact));
    const { graph } = loadTraceArtifact(wire);

    // Structure matches the live render path: same root kinds in order.
    const live = traceToRegions(trace);
    expect(graph.roots.map((r) => r.kind)).toEqual(live.roots.map((r) => r.kind));
    expect(graph.edges).toEqual(JSON.parse(JSON.stringify(live.edges)));
    expect(graph.warnings).toEqual(live.warnings);
  });

  it("lowers every region value to plain JSON-safe JS", async () => {
    const artifact = serializeTrace(await gepaTrace());
    // If any value were still a raw scheme Pair/boxed number, this would throw or
    // round-trip lossily. Equality after a JSON cycle proves it's plain.
    for (const v of valuesOf(artifact.graph.roots)) {
      expect(JSON.parse(JSON.stringify(v ?? null))).toEqual(v ?? null);
    }
  });

  it("rejects an artifact from a newer protocol version", async () => {
    const artifact = serializeTrace(await gepaTrace());
    expect(() => loadTraceArtifact({ ...artifact, version: TRACE_PROTOCOL_VERSION + 1 })).toThrow(/newer/);
  });
});
