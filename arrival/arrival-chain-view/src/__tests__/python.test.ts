/**
 * The Python language backend: idiomatic Python via comprehensions, `max(key=)`,
 * `zip`, dict subscript, ternaries, snake_case. (The whole-program shape is the
 * fixtures/gepa.py golden — see gepa.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { projectToPy, pyName } from "../python.js";

const p = (src: string) => projectToPy(src);

describe("python emitter", () => {
  it("snake_cases names, drops predicate ?", () => {
    expect(pyName("run-predict")).toBe("run_predict");
    expect(pyName("dominates?")).toBe("dominates");
    expect(pyName("string->list")).toBe("string_to_list");
  });

  it("define → def with a single return", () => {
    expect(p("(define (add a b) (+ a b))")).toContain("def add(a, b):\n    return (a + b)");
  });

  it("map → list comprehension; accessor → dict subscript", () => {
    expect(p("(define (f xs) (map (lambda (x) (:id x)) xs))")).toContain('[x["id"] for x in xs]');
  });

  it("filter → comprehension with an `if` guard", () => {
    expect(p("(define (f xs) (filter (lambda (x) (keep? x)) xs))")).toContain("[x for x in xs if keep(x)]");
  });

  it("dict → python dict; if → ternary", () => {
    expect(p("(define (f a) (dict :k a))")).toContain('{"k": a}');
    expect(p("(define (f n) (if (zero? n) 1 0))")).toContain("(1 if n == 0 else 0)");
  });

  it("max-by → max(key=lambda …); apply + → sum", () => {
    expect(p("(define (f xs) (max-by (lambda (c) (apply + (:scores c))) xs))")).toContain(
      'max(xs, key=lambda c: sum(c["scores"]))',
    );
  });

  it("multi-list every → all over zip", () => {
    expect(p("(define (f a b) (every >= (:scores a) (:scores b)))")).toContain(
      'all(_a >= _b for _a, _b in zip(a["scores"], b["scores"]))',
    );
  });

  it("string-ci=? → .lower() compare", () => {
    expect(p("(define (m a b) (if (string-ci=? a b) 1 0))")).toContain("a.lower() == b.lower()");
  });
});
