// Caveat-sweep finding (2026-06-11): boxing vectors broke structuralEqual's
// documented cycle-safety. The fantasy-land/equals hook (structural-equal.ts:43)
// fires BEFORE the occurs-check seeds `seen` (line ~56), and SchemeVector's hook
// recurses through structuralEqual with a FRESH empty seen-map per call — so
// mutually-cyclic vectors recurse forever and blow the JS stack ("Maximum call
// stack size exceeded"). self-vs-self is hidden by the a===b shortcut.
// The walker's contract (war story in structural-equal.ts): cycles terminate
// co-inductively; never throws a native error.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const run = async (form: string) => (await exec(form, env) as unknown[])[0];

describe("equal? on cyclic vectors terminates (cycle-safety regression)", () => {
  it("two mutually-cyclic DISTINCT vectors compare equal co-inductively, no stack blow", async () => {
    // a[0]=b, b[0]=a — distinct vectors, each pointing at the other.
    const out = await run(
      `(let ((a (make-vector 1 0)) (b (make-vector 1 0)))
         (vector-set! a 0 b)
         (vector-set! b 0 a)
         (equal? a b))`,
    );
    expect(String(out)).toBe("true");
  });

  it("a self-cyclic vector vs a structurally-equal self-cyclic vector terminates", async () => {
    const out = await run(
      `(let ((a (make-vector 2 1)) (b (make-vector 2 1)))
         (vector-set! a 1 a)
         (vector-set! b 1 b)
         (equal? a b))`,
    );
    expect(String(out)).toBe("true");
  });

  it("acyclic vector inequality still works", async () => {
    expect(String(await run(`(equal? (vector 1 2) (vector 1 3))`))).toBe("false");
  });
});
