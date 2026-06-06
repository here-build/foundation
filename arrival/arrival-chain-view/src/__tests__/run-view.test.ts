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

  it("a map over a `cut` of an async fn → await Promise.all, and the caller goes async", async () => {
    // `cut` is desugared to a lambda BEFORE the async analysis, so the async taint + the
    // Promise.all wrapping fall out of the normal lambda machinery (the bug was: cut lowered
    // late → invisible to the analysis → `xs.map(async …)` leaking an array of Promises).
    const out = await run('(define rp (require "p.prompt"))\n(define (one x y) (rp x))\n(define (go xs) (map (cut one <> 0) xs))');
    expect(out).toContain("const go = async (xs) =>");
    expect(out).toContain("await Promise.all(xs.map(async (it) => await one(it, 0)))");
  });

  it("a call to a function-valued param is awaited (higher-order)", async () => {
    expect(await run("(define (iterate step pool) (step pool))")).toContain("await step(pool)");
  });

  it("an awaited receiver is parenthesized before a member access", async () => {
    const out = await run('(define rp (require "p.prompt"))\n(define (a xs) (rp xs))\n(define (b xs) (apply + (a xs)))');
    expect(out).toContain("(await a(xs)).reduce(");
  });
});
