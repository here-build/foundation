/**
 * Provenance depth-bound regression gate.
 *
 * The leak (1.3 GB heap dump, 2026-06-08) was provenance sets ACCUMULATING down a
 * tail-recursive loop: each round's reflect→tagline→react chain re-unioned the
 * frame's prior lineage, so a single set's membership grew with DEPTH (quadratic
 * total memory). The fix makes a point/`(:field …)` projection authoritative —
 * the field-point IS the link, upstream is reached by following it, not by carrying
 * the transitive closure — so the forwarding boundary forwards the truncated set
 * unchanged instead of re-accumulating.
 *
 * This gate locks that in: across a DEPTH doubling sweep (rounds vary, personas
 * fixed), the single largest provenance set must stay FLAT (depth-independent), and
 * total distinct-set membership must grow ~LINEARLY (≈×2 per doubling), never
 * quadratically (≈×4). The observatory (`__benchmarks__/provenance-memory.test.ts`)
 * prints the full numbers; this is the fail-loud guard against re-introducing the
 * depth accumulation. Pre-fix baseline this catches: maxSet 127→263→535 (grew with
 * rounds), allMemb ×3.7. Post-fix: maxSet flat 2, allMemb ×~2.
 */
import { describe, expect, test } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace, type Invocation } from "@here.build/arrival-provenance";

const stub = {
  complete: async (spec: ModelSpec) => {
    const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
    const current = user.split("|")[1] ?? "";
    return { value: { next: `${current}x` } };
  },
};

/** The GEPA accumulating shape: `rounds` tail-recursive iterations, each fanning out
 *  `personas` react infers + one reflect that reads them through a `(:field …)`. */
async function buildTrace(rounds: number, personas: number): Promise<EvalTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter(stub)));
  const trace = new EvalTrace();
  const personaList = Array.from({ length: personas }, (_, i) => `"p${i}"`).join(" ");
  await project.run(
    `
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
  (let ((reactions (map (lambda (p) (react-cell tagline p)) (list ${personaList}))))
    (if (>= iter max-iter) tagline (loop (next-tagline tagline reactions) (+ iter 1) max-iter))))
(loop "t0" 0 ${rounds})
`,
    { trace },
  );
  return trace;
}

function allInvocations(trace: EvalTrace): Invocation[] {
  const out: Invocation[] = [];
  for (const rec of trace.records.values()) for (const inv of rec.bindings) out.push(inv);
  return out;
}

/** maxSet = largest single provenance set; allMemb = Σ size over DISTINCT set objects
 *  (provenance ∪ symbolContributions, deduped by reference — the heap-dump proxy). */
function census(trace: EvalTrace): { maxSet: number; allMemb: number } {
  const distinct = new Set<ReadonlySet<number>>();
  let maxSet = 0;
  for (const inv of allInvocations(trace)) {
    if (inv.provenance.size > 0) {
      distinct.add(inv.provenance);
      if (inv.provenance.size > maxSet) maxSet = inv.provenance.size;
    }
    if (inv.symbolContributions) for (const s of inv.symbolContributions) if (s.size > 0) distinct.add(s);
  }
  let allMemb = 0;
  for (const s of distinct) allMemb += s.size;
  return { maxSet, allMemb };
}

describe("provenance depth bound", () => {
  test("maxSet stays flat and allMemb stays linear as recursion DEPTH doubles", async () => {
    const personas = 4;
    const sweep = [4, 8, 16];
    const census0 = census(await buildTrace(sweep[0]!, personas));
    const census1 = census(await buildTrace(sweep[1]!, personas));
    const census2 = census(await buildTrace(sweep[2]!, personas));

    // maxSet is depth-INDEPENDENT: a single lineage no longer accumulates down the
    // loop. The field-point truncation caps it at a small constant (the fan-in width
    // of one reflect step), not the number of rounds. Pre-fix this grew 127→263→535.
    expect(census0.maxSet).toBe(census1.maxSet);
    expect(census1.maxSet).toBe(census2.maxSet);
    expect(census2.maxSet).toBeLessThanOrEqual(8);

    // allMemb grows ~LINEARLY with depth (≈×2 per doubling), never quadratically
    // (≈×4). Guard at ×2.6 — comfortably above linear noise, well below the ×3.7 the
    // pre-fix accumulation produced.
    const r1 = census1.allMemb / census0.allMemb;
    const r2 = census2.allMemb / census1.allMemb;
    expect(r1).toBeLessThan(2.6);
    expect(r2).toBeLessThan(2.6);
  }, 60_000);
});
