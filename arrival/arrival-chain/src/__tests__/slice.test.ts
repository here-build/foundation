import { describe, expect, it, vi } from "vitest";
import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";
import { buildSlice, referencedSymbols, defineNameOf, writeForm, lastTopLevelForm } from "@here.build/arrival-provenance";

const echoInfer = () => vi.fn(async (s: ModelSpec) => ({ value: `out:${s.prompt}` }));
const fresh = () => {
  const p = ArrivalChain.bootstrap(new Project()).root;
  p.bindInfer(createInferStore(singletonRouter({ complete: echoInfer() })));
  return p;
};

/** Slice a program by its OUTPUT form, append a self-contained terminator, re-run in a fresh
 *  project, and return {program, rerun, original}. The core guarantee = rerun deep-equals original. */
async function sliceAndRerun(src: string) {
  const trace = new EvalTrace();
  const { finished } = await fresh().runTraced(src, { trace });
  const original = await finished;
  const out = lastTopLevelForm(trace);
  const slice = buildSlice(trace, out);
  const terminal = defineNameOf(out) ?? writeForm(out);
  const program = `${slice.program}\n${terminal}`.trim();
  const rerun = await (await fresh().runTraced(program, { trace: new EvalTrace() })).finished;
  return { program, rerun, original, slice };
}

describe("buildSlice — reverse-chain slice (static backward closure)", () => {
  it("prunes unrelated forms and keeps the referenced literal define", async () => {
    const { program, rerun, original, slice } = await sliceAndRerun(`
      (define unused (infer "fast" "irrelevant"))
      (define tag "malware")
      (define hit (list (car (infer "fast" "name")) tag))
      hit
    `);
    expect(program).not.toContain("unused");
    expect(program).not.toContain("irrelevant");
    expect(program).toContain("(define hit");
    expect(program).toContain("(define tag");
    expect(rerun).toEqual(original); // re-runs to the same value
    expect(slice.points.length).toBeGreaterThan(0);
  });

  // The swarm's #0 critical: the value's binding form is a PURE COMBINATOR (string-append), whose
  // invocation is not a provenance point — the old cone approach dropped it (unbound on re-run).
  it("keeps a pure-combinator output-binding form (string-append)", async () => {
    const { program, rerun, original } = await sliceAndRerun(`
      (define ev (car (infer "fast" "E")))
      (define out (string-append "P:" ev))
      out
    `);
    expect(program).toContain("(define out");
    expect(rerun).toEqual(original);
  });

  // The swarm's #1 critical: multi-source aggregation — both leaves kept but the aggregating
  // (define combined ...) was dropped.
  it("keeps a multi-source aggregation form, drops nothing it needs", async () => {
    const { program, rerun, original } = await sliceAndRerun(`
      (define p (car (infer "fast" "P")))
      (define q (car (infer "fast" "Q")))
      (define combined (string-append p "|" q))
      combined
    `);
    expect(program).toContain("(define combined");
    expect(rerun).toEqual(original);
  });

  // #2: if / list output shapes.
  it("keeps if/list output-binding forms", async () => {
    for (const body of [`(if #t (string-append ev "X") "none")`, `(list "header" ev)`]) {
      const { program, rerun, original } = await sliceAndRerun(`
        (define ev (car (infer "fast" "E")))
        (define final ${body})
        final
      `);
      expect(program).toContain("(define final");
      expect(rerun).toEqual(original);
    }
  });

  // #3/#4/#5/#6/#17: writeForm must round-trip vectors / chars / bytevectors, not crash or emit
  // [object Object]. Re-run proves the rendered datum re-parses to the same value.
  it("renders vector / char / bytevector data faithfully (re-parses identically)", async () => {
    for (const lit of [`(vector 1 2 3)`, `#\\a`, `(list #\\space "x")`, `(bytevector 1 2 255)`]) {
      const { program, rerun, original } = await sliceAndRerun(`
        (define datum ${lit})
        datum
      `);
      expect(program).not.toContain("[object");
      expect(rerun).toEqual(original);
    }
  });
});

