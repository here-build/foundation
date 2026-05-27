/**
 * Provenance algebra — per `docs/spec/arrival-chain.md` §5.
 *
 * The exit-tap stamps every invocation with a `Set<call-id>` of upstream
 * provenance-marked invocations whose output flowed into its inputs.
 * Rosettas declared as provenance points emit a singleton {self.id};
 * everything else unions distinct non-empty child sets, deduping by
 * reference (so `(+ x x)` where both `x` resolve to the same defining
 * invocation contributes one membership, not two).
 *
 * Today only `(infer …)` is marked. Once `(query/* …)` and ad-hoc
 * sandbox-flagged points land, the same algebra applies.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { EvalTrace, Invocation } from "../trace.js";
import { startOrchestrator } from "../worker.js";

const fresh = () => {
  const project = ArrivalChain.bootstrap(new Project()).root;
  const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
  project.bindCache(cache);
  return { project, cache };
};

/** Bootstrap a worker against a stub backend that echoes input deterministically. */
function workerOver(project: Project, cache: InferenceCache) {
  const ac = new AbortController();
  const done = startOrchestrator({
    cache,
    router: singletonRouter({
      complete: vi.fn(async (s: { prompt: string }) => `R[${s.prompt}]`),
    }),
    signal: ac.signal,
  }).done;
  return { stop: () => ac.abort(), done };
}

/** Collect every invocation in the trace whose value made it to exit. */
function allInvocations(trace: EvalTrace): Invocation[] {
  const out: Invocation[] = [];
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) out.push(inv);
  }
  return out;
}

/** Find the invocation that corresponds to the call site matching the head symbol of its node. */
function findInvocationsForCall(trace: EvalTrace, headSymbol: string): Invocation[] {
  const out: Invocation[] = [];
  for (const inv of allInvocations(trace)) {
    const node = inv.node as { car?: { __name__?: string } };
    if (node.car?.__name__ === headSymbol) out.push(inv);
  }
  return out;
}

describe("provenance algebra", () => {
  it("(infer …) is a singleton provenance point — single self.id", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile("a.scm", `(car (infer "m" "hello"))`);
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "p1",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const infers = findInvocationsForCall(trace, "infer");
    expect(infers.length).toBe(1);
    const inferInv = infers[0]!;
    expect([...inferInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("(+ a (infer …) b) propagates the infer's set up through string-append", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile("a.scm", `(string-append "prefix-" (car (infer "m" "hi")) "-suffix")`);
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "p2",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const concat = findInvocationsForCall(trace, "string-append")[0]!;

    // The string-append invocation gets the infer's provenance via the (car …)
    // child whose provenance flows up through one non-empty set.
    expect([...concat.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("two independent (infer …) calls union into a 2-element set at their consumer", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile(
      "a.scm",
      `(string-append
         (car (infer "m" "A"))
         (car (infer "m" "B")))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "p3",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInvs = findInvocationsForCall(trace, "infer");
    expect(inferInvs.length).toBe(2);
    const expectedIds = new Set(inferInvs.map((i) => i.id));

    const concat = findInvocationsForCall(trace, "string-append")[0]!;
    expect(new Set(concat.provenance)).toEqual(expectedIds);

    stop();
    await done;
  });

  it("no-infer subtree has empty provenance", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile("a.scm", `(string-append "hi" " " "world")`);
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "p4",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const concat = findInvocationsForCall(trace, "string-append")[0]!;
    expect(concat.provenance.size).toBe(0);

    stop();
    await done;
  });

  it("(define list-binding (infer …)) flows provenance through symbol resolution", async () => {
    // Symbol resolution reads provenance directly off the resolved AValue,
    // so object-shaped (lists, pairs) and primitive-shaped (strings, numbers,
    // booleans) bindings flow identically. Pre-L1 the runtime kept a sidecar
    // WeakMap keyed by the result object — fine for pairs, snapped at every
    // bare scalar an (infer …) chain produced.
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile(
      "a.scm",
      `(define answer (infer "m" "hi"))
       (car answer)`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "sym1",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const carInv = findInvocationsForCall(trace, "car")[0]!;

    // `answer` resolves to the list returned by `(infer …)`. The list IS an
    // object → valueOrigin tracks it → symbol-resolution at the (car answer)
    // site contributes infer's provenance via symbolContributions.
    expect([...carInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("(define greeting (car (infer …))) flows provenance through a primitive-shaped binding", async () => {
    // Pre-L1 the (car …) result was a bare SchemeString → couldn't key the
    // valueOrigin WeakMap → `greeting`'s consumer saw empty provenance even
    // though the chain ran. L1+L2 puts provenance on the value itself, so
    // primitive-shaped bindings (string here) carry the infer's id the same
    // way a pair-shaped binding does.
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile(
      "a.scm",
      `(define greeting (car (infer "m" "hi")))
       (string-append "Hello, " greeting)`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "sym2",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const concat = findInvocationsForCall(trace, "string-append")[0]!;

    expect([...concat.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("control-flow (if …) propagates cond + chosen-arm provenance, not unchosen-arm", async () => {
    // Per spec §5.1: `if`'s result provenance = cond's provenance ∪ chosen-arm
    // result's provenance. The unchosen arm never enters → contributes nothing
    // via the natural children-aggregation rule.
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Two top-level (infer)s — only one fires per branch. The `if` exit
    // should contain only the chosen branch's infer.
    project.addFile(
      "a.scm",
      `(if #t
          (car (infer "m" "then-arm"))
          (car (infer "m" "else-arm")))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "ctl1",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    // Only one infer should have fired (the else-arm never entered).
    const infers = findInvocationsForCall(trace, "infer");
    expect(infers.length).toBe(1);
    const inferInv = infers[0]!;

    const ifInv = findInvocationsForCall(trace, "if")[0]!;
    expect([...ifInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("markProvenancePoint can be called ad-hoc on any invocation", async () => {
    // Sandbox override surface: user clicks "make this a provenance point"
    // on an AST node mid-run; runtime marks the invocation; exit emits singleton.
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    project.addFile("a.scm", `(string-append "x" "y")`);
    const trace = new EvalTrace();

    // Pre-mark before running: install a tap hook via a small subclass that
    // marks any string-append invocation as a provenance point on enter.
    const realEnter = trace.enter;
    trace.enter = ((node, parent) => {
      const inv = realEnter(node, parent);
      const head = (node as { car?: { __name__?: string } }).car?.__name__;
      if (head === "string-append") trace.markProvenancePoint(inv);
      return inv;
    }) as typeof trace.enter;

    const { finished } = await project.sandboxRunTraced({
      id: "p5",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const concat = findInvocationsForCall(trace, "string-append")[0]!;
    expect(concat.isProvenancePoint).toBe(true);
    expect([...concat.provenance]).toEqual([concat.id]);

    stop();
    await done;
  });
});
