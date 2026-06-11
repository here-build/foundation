// Regression guards for the defused boolean landmines (commit 9dbf6f719) — and
// the complement async-fix that the first version of these tests surfaced.
//
// Each test passes a predicate that returns a *boxed* SchemeBool (`#t`/`#f`
// literals are schemeTrue/schemeFalse) into a HOF whose result-check was a raw
// truthiness test. A boxed SchemeBool(false) is a TRUTHY JS object, so a raw
// `x && …` / `!x` would keep/negate it wrong — these tests FAIL if a defuse is
// reverted to `=== false`/`!`. They are also the acceptance criteria for the
// later step (boxing all predicate/comparison returns to SchemeBool): when that
// lands, EVERY predicate produces these SchemeBools, and these stay green.
import { describe, expect, it } from "vitest";
import { exec } from "../generator-exec.js";

async function run(src: string): Promise<string> {
  const r = await exec(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

// a predicate that yields a genuine SchemeBool (not a raw JS boolean)
const SB = "(lambda (x) (if (> x 1) #t #f))"; // #t for >1, #f otherwise
const EVEN_SB = "(lambda (x) (if (even? x) #t #f))";

describe("boolean landmine — find/filter (stdlib, THE documented landmine)", () => {
  it("filter EXCLUDES elements whose SchemeBool predicate is #f", async () => {
    expect(await run(`(filter ${SB} '(1 2 3))`)).toBe("(2 3)"); // raw `&&` would keep 1
  });
  it("find returns the first match under a SchemeBool predicate", async () => {
    expect(await run(`(find ${EVEN_SB} '(1 2 3 4))`)).toBe("2");
  });
  it("find returns nil when the SchemeBool predicate is #f for all (arrival not-found = ())", async () => {
    expect(await run(`(find (lambda (x) #f) '(1 2 3))`)).toBe("()");
  });
});

describe("boolean landmine — complement (bridge): async + boxed-bool", () => {
  it("complement of a SchemeBool scheme-lambda predicate, through filter", async () => {
    // exercises BOTH: the scheme-lambda Promise (unpromise) AND the boxed-bool
    // negation (is_false, not `!`). Plain `!fn(...)` returned (), this returns (1 3).
    expect(await run(`(filter (complement ${EVEN_SB}) '(1 2 3 4))`)).toBe("(1 3)");
  });
  it("complement still works for a native predicate", async () => {
    expect(await run("(filter (complement even?) '(1 2 3 4))")).toBe("(1 3)");
  });
  it("complement applied directly to a SchemeBool predicate is truthy when the inner is #f", async () => {
    expect(await run(`(if ((complement ${EVEN_SB}) 1) 'odd 'even)`)).toBe("odd");
  });
});

describe("boolean landmine — not / is_false honor SchemeBool", () => {
  it("not of a SchemeBool predicate result", async () => {
    // `not` routes through is_false (handles SchemeBool(false)) but currently
    // RETURNS a raw JS boolean — it's itself part of the predicate-flip surface,
    // so this is "true"/"false" today and becomes "#t"/"#f" once predicates box.
    expect(await run(`(not (${EVEN_SB} 1))`)).toBe("true"); // (even? 1)→#f, not #f → true
    expect(await run(`(not (${EVEN_SB} 2))`)).toBe("false");
  });
  it("if/cond treat a SchemeBool(false) as falsy", async () => {
    expect(await run(`(if (${EVEN_SB} 1) 'yes 'no)`)).toBe("no");
  });
});

describe("boolean landmine — member/assoc (bridge): guard the cmp defuse", () => {
  // Default cmp is equal? (raw bool today, SchemeBool post-flip). These pin the
  // baseline so a reverted defuse surfaces once equal? boxes.
  it("member finds by equal?", async () => {
    expect(await run("(member 2 '(1 2 3))")).toBe("(2 3)");
  });
  it("assoc finds the pair by key", async () => {
    expect(await run("(assoc 'b '((a . 1) (b . 2)))")).toBe("(b . 2)");
  });
});
