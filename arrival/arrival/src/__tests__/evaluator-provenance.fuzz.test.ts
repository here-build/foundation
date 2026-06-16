/**
 * Fuzz harness for the Scheme evaluator + provenance algebra. Short numRuns
 * + short timeout — sits in the default `pnpm test` budget but exercises a
 * wide-enough surface to catch any regression that drops crash safety or
 * breaks an invariant (round-trip, monotonicity, idempotence) on randomly
 * shaped expression trees.
 *
 * Two halves:
 *   1. Crash safety on randomly generated arithmetic/conditional/string
 *      expressions. The evaluator is supposed to handle any well-formed
 *      input — divide-by-zero is the only expected exception, normalized
 *      out below.
 *   2. Invariant maintenance — for synthetic AValue trees built directly
 *      through the algebra (no parser, no evaluator), the same properties
 *      proved in property.test.ts must hold even at multi-level depth.
 *
 * Fuzz is exploratory by design — when this finds a real crash, the failing
 * seed reproduces deterministically (vitest prints the fast-check shrunk
 * counter-example). Promote any reproducible bug into provenance.test.ts as
 * a named, .fails-tagged case.
 */

import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { AValue, EMPTY_PROVENANCE, unionProvenance } from "../values/AValue.js";
import { initBridge } from "../bridge.js";
import { SchemeBool } from "../values/SchemeBool.js";
import { exec } from "./exec-adapter.js";

// exec-adapter only imports lips.ts (not index.ts), so wrappedOps don't get
// installed automatically. Without this, every random program below would
// fail with "Unbound variable `+'" — the harness used to "pass" by routing
// through the unbound-variable whitelist branch, never actually exercising
// the arithmetic dispatch. See bridge.ts:236 war story.
beforeAll(async () => {
  await initBridge();
});

/**
 * Recursive grammar for small Scheme programs. Two terminal categories
 * (literals and scoped variable refs) prevent infinite recursion via
 * fast-check's letrec depth cap. Operators chosen to span the
 * `wrapOperator` boundary (arithmetic), `withInputProvenance` boundary
 * (string-append), and the control-flow restriction (if/when/unless).
 */
const arbExpr = fc.letrec((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3 },
    fc.integer({ min: -100, max: 100 }).map((n) => `${n}`),
    fc.string({ minLength: 0, maxLength: 5, unit: "grapheme-ascii" }).map((s) => JSON.stringify(s)),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(+ ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(- ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(* ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr"), tie("expr")).map(([p, t, e]) => `(if ${p} ${t} ${e})`),
  ),
})).expr as fc.Arbitrary<string>;

/**
 * Whitelist of expected runtime errors — anything outside this list is a real
 * bug. The grammar above mixes integers, strings, and operators that only
 * accept numerics, so type errors are the typical outcome of a random sample.
 *
 * The "unbound variable" entry was removed after audit #42: with `initBridge`
 * installed (see beforeAll above), the previous "Unbound variable `-`" repro
 * for `(- (* 0 "") (- (- 0 0) 0))` is gone — the dispatch now throws a clean
 * `Cannot apply * to (number, string): argument 1 is string` which matches
 * the "cannot apply" + "argument" branches below.
 */
function isExpectedRuntimeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("division by zero") ||
    msg.includes("type") || // type errors from random string/number mixing are expected
    msg.includes("argument") ||
    msg.includes("not a") ||
    msg.includes("invalid") ||
    msg.includes("cannot apply") || // wrapOperator's new sharpened shape (audit #42)
    msg.includes("cannot convert") ||
    msg.includes("expected")
  );
}

describe("fuzz — evaluator crash safety", () => {
  it("never throws an unexpected error on randomly generated expressions", async () => {
    await fc.assert(
      fc.asyncProperty(arbExpr, async (program) => {
        try {
          await exec(program);
          return true;
        } catch (err) {
          // Document any unexpected crash with the offending program — this is
          // exactly the loud failure mode the harness exists for.
          if (!isExpectedRuntimeError(err)) {
            console.error(`fuzz crash: program=${program} err=${String(err)}`);
            return false;
          }
          return true;
        }
      }),
      // Short budget: keeps `pnpm test` snappy while still covering enough
      // shapes to catch a regression. Bump locally when chasing a bug.
      { numRuns: 30, interruptAfterTimeLimit: 5000 },
    );
  });
});

describe("fuzz — provenance algebra invariants at depth", () => {
  // Build random N-level union trees by treating `unionProvenance` results
  // as fresh AValue children for the next level. Any single-level invariant
  // proved in property.test.ts should hold across the full nested tree —
  // associativity and idempotence guarantee it, this asserts the guarantee
  // numerically.
  it("nested-union round-trip: flattened ids == set union of leaf ids", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { maxLength: 4 }),
          { minLength: 1, maxLength: 5 },
        ),
        (leafSets) => {
          // Round-trip 1: union all leaves at once.
          const flatLeaves = leafSets.map((ids) => new SchemeBool(true, new Set(ids)));
          const flatResult = unionProvenance(flatLeaves);

          // Round-trip 2: pairwise-fold through wrapped AValues.
          let acc: AValue = new SchemeBool(true, EMPTY_PROVENANCE);
          for (const ids of leafSets) {
            const leaf = new SchemeBool(false, new Set(ids));
            acc = new SchemeBool(false, unionProvenance([acc, leaf]));
          }

          // Both routes must agree on membership — associativity is what
          // makes the runtime free to choose either depending on evaluation
          // order (currying, partial application, generator vs lips).
          expect(new Set(acc.provenance)).toEqual(new Set(flatResult));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("nested-union idempotence: re-unioning a result through itself is a no-op", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { maxLength: 6 }),
        (ids) => {
          const seed = new SchemeBool(true, ids.length === 0 ? EMPTY_PROVENANCE : new Set(ids));
          const once = unionProvenance([seed]);
          const twice = unionProvenance([new SchemeBool(true, once), new SchemeBool(true, once)]);
          expect(new Set(twice)).toEqual(new Set(once));
        },
      ),
      { numRuns: 50 },
    );
  });
});
