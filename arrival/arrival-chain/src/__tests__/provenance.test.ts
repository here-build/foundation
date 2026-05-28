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

describe("provenance × control-flow restriction (the other 4 forms)", () => {
  // The `if` test above pins the contract: only the chosen arm's lineage flows.
  // cond/when/unless/case route through the same `restrictControlFlowProvenance`
  // helper (evaluator.ts:1283/1351/1377/1400) — if any one of them ever stops
  // doing so, an unchosen-branch's infer would leak into the consumer's lineage
  // and "why did this happen" would point at code that never ran.
  it("cond — only matching clause's predicate + body provenance contributes", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // First clause's predicate is #t (constant, no provenance), body fires the
    // first infer. The else-arm's infer must NEVER enter — its presence in the
    // result set would mean we attributed behavior to a branch that didn't run.
    project.addFile(
      "a.scm",
      `(cond
         (#t (car (infer "m" "matched")))
         (else (car (infer "m" "skipped"))))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "ctl-cond",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const infers = findInvocationsForCall(trace, "infer");
    expect(infers.length).toBe(1);
    const inferInv = infers[0]!;

    const condInv = findInvocationsForCall(trace, "cond")[0]!;
    expect([...condInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("when — body provenance unions with predicate when test is truthy", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Predicate is a constant (no provenance), body fires an infer. The when
    // invocation must carry the body infer's id — without it, `(define x (when
    // … (car (infer …))))` binds `x` with empty provenance and the binding
    // step snaps the chain.
    project.addFile(
      "a.scm",
      `(when #t (car (infer "m" "body-fires")))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "ctl-when",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const whenInv = findInvocationsForCall(trace, "when")[0]!;
    expect([...whenInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("unless — body provenance unions with predicate when test is falsy", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Mirror of `when` but the predicate must be FALSY for the body to fire.
    // The constant `#f` has no provenance; only the body infer should appear.
    project.addFile(
      "a.scm",
      `(unless #f (car (infer "m" "body-fires-when-false")))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "ctl-unless",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const unlessInv = findInvocationsForCall(trace, "unless")[0]!;
    expect([...unlessInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });

  it("case — matching clause body provenance unions with key", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Per spec §5.3 comment in evaluator.ts:1347, the dispatching key is the
    // runtime value whose lineage was consulted; literal datums in clauses
    // never contribute. The matching clause's body infer must appear; the
    // non-matching clause's infer must not have fired at all.
    project.addFile(
      "a.scm",
      `(case 2
         ((1) (car (infer "m" "one")))
         ((2) (car (infer "m" "two")))
         (else (car (infer "m" "other"))))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "ctl-case",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const infers = findInvocationsForCall(trace, "infer");
    expect(infers.length).toBe(1);
    const inferInv = infers[0]!;

    const caseInv = findInvocationsForCall(trace, "case")[0]!;
    expect([...caseInv.provenance]).toEqual([inferInv.id]);

    stop();
    await done;
  });
});

describe("provenance × bridge.ts string pipeline (multi-step)", () => {
  // Pre-L3.C, bridge.ts string ops dropped value-level provenance — the
  // result was a fresh SchemeString allocated through `new SchemeString(...)`
  // with no stamp. Single-step `(string-append a (car (infer …)))` was patched
  // by withInputProvenance (bridge.ts:271); this test pins the MULTI-STEP
  // pipeline so a future refactor that forgets to thread provenance through
  // the inner string-append is caught here, not in a downstream binding step.
  it("nested string-append carries infer provenance through both layers", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Outer string-append takes the inner's SchemeString result as one of its
    // inputs. If the inner forgot to stamp, the outer's withInputProvenance
    // would see only literal-source strings and produce empty provenance —
    // and the outer invocation's exit-tap would have nothing to union.
    project.addFile(
      "a.scm",
      `(string-append "x"
         (string-append "y" (car (infer "m" "deep"))))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "pipe-deep",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const concats = findInvocationsForCall(trace, "string-append");
    expect(concats.length).toBe(2);

    // Both concat invocations should carry the infer's id — the inner because
    // it consumed the (car …) directly, the outer because the inner's result
    // carried the stamp through value-level provenance.
    for (const inv of concats) {
      expect([...inv.provenance]).toEqual([inferInv.id]);
    }

    stop();
    await done;
  });
});

describe("provenance × comparison-as-predicate", () => {
  // wrapOperator (bridge.ts:237) boxes raw JS `boolean` into SchemeBool when
  // non-empty provenance is involved. That box is what lets the resulting
  // `(< x 5)` carry the lineage of `x` into the `if`'s test channel — without
  // it, restrictControlFlowProvenance would see `predicate instanceof AValue
  // === false` and silently drop the test's contribution. The comment at
  // bridge.ts:226-235 ("Comparison-op bool boxing") spells out the regression.
  it("(if (< (car (infer …)) 5) …) — predicate channel carries infer provenance", async () => {
    const { project, cache } = fresh();
    const { stop, done } = workerOver(project, cache);

    // Stub the worker to return a NUMERIC result (the orchestrator's default
    // stub echoes the prompt as `R[…]` — not comparable with `<`). Override
    // here by returning the source's first sentinel digit packed as a list.
    project.addFile(
      "a.scm",
      // (infer …) returns a list; take car to get a string we compare against
      // length. We need a numeric pipeline — use `string-length` on (car …)
      // which returns a number stamped with the infer's provenance.
      `(if (< (string-length (car (infer "m" "x"))) 100)
         "small"
         "large")`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "cmp-pred",
      file: "a.scm",
      source: project.findFile("a.scm")!.versions.at(-1)!.source,
      trace,
    });
    await finished;

    const inferInv = findInvocationsForCall(trace, "infer")[0]!;
    const ifInv = findInvocationsForCall(trace, "if")[0]!;

    // The if's provenance includes the infer's id ONLY if the comparison's
    // SchemeBool result carried the stamp through restrictControlFlowProvenance.
    expect(ifInv.provenance.has(inferInv.id)).toBe(true);

    stop();
    await done;
  });
});

describe("provenance × spec §5.3 (car/cdr element-only)", () => {
  // Spec §5.3 (docs/spec/arrival-chain.md:218): `(car (list a b)) → a, with
  // provenance P<A>`. Current impl in lips.ts:2067-2070 routes through
  // `withInputProvenance([list], list.car)` which unions the CONTAINER's
  // provenance (P<A,B>) onto the element. Result: `(car (list a b))` carries
  // P<A,B> not P<A> — phantom contributor `b` shows up in `a`'s lineage.
  //
  // Marked .fails (vitest's inverted-assertion modifier) because the audit
  // identified the bug but the fix is not yet landed. When the fix lands
  // (route `withInputProvenance([list.car], list.car)` or carry the on-value
  // provenance through unchanged), this test will flip from green-because-it-
  // -fails to red — drop the `.fails` modifier then.
  it.fails(
    "(car (list a b)) carries only a's provenance, not b's",
    async () => {
      const { project, cache } = fresh();
      const { stop, done } = workerOver(project, cache);

      // Two independent infers feed into a literal `(list …)`. Per spec, the
      // list itself carries P<A,B>, but `(car …)` extracts the first element
      // whose own provenance is P<A> alone.
      project.addFile(
        "a.scm",
        `(car (list (car (infer "m" "A")) (car (infer "m" "B"))))`,
      );
      const trace = new EvalTrace();
      const { finished } = await project.sandboxRunTraced({
        id: "spec-5-3",
        file: "a.scm",
        source: project.findFile("a.scm")!.versions.at(-1)!.source,
        trace,
      });
      await finished;

      const infers = findInvocationsForCall(trace, "infer");
      expect(infers.length).toBe(2);
      const [inferA, inferB] = infers;

      // The OUTER (car …) — there are 3 `car` invocations in this program
      // (two inside the list-construction, one outermost). The outermost is
      // the one whose parent is the top-level expression.
      const cars = findInvocationsForCall(trace, "car");
      const outerCar = cars.at(-1)!;

      // Per spec §5.3: outer car receives only A's id — B is a sibling whose
      // lineage lives on the container, not on element-A.
      expect([...outerCar.provenance]).toEqual([inferA!.id]);
      expect(outerCar.provenance.has(inferB!.id)).toBe(false);

      stop();
      await done;
    },
  );
});
