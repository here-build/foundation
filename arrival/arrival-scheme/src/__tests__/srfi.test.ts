// SRFI libraries added to bootstrap.ts (2026-06-11): SRFI-1 (lists), SRFI-43
// (vectors, pure ops only — arrival is immutable), SRFI-189 (Maybe/Either),
// SRFI-128 (comparators, no hash). All are pure procedures (no macros → no
// matcher dependency). These assert the surface behaves; the drafting horde
// exec-verified each proc, this is the committed floor.
import { describe, expect, it } from "vitest";
import { exec } from "../generator-exec.js";

async function run(src: string): Promise<string> {
  const r = await exec(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("SRFI-1 — list library", () => {
  it("take-while / drop-while", async () => {
    expect(await run("(take-while even? '(2 4 6 1 8))")).toBe("(2 4 6)");
    expect(await run("(drop-while even? '(2 4 6 1 8))")).toBe("(1 8)");
  });
  it("partition returns two values", async () => {
    expect(await run("(call-with-values (lambda () (partition even? '(1 2 3 4 5 6))) list)")).toBe(
      "((2 4 6) (1 3 5))",
    );
  });
  it("span / break", async () => {
    expect(await run("(call-with-values (lambda () (span even? '(2 4 1 3))) list)")).toBe("((2 4) (1 3))");
    expect(await run("(call-with-values (lambda () (break odd? '(2 4 1 3))) list)")).toBe("((2 4) (1 3))");
  });
  it("last / last-pair / find-tail", async () => {
    expect(await run("(last '(1 2 3))")).toBe("3");
    expect(await run("(find-tail even? '(1 3 4 5))")).toBe("(4 5)");
    expect(await run("(find-tail even? '(1 3 5))")).toBe("#f");
  });
  it("fold-right / reduce-right / concatenate / list-tabulate / delete / length+", async () => {
    expect(await run("(fold-right cons '() '(1 2 3))")).toBe("(1 2 3)");
    expect(await run("(reduce-right + 0 '(1 2 3 4))")).toBe("10");
    expect(await run("(concatenate '((1 2) (3) (4 5)))")).toBe("(1 2 3 4 5)");
    expect(await run("(list-tabulate 4 (lambda (i) (* i i)))")).toBe("(0 1 4 9)");
    expect(await run("(delete 2 '(1 2 3 2 4))")).toBe("(1 3 4)");
    expect(await run("(length+ '(1 2 3 4))")).toBe("4");
  });
});

describe("SRFI-43 — vector library (pure)", () => {
  it("vector-fold / vector-fold-right", async () => {
    expect(await run("(vector-fold + 0 #(1 2 3 4))")).toBe("10");
    expect(await run("(vector-fold-right + 0 #(1 2 3 4))")).toBe("10");
  });
  // NB: arrival predicate builtins (=, eq?, pair?, null?, …) return JS booleans
  // (stringify "true"/"false"), so these SRFI predicates — which end in a bare
  // predicate call — are consistent with that, not "#t"/"#f". (The SRFI-128
  // chain procs below DO return "#t"/"#f" because %chain-rel wraps in literals.)
  it("vector-count / vector-index / vector-empty?", async () => {
    expect(await run("(vector-count even? #(1 2 3 4))")).toBe("2");
    expect(await run("(vector-index odd? #(2 4 5 6))")).toBe("2");
    expect(await run("(vector-empty? #())")).toBe("true");
  });
  it("vector-any / vector-every", async () => {
    expect(await run("(vector-any even? #(1 3 4))")).toBe("true");
    expect(await run("(vector-every even? #(2 4 6))")).toBe("true");
    // failure path returns the literal #f (success returns the JS-boolean pred result)
    expect(await run("(vector-every even? #(2 4 5))")).toBe("#f");
  });
});

describe("SRFI-189 — Maybe & Either", () => {
  it("Maybe monadic bind short-circuits on Nothing", async () => {
    expect(await run("(maybe-bind (just 5) (lambda (x) (just (* x x))))")).toBe("(just 25)");
    expect(await run("(maybe-bind (nothing) (lambda (x) (just x)))")).toBe("(nothing)");
  });
  it("maybe-ref/default", async () => {
    expect(await run("(maybe-ref/default (just 7) 0)")).toBe("7");
    expect(await run("(maybe-ref/default (nothing) 0)")).toBe("0");
  });
  it("Either map/bind short-circuits on Left", async () => {
    expect(await run("(either-map (lambda (x) (+ x 1)) (right 4))")).toBe("(right 5)");
    expect(await run("(either-bind (left 'err) (lambda (x) (right x)))")).toBe("(left err)");
  });
  it("predicates", async () => {
    expect(await run("(just? (just 1))")).toBe("true");
    expect(await run("(maybe? (nothing))")).toBe("true");
    expect(await run("(either? (left 1))")).toBe("true");
  });
});

describe("SRFI-8 receive + SRFI-2 and-let* (expression macros)", () => {
  // Single-sourced from env/srfi/srfi-8.ts + srfi-2.ts as `define-macro` forms
  // (unified off the old `define-syntax`/syntax-rules twins so one definition
  // serves both the full env and the sandbox). let-values / let*-values are
  // sibling define-macro forms. Definition macros (define-record-type /
  // define-values) stay BLOCKED on a separate gap: macro-introduced
  // (begin (define …)) doesn't splice into the enclosing scope.
  it("receive binds the values of a producer", async () => {
    expect(await run("(receive (a b) (values 1 2) (list a b))")).toBe("(1 2)");
    expect(await run("(receive (a . rest) (values 1 2 3) (list a rest))")).toBe("(1 (2 3))");
  });
  it("and-let* binds + short-circuits", async () => {
    expect(await run("(and-let* ((x 5) (y (* x 2))) (+ x y))")).toBe("15");
    expect(await run("(and-let* ((x #f)) x)")).toBe("#f");
  });
  it("and-let* guard clause (claw shape discriminated in the macro body)", async () => {
    expect(await run("(and-let* ((x 3) ((> x 0))) (* x 10))")).toBe("30");
    expect(await run("(and-let* ((x 3) ((< x 0))) (* x 10))")).toBe("#f");
  });
});

describe("SRFI-128 — comparators (no hash)", () => {
  it("default-comparator ordering + chaining", async () => {
    expect(await run("(<? (default-comparator) 1 2)")).toBe("#t");
    expect(await run("(>? (default-comparator) 3 2 1)")).toBe("#t");
    expect(await run("(<=? (default-comparator) 1 1 2)")).toBe("#t");
    expect(await run("(=? (default-comparator) \"a\" \"a\")")).toBe("#t");
  });
  it("cross-type total order (number ranks before string)", async () => {
    expect(await run("(<? (default-comparator) 1 \"a\")")).toBe("#t");
  });
  it("comparator-hashable? is always #f (arrival has no value-hash)", async () => {
    expect(await run("(comparator-hashable? (default-comparator))")).toBe("#f");
  });
});
