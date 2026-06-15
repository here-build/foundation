/**
 * Tests for the generator-based evaluator using real LIPS types
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Environment } from "../Environment";
import run, { exec } from "../evaluator";
// String-based exec with the full default env (provides `=`, `-`, etc.) — used
// only by the tail-call optimization test, which exercises the trampoline's
// cross-`run()` recursion shape and needs real `if`/`=`/`-` rather than the
// minimal hand-rolled `env` above.
import { exec as execSource } from "../generator-exec";
import { SchemeSymbol } from "../values/SchemeSymbol";
import { SchemeExact, SchemeInexact } from "../values/numbers";
import { Pair } from "../values/Pair";
import { nil } from "../values/types";
import { list, num, sym } from "./helpers";

describe("Generator Evaluator with Real LIPS Types", () => {
  let env: Environment;

  beforeEach(() => {
    // Create a minimal environment with basic operations
    // Note: SchemeExact has num/denom (for rationals), not value
    env = new Environment("test-env", {
      "+": (...args: unknown[]) => {
        let result = 0n;
        let hasInexact = false;
        for (const arg of args) {
          if (arg instanceof SchemeExact) {
            result += arg.num;
          } else if (arg instanceof SchemeInexact) {
            hasInexact = true;
            result += BigInt(Math.floor(arg.real));
          } else if (typeof arg === "number") {
            hasInexact = true;
            result += BigInt(Math.floor(arg));
          } else if (typeof arg === "bigint") {
            result += arg;
          }
        }
        return hasInexact ? new SchemeInexact(Number(result)) : new SchemeExact(result);
      },
      "-": (...args: unknown[]) => {
        if (args.length === 0) return new SchemeExact(0n);
        let result = args[0] instanceof SchemeExact ? args[0].num : BigInt(args[0] as number);
        if (args.length === 1) return new SchemeExact(-result);
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          result -= arg instanceof SchemeExact ? arg.num : BigInt(arg as number);
        }
        return new SchemeExact(result);
      },
      "*": (...args: unknown[]) => {
        let result = 1n;
        for (const arg of args) {
          result *= arg instanceof SchemeExact ? arg.num : BigInt(arg as number);
        }
        return new SchemeExact(result);
      },
      "/": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? Number(a.num) : (a as number);
        const bVal = b instanceof SchemeExact ? Number(b.num) : (b as number);
        return new SchemeInexact(aVal / bVal);
      },
      "<": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? a.num : BigInt(a as number);
        const bVal = b instanceof SchemeExact ? b.num : BigInt(b as number);
        return aVal < bVal;
      },
      ">": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? a.num : BigInt(a as number);
        const bVal = b instanceof SchemeExact ? b.num : BigInt(b as number);
        return aVal > bVal;
      },
      "<=": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? a.num : BigInt(a as number);
        const bVal = b instanceof SchemeExact ? b.num : BigInt(b as number);
        return aVal <= bVal;
      },
      ">=": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? a.num : BigInt(a as number);
        const bVal = b instanceof SchemeExact ? b.num : BigInt(b as number);
        return aVal >= bVal;
      },
      "=": (a: unknown, b: unknown) => {
        const aVal = a instanceof SchemeExact ? a.num : BigInt(a as number);
        const bVal = b instanceof SchemeExact ? b.num : BigInt(b as number);
        return aVal === bVal;
      },
      list: (...args: unknown[]) => Pair.fromArray(args, false),
      car: (pair: Pair) => pair.car,
      cdr: (pair: Pair) => pair.cdr,
      cons: (a: unknown, b: unknown) => new Pair(a, b),
      "null?": (x: unknown) => x === nil || (x !== null && typeof x === "object" && (x as Nil).toString?.() === "()"),
      not: (x: unknown) => x === false || x === nil,
      "#t": true,
      "#f": false,
    });
  });

  describe("run() trampoline", () => {
    it("should run a simple generator to completion", async () => {
      function* simple() {
        yield 1;
        yield 2;
        return 3;
      }
      const result = await run(simple());
      expect(result).toBe(3);
    });

    it("should await yielded promises", async () => {
      function* withPromise() {
        const a = yield Promise.resolve(10);
        const b = yield Promise.resolve(20);
        return (a as number) + (b as number);
      }
      const result = await run(withPromise());
      expect(result).toBe(30);
    });

    it("should handle errors from promises", async () => {
      function* withError() {
        yield Promise.reject(new Error("test error"));
        return "should not reach";
      }
      await expect(run(withError())).rejects.toThrow("test error");
    });
  });

  describe("evaluate()", () => {
    it("should evaluate atoms to themselves", async () => {
      expect(await exec(num(42), { env })).toEqual(num(42));
      expect(await exec("hello", { env })).toBe("hello");
      expect(await exec(nil, { env })).toBe(nil);
    });

    it("should look up symbols in environment", async () => {
      env.set("x", num(10));
      env.set("y", num(20));
      expect(await exec(new SchemeSymbol("x"), { env })).toEqual(num(10));
      expect(await exec(new SchemeSymbol("y"), { env })).toEqual(num(20));
    });

    it("should evaluate simple function calls", async () => {
      // (+ 1 2 3)
      const code = list(sym("+"), num(1), num(2), num(3));
      const result = await exec(code, { env });
      expect(result).toEqual(num(6));
    });

    it("should evaluate nested function calls", async () => {
      // (+ (* 2 3) (* 4 5))
      const code = list(sym("+"), list(sym("*"), num(2), num(3)), list(sym("*"), num(4), num(5)));
      const result = await exec(code, { env });
      expect(result).toEqual(num(26)); // 6 + 20
    });

    it("should handle JS functions that return promises", async () => {
      // With membrane, JS functions receive JS values (not SchemeExact)
      env.set("async-add", async (a: number, b: number) => {
        await new Promise((r) => setTimeout(r, 1));
        return a + b;
      });

      const code = list(sym("async-add"), num(10), num(20));
      const result = await exec(code, { env });
      // Result passes through fromJS which keeps numbers as-is
      expect(result).toBe(30);
    });
  });

  describe("special forms", () => {
    describe("quote", () => {
      it("should return its argument unevaluated", async () => {
        // (quote (1 2 3))
        const code = list(sym("quote"), list(num(1), num(2), num(3)));
        const result = (await exec(code, { env })) as Pair;
        expect(result.car).toEqual(num(1));
        expect((result.cdr as Pair).car).toEqual(num(2));
      });

      it("should quote a symbol", async () => {
        // (quote x)
        const code = list(sym("quote"), sym("x"));
        const result = (await exec(code, { env })) as SchemeSymbol;
        expect(result.__name__).toBe("x");
      });
    });

    describe("quasiquote", () => {
      it("should return simple list unevaluated", async () => {
        // `(1 2 3)
        const code = list(sym("quasiquote"), list(num(1), num(2), num(3)));
        const result = (await exec(code, { env })) as Pair;
        expect(result.car).toEqual(num(1));
      });

      it("should evaluate unquoted expressions", async () => {
        // `(1 ,(+ 1 1) 3)
        env.set("x", num(10));
        const code = list(sym("quasiquote"), list(num(1), list(sym("unquote"), sym("x")), num(3)));
        const result = (await exec(code, { env })) as Pair;
        expect(result.car).toEqual(num(1));
        expect((result.cdr as Pair).car).toEqual(num(10));
        expect(((result.cdr as Pair).cdr as Pair).car).toEqual(num(3));
      });

      it("should handle unquote-splicing", async () => {
        // `(1 ,@(list 2 3) 4)
        const code = list(
          sym("quasiquote"),
          list(num(1), list(sym("unquote-splicing"), list(sym("list"), num(2), num(3))), num(4)),
        );
        const result = await exec(code, { env });
        const arr = (result as Pair).to_array();
        expect(arr.length).toBe(4);
      });
    });

    describe("if", () => {
      it("should evaluate then branch when condition is true", async () => {
        // (if #t 1 2)
        const code = list(sym("if"), true, num(1), num(2));
        expect(await exec(code, { env })).toEqual(num(1));
      });

      it("should evaluate else branch when condition is false", async () => {
        // (if #f 1 2)
        const code = list(sym("if"), false, num(1), num(2));
        expect(await exec(code, { env })).toEqual(num(2));
      });

      it("should evaluate then branch when condition is nil (Scheme: only #f is false)", async () => {
        // (if () 1 2) - in R7RS Scheme, only #f is false, () is truthy
        const code = list(sym("if"), nil, num(1), num(2));
        expect(await exec(code, { env })).toEqual(num(1));
      });

      it("should return undefined when no else branch and condition is false", async () => {
        // (if #f 1)
        const code = list(sym("if"), false, num(1));
        expect(await exec(code, { env })).toBe(undefined);
      });

      it("should evaluate nested if expressions", async () => {
        // (if (< 1 2) (if (> 3 2) 100 200) 300)
        const code = list(
          sym("if"),
          list(sym("<"), num(1), num(2)),
          list(sym("if"), list(sym(">"), num(3), num(2)), num(100), num(200)),
          num(300),
        );
        expect(await exec(code, { env })).toEqual(num(100));
      });
    });

    describe("begin", () => {
      it("should evaluate expressions in order and return last value", async () => {
        // (begin 1 2 3)
        const code = list(sym("begin"), num(1), num(2), num(3));
        expect(await exec(code, { env })).toEqual(num(3));
      });

      it("should return undefined for empty begin", async () => {
        // (begin)
        const code = list(sym("begin"));
        expect(await exec(code, { env })).toBe(undefined);
      });

      it("should execute side effects", async () => {
        let sideEffect = 0;
        env.set("inc!", () => {
          sideEffect++;
          return new SchemeExact(BigInt(sideEffect));
        });

        // (begin (inc!) (inc!) (inc!))
        const code = list(sym("begin"), list(sym("inc!")), list(sym("inc!")), list(sym("inc!")));
        const result = await exec(code, { env });
        expect(result).toEqual(num(3));
        expect(sideEffect).toBe(3);
      });
    });

    describe("define", () => {
      it("should define a simple variable", async () => {
        // (define x 42)
        const code = list(sym("define"), sym("x"), num(42));
        await exec(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(num(42));
      });

      it("should evaluate the value expression", async () => {
        // (define x (+ 1 2))
        const code = list(sym("define"), sym("x"), list(sym("+"), num(1), num(2)));
        await exec(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(num(3));
      });

      it("should define a function with shorthand syntax", async () => {
        // (define (add a b) (+ a b))
        const code = list(sym("define"), list(sym("add"), sym("a"), sym("b")), list(sym("+"), sym("a"), sym("b")));
        await exec(code, { env });
        const add = env._lookupWithResolvers("add");
        // Scheme lambdas are JS functions with __lambda__ marker
        expect(typeof add).toBe("function");
        expect((add as { __name__?: string }).__name__).toBe("add");
      });
    });

    describe("set!", () => {
      it("should update an existing variable", async () => {
        env.set("x", num(10));
        // (set! x 20)
        const code = list(sym("set!"), sym("x"), num(20));
        await exec(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(num(20));
      });

      it("should evaluate the value expression", async () => {
        env.set("x", num(10));
        // (set! x (+ x 5))
        const code = list(sym("set!"), sym("x"), list(sym("+"), sym("x"), num(5)));
        await exec(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(num(15));
      });
    });

    describe("lambda", () => {
      it("should create a callable function", async () => {
        // (lambda (x) x)
        const code = list(sym("lambda"), list(sym("x")), sym("x"));
        const fn = (await exec(code, { env })) as Function;
        expect(typeof fn).toBe("function");
        expect((fn as { __lambda__?: boolean }).__lambda__).toBe(true);
      });

      it("should execute lambda with arguments", async () => {
        // ((lambda (x y) (+ x y)) 3 4)
        const code = list(
          list(sym("lambda"), list(sym("x"), sym("y")), list(sym("+"), sym("x"), sym("y"))),
          num(3),
          num(4),
        );
        const result = await exec(code, { env });
        expect(result).toEqual(num(7));
      });

      it("should capture closure environment", async () => {
        // (define a 10)
        // ((lambda (x) (+ a x)) 5)
        await exec(list(sym("define"), sym("a"), num(10)), { env });
        const code = list(list(sym("lambda"), list(sym("x")), list(sym("+"), sym("a"), sym("x"))), num(5));
        const result = await exec(code, { env });
        expect(result).toEqual(num(15));
      });

      it("should handle rest parameters", async () => {
        // ((lambda args args) 1 2 3)
        const code = list(list(sym("lambda"), sym("args"), sym("args")), num(1), num(2), num(3));
        const result = (await exec(code, { env })) as Pair;
        expect(result.to_array()).toEqual([num(1), num(2), num(3)]);
      });
    });

    describe("let", () => {
      it("should bind variables in body", async () => {
        // (let ((x 10) (y 20)) (+ x y))
        const code = list(
          sym("let"),
          list(list(sym("x"), num(10)), list(sym("y"), num(20))),
          list(sym("+"), sym("x"), sym("y")),
        );
        expect(await exec(code, { env })).toEqual(num(30));
      });

      it("should use parallel binding semantics", async () => {
        // (let ((x 1) (y x)) y) - should fail because x isn't bound yet
        env.set("x", num(100));
        const code = list(sym("let"), list(list(sym("x"), num(1)), list(sym("y"), sym("x"))), sym("y"));
        // y should be 100 (outer x), not 1 (inner x)
        expect(await exec(code, { env })).toEqual(num(100));
      });

      it("should handle named let for loops", async () => {
        // (let loop ((n 5) (acc 1)) (if (<= n 1) acc (loop (- n 1) (* acc n))))
        const code = list(
          sym("let"),
          sym("loop"),
          list(list(sym("n"), num(5)), list(sym("acc"), num(1))),
          list(
            sym("if"),
            list(sym("<="), sym("n"), num(1)),
            sym("acc"),
            list(sym("loop"), list(sym("-"), sym("n"), num(1)), list(sym("*"), sym("acc"), sym("n"))),
          ),
        );
        expect(await exec(code, { env })).toEqual(num(120)); // 5!
      });
    });

    describe("let*", () => {
      it("should bind variables sequentially", async () => {
        // (let* ((x 10) (y (+ x 5))) y)
        const code = list(
          sym("let*"),
          list(list(sym("x"), num(10)), list(sym("y"), list(sym("+"), sym("x"), num(5)))),
          sym("y"),
        );
        expect(await exec(code, { env })).toEqual(num(15));
      });
    });

    describe("letrec", () => {
      it("should allow recursive bindings", async () => {
        // (letrec ((fact (lambda (n) (if (<= n 1) 1 (* n (fact (- n 1))))))) (fact 5))
        const code = list(
          sym("letrec"),
          list(
            list(
              sym("fact"),
              list(
                sym("lambda"),
                list(sym("n")),
                list(
                  sym("if"),
                  list(sym("<="), sym("n"), num(1)),
                  num(1),
                  list(sym("*"), sym("n"), list(sym("fact"), list(sym("-"), sym("n"), num(1)))),
                ),
              ),
            ),
          ),
          list(sym("fact"), num(5)),
        );
        expect(await exec(code, { env })).toEqual(num(120));
      });
    });

    describe("and", () => {
      it("should return true for empty and", async () => {
        const code = list(sym("and"));
        expect(await exec(code, { env })).toBe(true);
      });

      it("should short-circuit on false", async () => {
        let called = false;
        env.set("side-effect", () => {
          called = true;
          return true;
        });
        // (and #f (side-effect))
        const code = list(sym("and"), false, list(sym("side-effect")));
        expect(await exec(code, { env })).toBe(false);
        expect(called).toBe(false);
      });

      it("should return last value if all true", async () => {
        // (and 1 2 3)
        const code = list(sym("and"), num(1), num(2), num(3));
        expect(await exec(code, { env })).toEqual(num(3));
      });
    });

    describe("or", () => {
      it("should return false for empty or", async () => {
        const code = list(sym("or"));
        expect(await exec(code, { env })).toBe(false);
      });

      it("should short-circuit on true", async () => {
        let called = false;
        env.set("side-effect", () => {
          called = true;
          return false;
        });
        // (or 1 (side-effect))
        const code = list(sym("or"), num(1), list(sym("side-effect")));
        expect(await exec(code, { env })).toEqual(num(1));
        expect(called).toBe(false);
      });

      it("should return last value if all false", async () => {
        // (or #f #f 0) - 0 is truthy in Scheme
        const code = list(sym("or"), false, false, num(0));
        expect(await exec(code, { env })).toEqual(num(0));
      });
    });

    describe("cond", () => {
      it("should evaluate matching clause", async () => {
        // (cond ((< 1 2) 'yes) (else 'no))
        const code = list(
          sym("cond"),
          list(list(sym("<"), num(1), num(2)), list(sym("quote"), sym("yes"))),
          list(sym("else"), list(sym("quote"), sym("no"))),
        );
        const result = (await exec(code, { env })) as SchemeSymbol;
        expect(result.__name__).toBe("yes");
      });

      it("should evaluate else clause when nothing matches", async () => {
        // (cond ((> 1 2) 'no) (else 'yes))
        const code = list(
          sym("cond"),
          list(list(sym(">"), num(1), num(2)), list(sym("quote"), sym("no"))),
          list(sym("else"), list(sym("quote"), sym("yes"))),
        );
        const result = (await exec(code, { env })) as SchemeSymbol;
        expect(result.__name__).toBe("yes");
      });

      it("should return test value when no expressions", async () => {
        // (cond (5)) => 5
        const code = list(sym("cond"), list(num(5)));
        expect(await exec(code, { env })).toEqual(num(5));
      });

      it("should handle => syntax", async () => {
        // (cond ((+ 1 2) => (lambda (x) (* x 2))))
        // With membrane, JS functions receive JS values (not SchemeExact)
        env.set("double", (x: number) => x * 2);
        const code = list(sym("cond"), list(list(sym("+"), num(1), num(2)), sym("=>"), sym("double")));
        // Result passes through fromJS which keeps numbers as-is
        expect(await exec(code, { env })).toBe(6);
      });
    });

    describe("case", () => {
      it("should match datum", async () => {
        // (case 2 ((1) 'one) ((2) 'two) (else 'other))
        const code = list(
          sym("case"),
          num(2),
          list(list(num(1)), list(sym("quote"), sym("one"))),
          list(list(num(2)), list(sym("quote"), sym("two"))),
          list(sym("else"), list(sym("quote"), sym("other"))),
        );
        const result = (await exec(code, { env })) as SchemeSymbol;
        expect(result.__name__).toBe("two");
      });

      it("should use else when no match", async () => {
        // (case 5 ((1) 'one) ((2) 'two) (else 'other))
        const code = list(
          sym("case"),
          num(5),
          list(list(num(1)), list(sym("quote"), sym("one"))),
          list(list(num(2)), list(sym("quote"), sym("two"))),
          list(sym("else"), list(sym("quote"), sym("other"))),
        );
        const result = (await exec(code, { env })) as SchemeSymbol;
        expect(result.__name__).toBe("other");
      });
    });

    describe("when", () => {
      it("should execute body when test is true", async () => {
        // (when #t 1 2 3)
        const code = list(sym("when"), true, num(1), num(2), num(3));
        expect(await exec(code, { env })).toEqual(num(3));
      });

      it("should return undefined when test is false", async () => {
        // (when #f 1 2 3)
        const code = list(sym("when"), false, num(1), num(2), num(3));
        expect(await exec(code, { env })).toBe(undefined);
      });
    });

    describe("unless", () => {
      it("should execute body when test is false", async () => {
        // (unless #f 1 2 3)
        const code = list(sym("unless"), false, num(1), num(2), num(3));
        expect(await exec(code, { env })).toEqual(num(3));
      });

      it("should return undefined when test is true", async () => {
        // (unless #t 1 2 3)
        const code = list(sym("unless"), true, num(1), num(2), num(3));
        expect(await exec(code, { env })).toBe(undefined);
      });
    });

    describe("do", () => {
      it("should iterate until test is true", async () => {
        // (do ((i 0 (+ i 1))) ((>= i 5) i))
        const code = list(
          sym("do"),
          list(list(sym("i"), num(0), list(sym("+"), sym("i"), num(1)))),
          list(list(sym(">="), sym("i"), num(5)), sym("i")),
        );
        expect(await exec(code, { env })).toEqual(num(5));
      });

      it("should execute body on each iteration", async () => {
        let count = 0;
        env.set("inc!", () => {
          count++;
          return undefined;
        });
        // (do ((i 0 (+ i 1))) ((>= i 3)) (inc!))
        const code = list(
          sym("do"),
          list(list(sym("i"), num(0), list(sym("+"), sym("i"), num(1)))),
          list(list(sym(">="), sym("i"), num(3))),
          list(sym("inc!")),
        );
        await exec(code, { env });
        expect(count).toBe(3);
      });
    });

    describe("define-macro", () => {
      it("should define a simple macro", async () => {
        // (define-macro (my-when test . body) `(if ,test (begin ,@body)))
        // Then: (my-when #t 1 2 3)
        const defineMacro = list(
          sym("define-macro"),
          new Pair(sym("my-when"), new Pair(sym("test"), sym("body"))),
          list(
            sym("quasiquote"),
            list(
              sym("if"),
              list(sym("unquote"), sym("test")),
              // (begin ,@body) = (begin (unquote-splicing body))
              list(sym("begin"), list(sym("unquote-splicing"), sym("body"))),
            ),
          ),
        );
        await exec(defineMacro, { env });

        const code = list(sym("my-when"), true, num(1), num(2), num(3));
        expect(await exec(code, { env })).toEqual(num(3));
      });
    });

    // NOTE: the former describe("raise/error") block was removed with audit Action 1
    // (X1): `raise`/`error` are no longer evaluator special forms — they resolve to the
    // R7RS bootstrap procedures (which walk *current-exception-handlers*). Those tests
    // asserted the old R6RS `(error who message)` arity and string-coerced `raise`
    // against a minimal env without bootstrap; correct R7RS exception coverage now lives
    // in generator-exec.spec.ts against a bootstrap-loaded env.

    // delay/force — OMITTED by the purity invariant (delayed evaluation defers a
    // value's identity to force-time, severing construction-rooted provenance).
    // Removed from the special-form table; doored in core.ts. The full door
    // surface (delay/force/make-promise/delay-force) is pinned in
    // purity-doors.test.ts; here we just confirm the special form is gone.
    describe("delay/force — omitted by the purity invariant", () => {
      it("(delay …) is no longer a working special form", async () => {
        // This raw env has no bootstrap loaded, so `delay` is unbound here (the
        // teaching door — "omitted from arrival by design" — is a bootstrap macro,
        // verified at the full-env layer in purity-doors.test.ts). The point at
        // THIS layer: delay no longer evaluates lazily; it is gone from the
        // special-form table.
        await expect(exec(list(sym("delay"), list(sym("+"), num(1), num(2))), { env })).rejects.toThrow();
      });
    });
  });

  describe("performance - deep recursion", () => {
    it("should handle deep recursion without stack overflow", async () => {
      // Create a deeply nested expression: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...)))
      let code: Pair | typeof nil = list(sym("+"), num(1), num(0));

      // 10,000 levels of nesting
      for (let i = 0; i < 10000; i++) {
        code = list(sym("+"), num(1), code);
      }

      const result = await exec(code, { env });
      expect(result).toEqual(num(10001));
    });

    it("should handle deeply nested if expressions", async () => {
      // Create deeply nested ifs: (if #t (if #t (if #t ... 42 ...)))
      let code: SchemeValue = num(42);

      for (let i = 0; i < 10000; i++) {
        code = list(sym("if"), true, code, num(0));
      }

      const result = await exec(code, { env });
      expect(result).toEqual(num(42));
    });

    it("tail recursion to 10k depth does not overflow", async () => {
      // R7RS §3.5: a self-call in tail position must run in O(1) space. This
      // is different from the nested-`+` test above — that nesting lives in a
      // single `run()` generator's stack[]. Here each `(loop (- n 1))` is a
      // FRESH lambda invocation; before TCO (task #46) each one minted a new
      // `run()` Promise the outer trampoline awaited, growing the host call
      // stack one frame per level and overflowing V8 at ~10k ("Maximum call
      // stack size exceeded"). With tail-call collapse + the bounce protocol
      // the loop iterates flat, so 10k completes cleanly.
      const [, result] = await execSource("(define (loop n) (if (= n 0) 'done (loop (- n 1)))) (loop 10000)");
      expect(String(result)).toBe("done");
    }, 15000);
  });
});

// Type for Nil
interface Nil {
  toString(): string;
}
