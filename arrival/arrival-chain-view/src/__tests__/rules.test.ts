/**
 * Per-rule unit coverage for the scheme→JS read-view projection. Assertions are
 * against the FORMATTED output (eslint --fix + prettier), so they're stable
 * against emitter spacing and exercise the whole pipeline.
 */
import { describe, expect, it } from "vitest";
import { projectToJs, projectToJsRaw } from "../project.js";

const p = (src: string) => projectToJs(src);

describe("lens rules (§4)", () => {
  it("define function → const arrow", async () => {
    expect(await p("(define (add a b) (+ a b))")).toContain("const add = (a, b) => a + b;");
  });

  it("define value → const", async () => {
    expect(await p("(define answer 42)")).toContain("const answer = 42;");
  });

  it("define f (lambda …) → const arrow", async () => {
    expect(await p('(define greet (lambda (name) name))')).toContain("const greet = (name) => name;");
  });

  it("if → ternary", async () => {
    expect(await p("(define (f n) (if (zero? n) 1 0))")).toContain("n === 0 ? 1 : 0");
  });

  it("if without else → ternary with undefined", async () => {
    expect(await p("(define (f c) (if c 1))")).toContain("c ? 1 : undefined");
  });

  it("accessor (:field obj) → obj.field", async () => {
    expect(await p("(define (f x) (:name x))")).toContain("x.name");
  });

  it("nested accessor (:a (:b x)) → x.b.a", async () => {
    expect(await p("(define (f x) (:a (:b x)))")).toContain("x.b.a");
  });

  it("dict → object literal, parenthesized as an arrow body, with shorthand", async () => {
    const out = await p("(define (f a) (dict :a a :b 2))");
    expect(out).toContain("({ a, b: 2 })");
  });

  it("list → array", async () => {
    expect(await p("(define (f a b) (list a b))")).toContain("[a, b]");
  });

  it("booleans + strings", async () => {
    expect(await p('(define x (list #t #f "hi"))')).toContain('[true, false, "hi"]');
  });

  it("and / or / not", async () => {
    expect(await p("(define (f a b) (and a (not b)))")).toContain("a && !b");
  });

  it("comparisons → JS operators", async () => {
    expect(await p("(define (f a b) (>= a b))")).toContain("a >= b");
  });
});

describe("arity bridge (§5)", () => {
  it("single-list map passes a user fn by reference", async () => {
    expect(await p("(define (f xs) (map double xs))")).toContain("xs.map(double)");
  });

  it("single-list map of an accessor builtin wraps in an arrow", async () => {
    expect(await p("(define (f pairs) (map car pairs))")).toContain("pairs.map((__x) => __x[0])");
  });

  it("multi-list map → index-driven traverse (no zip)", async () => {
    const out = await p("(define (f xs ys) (map cons xs ys))");
    expect(out).toContain("xs.map((__x, __i) => [__x, ys[__i]])");
  });

  it("every over two lists → indexed predicate", async () => {
    const out = await p("(define (f xs ys) (every >= xs ys))");
    expect(out).toContain("xs.every((__x, __i) => __x >= ys[__i])");
  });

  it("apply + → reduce-sum", async () => {
    expect(await p("(define (f xs) (apply + xs))")).toContain("xs.reduce((__a, __b) => __a + __b, 0)");
  });

  it("append → spread concat (not R.append)", async () => {
    const out = await p("(define (f a b) (append a b))");
    expect(out).toContain("[...a, ...b]");
    expect(out).not.toContain("R.append");
  });

  it("max-by → reduce, inlining the unary key lambda in place (not R.maxBy)", async () => {
    const out = await p("(define (f xs) (max-by (lambda (c) (:score c)) xs))");
    expect(out).toContain("xs.reduce((__m, __x) => (__x.score > __m.score ? __x : __m))");
    expect(out).not.toContain("R.maxBy");
  });
});

