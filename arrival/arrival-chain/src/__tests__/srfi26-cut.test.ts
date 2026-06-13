/**
 * SRFI-26 `cut` / `cute` work in the sandbox.
 *
 * They're define-macros in the bootstrap (the sandbox-working macro path —
 * see sandbox-user-macros.test.ts) copied into sandboxedEnv by initBridge, plus
 * gensym for capture-safe slot names. `<>` is a positional slot, `<...>` a final
 * rest slot. The whole point of the spec is the cut/cute distinction: cut leaves
 * non-slot subexpressions in the lambda body (re-evaluated per call), cute lifts
 * them into a let (evaluated once at specialization) — the last test pins that.
 */
import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";

const router = () => singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "x" })) });
const run = (scm: string) => runPipeline({ files: { "main.scm": scm }, entry: "main.scm", router: router() });

describe("SRFI-26 cut / cute in the sandbox", () => {
  it("cut fills a positional slot", async () => {
    expect(await run("((cut * 2 <>) 21)")).toBe(42);
  });

  it("cut fills multiple slots, left to right", async () => {
    expect(await run("((cut + 1 <> <>) 10 20)")).toBe(31);
  });

  it("cut can slot the operator position", async () => {
    expect(await run("((cut <> 2 3) +)")).toBe(5);
  });

  it("cut maps point-free over a list", async () => {
    expect(await run("(map (cut * 10 <>) (list 1 2 3))")).toEqual([10, 20, 30]);
  });

  it("cut <...> captures a final rest slot", async () => {
    expect(await run("(apply (cut list 1 <...>) (list 2 3 4))")).toEqual([1, 2, 3, 4]);
  });

  it("cut re-evaluates non-slot exprs on every call", async () => {
    // the (set! n …) sits in the lambda body, so it runs once per application
    expect(
      await run(`
        (define n 0)
        (define f (cut + (begin (set! n (+ n 1)) 100) <>))
        (f 1) (f 2)
        n`),
    ).toBe(2);
  });

  it("cute evaluates non-slot exprs once at specialization", async () => {
    // cute lifts (begin (set! n …) 100) into a let, so it runs once when `g` is built
    expect(
      await run(`
        (define n 0)
        (define g (cute + (begin (set! n (+ n 1)) 100) <>))
        (g 1) (g 2)
        n`),
    ).toBe(1);
  });
});
