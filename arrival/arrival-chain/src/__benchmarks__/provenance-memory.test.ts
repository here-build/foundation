/**
 * Provenance-memory smoke — the leak observatory.
 *
 * Context: a 1.3 GB heap dump (2026-06-08) was ~90k Set backing tables, all
 * `Invocation.provenance` / `Invocation.symbolContributions`. The open question
 * was: is a single provenance set's membership BOUNDED BY DATAFLOW DEPTH (a real,
 * legitimate lineage — the result genuinely depends on those upstream points), or
 * is it STILL SCALING WITH N (the O(n²) physical bloat the idempotence fix was
 * meant to kill — every retained invocation carrying an O(N) set)?
 *
 * This benchmark answers it by MEASURING, not guessing. It builds the GEPA persona
 * pipeline (the exact accumulating shape that produced the dump) and sweeps each
 * axis INDEPENDENTLY:
 *
 *   - DEPTH axis  (rounds vary, personas fixed): if maxSet grows with rounds, the
 *     reflect→tagline→react chain is accumulating lineage down the recursion.
 *   - WIDTH axis  (personas vary, rounds fixed): if maxSet grows with personas, the
 *     reflect's fan-in over the persona map is the membership source.
 *
 * Two metrics, two questions — kept distinct because conflating them (an earlier
 * draft summed set sizes PER INVOCATION) overcounts the heap by the reference-
 * sharing factor: `computeProvenance` forwards the SAME Set object on a 1-input pass
 * (trace.ts), and `symbolContributions` / `value.withProvenance` store set REFERENCES,
 * so one Set is pointed at by many invocations but the heap holds it once.
 *
 *   - `maxSet` — the single largest provenance set. Answers the ALGEBRA question: is
 *     one lineage scaling with N (×axis per doubling) or bounded by a fixed depth (flat)?
 *   - `allMemb` — Σ size over DISTINCT Set objects (by reference), across provenance
 *     AND symbolContributions. Answers the MEMORY question: this is the number that
 *     maps 1:1 to the heap dump's "N sets × M members", with no reference inflation.
 *     `allSets` is the distinct-object count (the dump's "36,730 sets").
 *
 * `provMemb` / `symMemb` break `allMemb` down by channel so each fix target is visible:
 * symbolContributions is a known prune-gap (`#pruneChildProvenance` doesn't touch it)
 * and measured ~2× the provenance membership — the dominant half before/after a fix.
 *
 * Run: `npm run benchmarks` (opt-in; excluded from the default boolean suite).
 * The numbers are the deliverable; the `expect` at the end is only a fail-loud
 * guard so a broken build doesn't silently benchmark nothing. The hard linear-bound
 * regression gate (on distinct-set membership) belongs in __tests__/, against the
 * post-fix baseline.
 *
 * See docs/working-proposals/trace-provenance-idempotence-fix-2026-06-04.md and the
 * heap-dump diagnosis (2026-06-08).
 */
import { describe, expect, test } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace, Invocation } from "../trace.js";

/** Deterministic stub: react → {verdict}, reflect → {next} with a growing tagline
 *  so every round mints distinct infers (no cache collisions collapsing the trace). */
const stub = {
  complete: async (spec: ModelSpec) => {
    const msgs = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) return { value: { verdict: "click" } };
    const current = user.split("|")[1] ?? "";
    return { value: { next: `${current}x` } };
  },
};

/** The GEPA shape: `rounds` tail-recursive iterations, each fanning out `personas`
 *  react infers + one reflect that reads them. This is the accumulating-loop shape
 *  the heap dump was taken from. */
