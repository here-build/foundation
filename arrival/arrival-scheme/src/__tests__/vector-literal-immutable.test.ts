// Caveat-sweep finding (2026-06-11): R7RS vector/bytevector LITERALS (#(...),
// #u8(...)) are immutable, but boxing did not freeze them — so (vector-set! on a
// literal silently succeeds AND mutates the shared parsed AST node, persisting
// across evaluations (string literals ARE frozen, utils/parsing.ts). CONSTRUCTED
// vectors ((vector …)/make-vector) must stay mutable.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const run = async (form: string) => String((await exec(form, env) as unknown[])[0]);

describe("vector/bytevector literal immutability (R7RS)", () => {
  it("mutating a vector literal is an error", async () => {
    await expect(run(`(vector-set! #(1 2 3) 0 9)`)).rejects.toThrow();
  });
  it("mutating a quoted vector literal is an error", async () => {
    await expect(run(`(vector-fill! '#(1 2 3) 0)`)).rejects.toThrow();
  });
  it("mutating a bytevector literal is an error", async () => {
    await expect(run(`(bytevector-u8-set! #u8(1 2 3) 0 9)`)).rejects.toThrow();
  });

  it("a CONSTRUCTED vector stays mutable", async () => {
    expect(await run(`(let ((v (vector 1 2 3))) (vector-set! v 0 9) (vector-ref v 0))`)).toBe("9");
  });
  it("make-vector stays mutable", async () => {
    expect(await run(`(let ((v (make-vector 2 0))) (vector-fill! v 7) (vector-ref v 1))`)).toBe("7");
  });
  it("a CONSTRUCTED bytevector stays mutable", async () => {
    expect(await run(`(let ((b (make-bytevector 2 0))) (bytevector-u8-set! b 0 5) (bytevector-u8-ref b 0))`)).toBe("5");
  });
  it("reading a literal is fine", async () => {
    expect(await run(`(vector-ref #(7 8 9) 1)`)).toBe("8");
  });
});
