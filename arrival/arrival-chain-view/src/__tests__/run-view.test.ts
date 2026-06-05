/**
 * The run-view (`target: "run"`): async/await threading + ax-wired inference, the
 * runnable twin of the legible read-view.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectToJs } from "../project.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (n: string) => readFileSync(fixtureDir + n, "utf8");
const requireSource = (p: string): string | undefined => {
  try {
    return read(p);
  } catch {
    return undefined;
  }
};
const run = (src: string) => projectToJs(src, { target: "run", requireSource });

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

  it("gepa run-view: async cascade + Promise.all + top-level await", async () => {
    const out = await run(read("gepa.scm"));
    expect(out).toContain("const evaluate = async (instruction) =>");
    expect(out).toContain("await Promise.all(");
    expect(out).toContain("examples.map(async (ex) => metric(await ask("); // async map callback
    expect(out).toContain("const failing = (candidate) =>"); // pure → stays sync
    expect(out).toContain("await iterate(generation,");
    expect(out).toContain("await gepa(seed, 4);"); // top-level await
    expect(out).not.toContain("await metric"); // metric is a sync import — not over-awaited
  });

  it("the read-view stays fully synchronous (no async/await leak)", async () => {
    const out = await projectToJs(read("gepa.scm"), { requireSource }); // default target: read
    expect(out).not.toContain("async");
    expect(out).not.toContain("await");
  });
});