describe("buildSlice — structural guarantees", () => {
  it("writeForm throws on a non-serializable datum rather than emitting [object Object]", () => {
    expect(() => writeForm({ kind: "procedure" } as unknown)).toThrow(/non-serializable/);
    expect(() => writeForm({ kind: "object" } as unknown)).toThrow(/non-serializable/);
  });

  it("a char literal does not crash referencedSymbols (kind-discriminated, not __name__ duck-type)", async () => {
    const trace = new EvalTrace();
    const { finished } = await fresh().runTraced(`(define c #\\a)\nc`, { trace });
    await finished;
    const out = lastTopLevelForm(trace);
    expect(() => referencedSymbols(out)).not.toThrow();
    expect(() => buildSlice(trace, out)).not.toThrow();
  });

  // Swarm-2 #13: a redefined name (accumulator / REPL rebind) must keep ALL its binding forms —
  // keeping only the last drops the earlier binding the later one reads → unbound on re-run.
  it("keeps every binding of a redefined name (accumulator idiom)", async () => {
    const { rerun, original } = await sliceAndRerun(`
      (define x (car (infer "fast" "E")))
      (define x (string-append x "!"))
      x
    `);
    expect(original).toBe("out:E!");
    expect(rerun).toEqual(original);
  });

  // Swarm-2 #3: large/exponential inexacts must not get a trailing ".0" after the exponent
  // (1.5e+300.0 re-parses as a symbol → unbound).
  it("round-trips exponential inexacts (no spurious .0 after the exponent)", async () => {
    const { program, rerun, original } = await sliceAndRerun(`(define n 1.5e300)\nn`);
    expect(program).not.toMatch(/e[+-]?\d+\.0/i);
    expect(rerun).toEqual(original);
  });

  // Swarm-2 #5/#6/#10: writeForm must throw on a cyclic datum, not spin to a RangeError.
  it("writeForm throws on a cyclic datum instead of hanging", () => {
    const cyc = { kind: "pair", car: { kind: "symbol", __name__: "a", toString: () => "a" }, cdr: null as unknown };
    cyc.cdr = cyc; // self-cycle in the cdr spine
    expect(() => writeForm(cyc)).toThrow(/cyclic/);
  });

  it("writeForm throws on a cyclic VECTOR (the vector guard, not just the pair spine)", () => {
    const vec = { kind: "vector", __vector__: [] as unknown[] };
    vec.__vector__.push(vec); // vector containing itself
    expect(() => writeForm(vec)).toThrow(/cyclic/);
  });

  it("renders an improper/dotted pair literal round-trippably", async () => {
    const { program, rerun, original } = await sliceAndRerun(`(define p '(1 . 2))\np`);
    expect(program).toContain("(1 . 2)"); // the quoted dotted literal, not a cons call
    expect(rerun).toEqual(original);
  });
});

// The certificate's whole value: `points` must be the reads the DERIVATION makes — the kept
// forms' reads, including the output form's inline reads, and EXCLUDING pruned forms' reads.
describe("buildSlice — points = the reads in the slice (the attestation join key)", () => {
  it("excludes a pruned form's read and includes the kept one", async () => {
    const trace = new EvalTrace();
    const { finished } = await fresh().runTraced(`
      (define a (car (infer "fast" "A")))
      (define noise (car (infer "fast" "NOISE")))
      (list a)
    `, { trace });
    await finished;
    const out = lastTopLevelForm(trace);
    const slice = buildSlice(trace, out);
    // Two reads ran; only a's feeds the output, so exactly ONE read is in the derivation.
    expect(slice.points).toHaveLength(1);
    expect(slice.formNodes.map((n) => defineNameOf(n))).toContain("a");
    expect(slice.formNodes.map((n) => defineNameOf(n))).not.toContain("noise");
    expect(slice.scopeIds).toHaveLength(slice.formNodes.length);
  });

  it("counts a read inline in the output form (a finding with no defines)", async () => {
    const trace = new EvalTrace();
    const { finished } = await fresh().runTraced(`(list (car (infer "fast" "X")))`, { trace });
    await finished;
    const out = lastTopLevelForm(trace);
    const slice = buildSlice(trace, out);
    expect(slice.formNodes).toHaveLength(0); // no defines
    expect(slice.points).toHaveLength(1); // the output form's inline read still counts
  });
});
