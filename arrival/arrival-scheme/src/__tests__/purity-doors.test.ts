// The purity pass (docs/plan-2026-06-11-purity-pass.md): arrival is pure
// dataflow — DYNAMICS and WRITING METHODS are omitted by design, each replaced
// with a teaching `errors-as-doors` throw (PurityError) rather than a bare
// "Unbound variable" / "Not callable". These tests pin the doors: the feature
// must NOT silently work, and the error must name the feature + route to an
// alternative.
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec";
import { PurityError } from "../purity.js";

// The evaluator wraps a thrown error in SchemeError (stack trace) but preserves
// the message and chains the original as `.cause`. A door is "fired" if the
// PurityError surfaces either directly or through the cause chain.
const door = async (src: string): Promise<{ purity: boolean; message: string }> => {
  try {
    await exec(src);
  } catch (e) {
    const direct = e instanceof PurityError;
    const viaCause = (e as { cause?: unknown })?.cause instanceof PurityError;
    return { purity: direct || viaCause, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected a purity door for: ${src}`);
};

describe("purity doors — dynamics are omitted", () => {
  for (const [name, src] of [
    ["call/cc", "(call/cc (lambda (k) (k 1)))"],
    ["call-with-current-continuation", "(call-with-current-continuation (lambda (k) (k 1)))"],
    ["dynamic-wind", "(dynamic-wind (lambda () 1) (lambda () 2) (lambda () 3))"],
    ["make-parameter", "(make-parameter 10)"],
    ["parameterize", "(parameterize () 1)"],
    ["delay", "(delay 1)"],
    ["force", "(force 1)"],
    ["make-promise", "(make-promise 1)"],
    ["delay-force", "(delay-force (delay 1))"],
  ] as const) {
    it(`${name} → purity door`, async () => {
      const { purity, message } = await door(src);
      expect(purity).toBe(true);
      expect(message).toMatch(/omitted from arrival by design/);
    });
  }
});

describe("purity doors — writing methods are omitted (entities frozen)", () => {
  for (const [name, src] of [
    ["set-car!", "(set-car! (list 1 2) 9)"],
    ["set-cdr!", "(set-cdr! (list 1 2) 9)"],
    ["vector-set!", "(vector-set! (vector 1 2 3) 0 9)"],
    ["vector-fill!", "(vector-fill! (vector 1 2 3) 0)"],
    ["vector-copy!", "(vector-copy! (vector 1 2 3) 0 (vector 4 5 6))"],
    ["string-set!", '(string-set! (string #\\a #\\b) 0 #\\z)'],
    ["string-fill!", '(string-fill! (string #\\a #\\b) #\\z)'],
    ["bytevector-u8-set!", "(bytevector-u8-set! (bytevector 1 2 3) 0 9)"],
    ["bytevector-copy!", "(bytevector-copy! (bytevector 1 2 3) 0 (bytevector 4 5 6))"],
  ] as const) {
    it(`${name} → purity door`, async () => {
      const { purity, message } = await door(src);
      expect(purity).toBe(true);
      expect(message).toMatch(/frozen by design|construct a new value/);
    });
  }
});

describe("purity doors — non-mutating copies still WORK (return fresh values)", () => {
  it("vector-copy returns a fresh vector", async () => {
    expect(await exec("(vector->list (vector-copy (vector 1 2 3)))")).toBeDefined();
  });
  it("bytevector-copy returns a fresh bytevector", async () => {
    expect(await exec("(bytevector-copy (bytevector 1 2 3))")).toBeDefined();
  });
});