async function buildBenchTrace(rounds: number, personas: number): Promise<EvalTrace> {
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

/** Every live Invocation that entered the trace, with its `.provenance` Set intact. */
function allInvocations(trace: EvalTrace): Invocation[] {
  const out: Invocation[] = [];
  for (const rec of trace.records.values()) for (const inv of rec.bindings) out.push(inv);
  return out;
}

interface Census {
  invocations: number;
  /** invocations REFERENCING a non-empty provenance set (≠ distinct objects — sharing) */
  provBearing: number;
  /** max single provenance-set membership across all invocations — the ALGEBRA answer */
  maxSet: number;
  /** distinct provenance Set objects (by reference) + Σ of their sizes */
  provSets: number;
  provMemb: number;
  /** distinct sets referenced by symbolContributions (by reference) + Σ of their sizes;
   *  the known prune-gap channel — usually the dominant half */
  symSets: number;
  symMemb: number;
  /** GLOBAL distinct Set objects (provenance ∪ symbolContributions, deduped by ref) +
   *  Σ of their sizes — the true heap proxy; maps 1:1 to the dump's "sets × members" */
  allSets: number;
  allMemb: number;
}

const sumSizes = (sets: Iterable<ReadonlySet<number>>): number => {
  let n = 0;
  for (const s of sets) n += s.size;
  return n;
};

function census(trace: EvalTrace): Census {
  const invs = allInvocations(trace);
  const provDistinct = new Set<ReadonlySet<number>>();
  const symDistinct = new Set<ReadonlySet<number>>();
  let provBearing = 0,
    maxSet = 0;
  for (const inv of invs) {
    if (inv.provenance.size > 0) {
      provBearing++;
      provDistinct.add(inv.provenance);
      if (inv.provenance.size > maxSet) maxSet = inv.provenance.size;
    }
    if (inv.symbolContributions) {
      for (const s of inv.symbolContributions) if (s.size > 0) symDistinct.add(s);
    }
  }
  const allDistinct = new Set<ReadonlySet<number>>([...provDistinct, ...symDistinct]);
  return {
    invocations: invs.length,
    provBearing,
    maxSet,
    provSets: provDistinct.size,
    provMemb: sumSizes(provDistinct),
    symSets: symDistinct.size,
    symMemb: sumSizes(symDistinct),
    allSets: allDistinct.size,
    allMemb: sumSizes(allDistinct),
  };
}

const row = (label: string, n: number, c: Census): string =>
  `  ${label}=${String(n).padStart(3)}  invs ${String(c.invocations).padStart(6)}  ` +
  `maxSet ${String(c.maxSet).padStart(5)}  ` +
  `prov ${String(c.provSets).padStart(5)}/${String(c.provMemb).padStart(7)}  ` +
  `sym ${String(c.symSets).padStart(5)}/${String(c.symMemb).padStart(7)}  ` +
  `ALL ${String(c.allSets).padStart(5)} sets / ${String(c.allMemb).padStart(8)} memb`;

/** Report the growth factor of a metric between successive sweep points next to the
 *  axis factor, so depth-linear (≈axis) is visibly distinct from quadratic (≈axis²). */
function growth(values: number[], axis: number[]): string {
  const parts: string[] = [];
  for (let i = 1; i < values.length; i++) {
    const axisFactor = axis[i]! / axis[i - 1]!;
    const valFactor = values[i - 1]! === 0 ? Infinity : values[i]! / values[i - 1]!;
    parts.push(`×${valFactor.toFixed(2)} (axis ×${axisFactor.toFixed(2)}, sq ×${(axisFactor * axisFactor).toFixed(2)})`);
  }
  return parts.join("   ");
}

describe("provenance memory — leak observatory", () => {
  test("DEPTH axis: rounds vary, personas fixed — does maxSet chain down the recursion?", async () => {
    const personas = 8;
    const roundsSweep = [8, 16, 32];
    const censuses: Census[] = [];
    const lines: string[] = [`\n=== DEPTH axis (personas=${personas} fixed) ===`];
    for (const rounds of roundsSweep) {
      const c = census(await buildBenchTrace(rounds, personas));
      censuses.push(c);
      lines.push(row("rounds", rounds, c));
    }
    lines.push(`  maxSet  growth: ${growth(censuses.map((c) => c.maxSet), roundsSweep)}`);
    lines.push(`  allMemb growth: ${growth(censuses.map((c) => c.allMemb), roundsSweep)}`);
    console.log(lines.join("\n"));

    // The printed `growth` ratios ARE the signal: maxSet ≈ ×axis (linear in rounds —
    // a single lineage's membership tracks depth, NOT bounded by a fixed dataflow
    // depth) and allMemb ≈ ×axis² (quadratic — distinct retained Set objects each
    // grow while their count also grows). Only a fail-loud sanity guard here, per the
    // benchmark convention (flow-graph.test.ts); the hard linear-bound regression gate
    // (on allMemb) lives in __tests__/, against the post-fix baseline.
    expect(censuses[0]!.allMemb).toBeGreaterThan(0);
    expect(censuses.at(-1)!.allMemb).toBeGreaterThan(censuses[0]!.allMemb);
  }, 120_000);

  test("WIDTH axis: personas vary, rounds fixed — does maxSet track the reflect fan-in?", async () => {
    const rounds = 8;
    const personasSweep = [8, 16, 32];
    const censuses: Census[] = [];
    const lines: string[] = [`\n=== WIDTH axis (rounds=${rounds} fixed) ===`];
    for (const personas of personasSweep) {
      const c = census(await buildBenchTrace(rounds, personas));
      censuses.push(c);
      lines.push(row("personas", personas, c));
    }
    lines.push(`  maxSet  growth: ${growth(censuses.map((c) => c.maxSet), personasSweep)}`);
    lines.push(`  allMemb growth: ${growth(censuses.map((c) => c.allMemb), personasSweep)}`);
    console.log(lines.join("\n"));

    // The width axis reads DIFFERENTLY from depth, and that difference is the
    // finding: allMemb is ≈ ×axis (LINEAR in personas), not quadratic. Widening the
    // fan-in scales each round's lineage linearly, but the number of accumulating
    // rounds is fixed — so there's no quadratic amplification here. The quadratic is
    // a DEPTH phenomenon (tagline accumulating across rounds), full stop. (The earlier
    // per-invocation-sum metric showed this axis as quadratic too — an artifact: the
    // reference-multiplicity itself grew with personas, inflating the proxy.)
    // Fail-loud sanity only; the regression gate lives in __tests__/.
    expect(censuses[0]!.allMemb).toBeGreaterThan(0);
    expect(censuses.at(-1)!.allMemb).toBeGreaterThan(censuses[0]!.allMemb);
  }, 120_000);
});
