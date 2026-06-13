import { describe, expect, it } from "vitest";

import { extractDefines } from "../extract-defines.js";

describe("extractDefines", () => {
  it("returns [] for empty / whitespace source", async () => {
    expect(await extractDefines("")).toEqual([]);
    expect(await extractDefines("   \n\n")).toEqual([]);
  });

  it("returns [] for unparseable source", async () => {
    expect(await extractDefines("(this is not (balanced")).toEqual([]);
  });

  it("recognises (define (name args…) body) as a function with arity", async () => {
    const defines = await extractDefines(`(define (greet who) (string-append "hi " who))`);
    expect(defines).toMatchObject([{ name: "greet", kind: "function", arity: 1, variadic: false }]);
  });

  it("recognises (define name (lambda (args…) body)) as a function", async () => {
    const defines = await extractDefines(`(define greet (lambda (who) "hi"))`);
    expect(defines).toMatchObject([{ name: "greet", kind: "function", arity: 1, variadic: false }]);
  });

  it("recognises (define name value) as a constant", async () => {
    const defines = await extractDefines(`(define answer 42)`);
    expect(defines).toMatchObject([{ name: "answer", kind: "constant" }]);
    expect(defines[0]!.arity).toBeUndefined();
  });

  it("captures arity for multi-arg functions", async () => {
    const defines = await extractDefines(`(define (add a b c) (+ a b c))`);
    expect(defines[0]).toMatchObject({ name: "add", kind: "function", arity: 3, variadic: false });
  });

  it("captures zero-arg functions (thunks)", async () => {
    const defines = await extractDefines(`(define (now) 0)`);
    expect(defines[0]).toMatchObject({ name: "now", kind: "function", arity: 0, variadic: false });
  });

  it("flags variadic functions via dotted tail", async () => {
    const defines = await extractDefines(`(define (sum-all . xs) (apply + xs))`);
    expect(defines[0]).toMatchObject({ name: "sum-all", kind: "function", arity: 0, variadic: true });
  });

  it("enumerates multiple top-level defines in order", async () => {
    const defines = await extractDefines(`
      (define pi 3.14)
      (define (square x) (* x x))
      (define (cube x) (* x x x))
    `);
    expect(defines.map((d) => d.name)).toEqual(["pi", "square", "cube"]);
    expect(defines.map((d) => d.kind)).toEqual(["constant", "function", "function"]);
  });

  it("ignores nested defines inside other forms", async () => {
    const defines = await extractDefines(`
      (define (outer x)
        (define inner-detail 1)
        (+ x inner-detail))
    `);
    expect(defines.map((d) => d.name)).toEqual(["outer"]);
  });

  it("ignores non-define top-level forms", async () => {
    const defines = await extractDefines(`
      (define x 1)
      (+ x x)
      (display "hello")
    `);
    expect(defines.map((d) => d.name)).toEqual(["x"]);
  });

  it("attaches a source location to each define", async () => {
    const defines = await extractDefines(`(define (f x) x)\n(define (g x) x)`);
    expect(defines[0]!.location).toBeDefined();
    expect(defines[1]!.location).toBeDefined();
    expect(defines[0]!.location!.offset).toBeLessThan(defines[1]!.location!.offset);
  });
});
