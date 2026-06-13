/**
 * traceToChain over a `.prompt`-require pipeline (the gepa `trace` shape):
 * run-analyze → a `let*`-bound `analysis` → run-decide reads it. Confirms
 * provenance flows through dotprompt infers AND a let binding (the edge exists —
 * the thing the chain render must show). Since the opaque `.prompt` rework each
 * dotprompt call is ONE node at its real source location, so the two infers carry
 * DISTINCT labels (their bindings) — no shared synthetic `infer/chat@1` scopeId.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { traceToChain } from "@here.build/arrival-provenance";
import { EvalTrace } from "@here.build/arrival-provenance";

const ANALYZE = `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}}\n\nMessage: {{message}}\n`;
const DECIDE = `---\nmodel: fast\n---\n{{role "user"}}\n{{instruction}}\n\nMessage: {{message}}\nAnalysis: {{analysis}}\n`;

describe("traceToChain — provenance through .prompt infers", () => {
  it("links run-analyze → run-decide across a let* binding", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(singletonRouter({ complete: async (_s: ModelSpec) => ({ value: "stub" }) })),
    );
    project.addFile("analyze.prompt", ANALYZE);
    project.addFile("decide.prompt", DECIDE);
    const trace = new EvalTrace();
    await project.run(
      `
(define run-analyze (require "analyze.prompt"))
(define run-decide  (require "decide.prompt"))
(let* ((message  "the app crashes")
       (analysis (run-analyze (list "instrA" message) :instruction "instrA" :message message))
       (label    (run-decide  (list "instrD" message analysis) :instruction "instrD" :message message :analysis analysis)))
  label)
`,
      { trace },
    );

    const chain = traceToChain(trace);
    // Two infer calls, one provenance edge: analyze (layer 0) feeds decide (layer 1).
    expect(chain.nodes).toHaveLength(2);
    const [a, d] = [...chain.nodes].sort((x, y) => x.layer - y.layer);
    expect(a!.layer).toBe(0);
    expect(d!.layer).toBe(1);
    expect(chain.edges).toContainEqual({ from: a!.id, to: d!.id });
    // The opaque `.prompt` traces as one node at the real call site, so the two
    // infers carry DISTINCT labels — their bindings — not a shared synthetic
    // `infer/chat@1` scopeId (the collision the opaque rework removed).
    expect(a!.label).not.toBe(d!.label);
    expect(a!.label).toContain("run-analyze");
    expect(d!.label).toContain("run-decide");
  });
});