describe("keyword args → options object (§10)", () => {
  it("trailing :kw v run → a single options object, shorthand-collapsed", async () => {
    const out = await p("(define (f a) (g a :x a :y 2))");
    expect(out).toContain("g(a, { x: a, y: 2 })");
  });

  it("a :keyword in head position is an accessor, in argument position is a kwarg", async () => {
    // (:x obj) is an accessor; (g :x v) is a kwarg — same token class, position decides.
    expect(await p("(define (f o) (:x o))")).toContain("o.x");
    expect(await p("(define (f v) (g :x v))")).toContain("g({ x: v })");
  });
});

describe("string-ci=? and stdlib (§6)", () => {
  it("string-ci=? → case-insensitive compare", async () => {
    const out = await p("(define (m a b) (if (string-ci=? a b) 1 0))");
    expect(out).toContain("a.toLowerCase() === b.toLowerCase()");
  });
});

describe("determinism (§11)", () => {
  it("projecting twice is byte-identical", async () => {
    const src = "(define (f a b) (map (lambda (x) (+ x a)) b))";
    const a = await projectToJs(src);
    const b = await projectToJs(src);
    expect(a).toBe(b);
  });

  it("raw projection is a pure function too", () => {
    const src = "(define (f a b) (dict :a a :b b))";
    expect(projectToJsRaw(src)).toBe(projectToJsRaw(src));
  });
});

describe("round-2 audit regressions (precedence + operators + escapes + collisions)", () => {
  it("string-append is parenthesized so an accessor binds the whole concat", async () => {
    expect(await p("(define (f a b) (:x (string-append a b)))")).toContain("(a + b).x");
  });

  it("a 2-arg comparison is parenthesized inside arithmetic", async () => {
    expect(await p("(define (f a b) (+ (< a b) 1))")).toContain("(a < b) + 1");
  });

  it("not wraps its operand: (not (= a b)) → !(a === b), not (!a) === b", async () => {
    expect(await p("(define (f a b) (not (= a b)))")).toContain("!(a === b)");
  });

  it("apply of `-` / `/` folds via reduce (no garbage identifier)", async () => {
    expect(await p("(define (f xs) (apply - xs))")).toContain("xs.reduce((__a, __b) => __a - __b)");
    expect(await p("(define (f xs) (apply / xs))")).toContain("xs.reduce((__a, __b) => __a / __b)");
  });

  it("apply of min/max → Math.min/max spread", async () => {
    expect(await p("(define (f xs) (apply max xs))")).toContain("Math.max(...xs)");
    expect(await p("(define (f xs) (apply min xs))")).toContain("Math.min(...xs)");
  });

  it("apply of an unsupported operator is a door, not garbage", async () => {
    await expect(p("(define (f xs) (apply < xs))")).rejects.toThrow(/apply/);
  });

  it("string escapes decode once, not twice", async () => {
    const out = await p('(define x "a\\nb")'); // scheme source: a \n b
    expect(out).toContain('"a\\nb"'); // → JS newline escape
    expect(out).not.toContain('"a\\\\nb"'); // NOT a literal double-backslash
  });

  it("an inline-require local never collides with a top-level define", async () => {
    const out = await p('(define seed 1)\n(gepa (require "seed.txt"))');
    expect(out).toContain('import seed_2 from "./seed.txt";'); // hoisted local dodges `seed`
    expect(out).toContain("const seed = 1;");
    expect(out).toContain("gepa(seed_2)");
    expect(out).not.toMatch(/import seed from/); // no duplicate `seed` binding
  });

  it("a hyphenated keyword becomes a valid camelCase object key (caught live in the studio)", async () => {
    // `:max-words` as a raw object key would be invalid JS (hyphen); clean it.
    expect(await p("(define (f x) (g :max-words 1 :tone x))")).toContain("{ maxWords: 1, tone: x }");
    expect(await p("(define (f a) (dict :max-words a))")).toContain("maxWords: a");
  });
});
