/**
 * AST shape detection — verifies the pattern-match catches each high-frequency
 * scheme form. Combined with the live trace, the detector produces the
 * semantic-collapse layer for trace visualization.
 */
import { parseGenerator } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import { detectShape, isTailRecursive, type Shape } from "../ast-shapes.js";

const parseFirst = async (src: string): Promise<unknown> => {
  const forms = await parseGenerator(src);
  return forms[0];
};

describe("detectShape", () => {
  it("recognises (map …) as a parallel-iteration HOF", async () => {
    const form = await parseFirst(`(map (lambda (x) (* x 2)) '(1 2 3))`);
    const shape = detectShape(form);
    expect(shape.kind).toBe("map");
    expect((shape as Extract<Shape, { kind: "map" }>).head).toBe("map");
  });

  it("recognises (filter …) and (for-each …) under the same kind=map", async () => {
    expect(detectShape(await parseFirst(`(filter odd? '(1 2 3))`)).kind).toBe("map");
    expect(detectShape(await parseFirst(`(for-each display '(1 2 3))`)).kind).toBe("map");
  });

  it("recognises (reduce …) as a fold", async () => {
    const form = await parseFirst(`(reduce + 0 '(1 2 3))`);
    const shape = detectShape(form);
    expect(shape.kind).toBe("fold");
    expect((shape as Extract<Shape, { kind: "fold" }>).head).toBe("reduce");
  });

  it("recognises (if …) / (cond …) / (when …) as branch", async () => {
    expect(detectShape(await parseFirst(`(if #t 1 2)`)).kind).toBe("branch");
    expect(detectShape(await parseFirst(`(cond ((> 1 0) 'pos) (else 'neg))`)).kind).toBe("branch");
    expect(detectShape(await parseFirst(`(when #t 1)`)).kind).toBe("branch");
  });

  it("recognises named (let loop …) as a loop shape", async () => {
    const form = await parseFirst(`(let loop ((n 10)) (if (= n 0) 'done (loop (- n 1))))`);
    const shape = detectShape(form);
    expect(shape.kind).toBe("loop-named-let");
    if (shape.kind === "loop-named-let") {
      expect(shape.loopName).toBe("loop");
      expect(shape.bindings.length).toBe(1);
    }
  });

  it("recognises (begin …) / (and …) / (or …) as sequences", async () => {
    expect(detectShape(await parseFirst(`(begin 1 2 3)`)).kind).toBe("sequence");
    expect(detectShape(await parseFirst(`(and a b c)`)).kind).toBe("sequence");
    expect(detectShape(await parseFirst(`(or a b c)`)).kind).toBe("sequence");
  });

  it("recognises (infer …) as an inference call", async () => {
    const shape = detectShape(await parseFirst(`(infer "fast" "hello")`));
    expect(shape.kind).toBe("infer");
  });

  it("recognises (define (f …) …) and extracts the name", async () => {
    const shape = detectShape(await parseFirst(`(define (greet name) (string-append "hi " name))`));
    expect(shape.kind).toBe("define");
    if (shape.kind === "define") expect(shape.name).toBe("greet");
  });

  it("falls through to atomic for unknown forms", async () => {
    expect(detectShape(await parseFirst(`(+ 1 2)`)).kind).toBe("atomic");
    expect(detectShape(await parseFirst(`'(1 2 3)`)).kind).toBe("atomic");
    expect(detectShape("just-a-symbol" as unknown).kind).toBe("atomic"); // strings aren't pairs
  });
});

describe("isTailRecursive", () => {
  it("detects (define (loop n) (if … (loop (- n 1)))) as tail-recursive", async () => {
    const form = await parseFirst(
      `(define (loop n) (if (= n 0) 'done (loop (- n 1))))`,
    );
    const shape = detectShape(form);
    expect(shape.kind).toBe("define");
    if (shape.kind !== "define" || !shape.name) throw new Error("expected define");
    expect(isTailRecursive(shape.name, shape.body)).toBe(true);
  });

  it("rejects non-tail recursion (recursive call inside an operator arg)", async () => {
    const form = await parseFirst(
      `(define (sum n) (if (= n 0) 0 (+ n (sum (- n 1)))))`,
    );
    const shape = detectShape(form);
    if (shape.kind !== "define" || !shape.name) throw new Error("expected define");
    // `(+ n (sum …))` — `sum` is not in tail position because `+` consumes it.
    expect(isTailRecursive(shape.name, shape.body)).toBe(false);
  });

  it("detects tail recursion through cond clauses", async () => {
    const form = await parseFirst(
      `(define (walk x) (cond ((null? x) 'done) (else (walk (cdr x)))))`,
    );
    const shape = detectShape(form);
    if (shape.kind !== "define" || !shape.name) throw new Error("expected define");
    expect(isTailRecursive(shape.name, shape.body)).toBe(true);
  });
});
