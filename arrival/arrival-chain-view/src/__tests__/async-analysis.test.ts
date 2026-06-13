/**
 * The run-view's async taint analysis: which `define`d functions must be `async`
 * because they transitively reach a `.prompt` inference call.
 */
import { parseSexprs } from "@here.build/arrival-sweet";
import { describe, expect, it } from "vitest";
import { computeAsyncNames, inferPrimitives } from "../async-analysis.js";

const analyze = (src: string) => {
  const forest = parseSexprs(src);
  const reqs = inferPrimitives(forest);
  return { reqs, asyncNames: computeAsyncNames(forest, reqs) };
};

describe("async taint analysis", () => {
  it("a .prompt require is an inference primitive", () => {
    expect([...analyze('(define ask (require "x.prompt"))').reqs]).toEqual(["ask"]);
  });

  it("a non-.prompt require is not", () => {
    expect([...analyze('(define data (require "x.json"))').reqs]).toEqual([]);
  });

  it("a fn calling infer is async; a pure fn is not", () => {
    const { asyncNames } = analyze(`
      (define gen (require "g.prompt"))
      (define (a x) (gen x))
      (define (pure x) (+ x 1))`);
    expect(asyncNames.has("a")).toBe(true);
    expect(asyncNames.has("pure")).toBe(false);
  });

  it("async is transitive across the call graph", () => {
    const { asyncNames } = analyze(`
      (define gen (require "g.prompt"))
      (define (a x) (gen x))
      (define (b x) (a x))
      (define (c x) (b x))`);
    expect(asyncNames.has("c")).toBe(true);
  });

  it("an async fn passed to a higher-order builtin taints the caller", () => {
    const { asyncNames } = analyze(`
      (define gen (require "g.prompt"))
      (define (one x) (gen x))
      (define (run xs) (map one xs))`);
    expect(asyncNames.has("run")).toBe(true); // (map one xs): one is async → run is async
  });

  it("an async fn used inside a lambda taints the caller", () => {
    const { asyncNames } = analyze(`
      (define gen (require "g.prompt"))
      (define (run xs) (map (lambda (x) (gen x)) xs))`);
    expect(asyncNames.has("run")).toBe(true);
  });

  it("a higher-order fn that calls a function-valued parameter is conservatively async", () => {
    const { asyncNames } = analyze(`(define (iterate step pool) (step pool))`);
    expect(asyncNames.has("iterate")).toBe(true);
  });

  it("mirrors gepa: infer-reaching fns async, pure fns sync", () => {
    const { asyncNames } = analyze(`
      (define rp (require "p.prompt"))
      (define (ask i x) (rp i x))
      (define (evaluate i) (map (lambda (ex) (ask i ex)) examples))
      (define (mutate c) (ask c c))
      (define (generation pool) (frontier (map mutate pool)))
      (define (failing c) (map car c))
      (define (dominates a b) (and a b))`);
    for (const a of ["ask", "evaluate", "mutate", "generation"]) expect(asyncNames.has(a)).toBe(true);
    for (const s of ["failing", "dominates"]) expect(asyncNames.has(s)).toBe(false);
  });
});
