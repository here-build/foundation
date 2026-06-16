// Caveat-sweep finding (2026-06-11): R7RS vector/bytevector LITERALS were not
// frozen by boxing, so vector-set! on a literal silently mutated the shared AST.
//
// PURITY RE-BASELINE (2026-06-11): the purity invariant makes EVERY entity frozen
// by design, so the old literal-vs-constructed mutability split DISSOLVES — there
// is no mutable vector/bytevector to distinguish. All in-place mutators
// (vector-set!/fill!, bytevector-u8-set!, …) are OMITTED and doored (the typed
// throw lives in purity-doors.test.ts). Here we pin the UNIFICATION: literal AND
// constructed vectors/bytevectors are equally immutable, and reads still work.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const run = async (form: string) => String((await exec(form, env) as unknown[])[0]);

describe("vectors/bytevectors are immutable regardless of origin (purity invariant)", () => {
  it("mutating a vector literal is a door", async () => {
    await expect(run(`(vector-set! #(1 2 3) 0 9)`)).rejects.toThrow(/omitted from arrival|frozen/i);
  });
  it("mutating a CONSTRUCTED vector is the same door — the old 'stays mutable' split is gone", async () => {
    await expect(run(`(let ((v (vector 1 2 3))) (vector-set! v 0 9) v)`)).rejects.toThrow(/omitted from arrival|frozen/i);
  });
  it("make-vector is immutable too (vector-fill! doored)", async () => {
    await expect(run(`(let ((v (make-vector 2 0))) (vector-fill! v 7) v)`)).rejects.toThrow(/omitted from arrival|frozen/i);
  });
  it("a CONSTRUCTED bytevector is immutable too (bytevector-u8-set! doored)", async () => {
    await expect(run(`(let ((b (make-bytevector 2 0))) (bytevector-u8-set! b 0 5) b)`)).rejects.toThrow(/omitted from arrival|frozen/i);
  });

  it("reading a literal vector is fine", async () => {
    expect(await run(`(vector-ref #(7 8 9) 1)`)).toBe("8");
  });
  it("reading a constructed vector is fine", async () => {
    expect(await run(`(vector-ref (vector 7 8 9) 0)`)).toBe("7");
  });
  it("non-mutating construction (vector-copy / vector-map) still works", async () => {
    expect(await run(`(vector-ref (vector-map (lambda (x) (* x 2)) (vector 1 2 3)) 2)`)).toBe("6");
  });
});
