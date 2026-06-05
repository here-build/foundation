/**
 * The run-view (`target: "run"`): async/await threading + ax-wired inference. The
 * whole-program shape is the `fixtures/gepa.run.js` golden (see gepa.test.ts);
 * these are the focused per-behavior units.
 */
import { describe, expect, it } from "vitest";
import { projectToJs } from "../project.js";

const run = (src: string) => projectToJs(src, { target: "run" });

describe("run-view (async + ax)", () => {
  it("a fn reaching infer is async; a pure fn stays sync", async () => {
    const out = await run('(define rp (require "p.prompt"))\n(define (ask i) (rp i))\n(define (pure x) (+ x 1))');
    expect(out).toContain("const ask = async (i) =>");
    expect(out).toContain("const pure = (x) => x + 1;");
  });

  it("an inference call awaits + takes only the inputs object (cache-key dropped)", async () => {
    const out = await run('(define rp (require "p.prompt"))\n(define (ask i x) (rp (list i x) :instruction i :input x))');
    expect(out).toContain("await rp({ instruction: i, input: x })");
  });

  it("a map over an async fn → await Promise.all", async () => {
    const out = await run('(define rp (require "p.prompt"))\n(define (one x) (rp x))\n(define (go xs) (map one xs))');
    expect(out).toContain("await Promise.all(xs.map(one))");
  });

  it("a call to a function-valued param is awaited (higher-order)", async () => {
    expect(await run("(define (iterate step pool) (step pool))")).toContain("await step(pool)");
  });

  it("an awaited receiver is parenthesized before a member access", async () => {
    const out = await run('(define rp (require "p.prompt"))\n(define (a xs) (rp xs))\n(define (b xs) (apply + (a xs)))');
    expect(out).toContain("(await a(xs)).reduce(");
  });
});
