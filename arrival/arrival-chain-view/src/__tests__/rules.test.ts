/**
 * Per-rule unit coverage for the scheme→JS read-view projection. Assertions are
 * against the FORMATTED output (eslint --fix and prettier), so they're stable
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

describe("named let → recursive IIFE (Scheme's loop primitive)", () => {
  it("(let loop ((i 0) (acc 0)) …) → a local recursive arrow, called once", async () => {
    const out = await p("(define (sum-to n) (let loop ((i 0) (acc 0)) (if (> i n) acc (loop (+ i 1) (+ acc i)))))");
    expect(out).toContain("const loop = (i, acc) =>");
    expect(out).toContain("loop(0, 0)"); // called with the init values
    expect(out).toContain("loop(i + 1, acc + i)"); // recursive call resolves to the binding
  });

  it("nested named lets keep distinct recursion names + their bindings", async () => {
    const out = await p("(define (f xs) (let outer ((ys xs)) (let inner ((zs ys)) (inner zs))))");
    expect(out).toContain("const outer = (ys) =>");
    expect(out).toContain("const inner = (zs) =>");
  });
});

describe("list layer — pair vs list (the cdr/cadr split), cut, list-ref, transpose", () => {
  it("cdr is the list TAIL; cadr/caddr are positional access", async () => {
    expect(await p("(define (f xs) (cdr xs))")).toContain("xs.slice(1)");
    expect(await p("(define (f xs) (cadr xs))")).toContain("xs[1]");
    expect(await p("(define (f xs) (caddr xs))")).toContain("xs[2]");
  });

  it("cons is PREPEND — `(cons x xs)` → `[x, ...xs]` (a pair is `(list a b)`)", async () => {
    expect(await p("(define (f a xs) (cons a xs))")).toContain("[a, ...xs]");
  });

  it("list-ref → index; even?/odd? → modulo", async () => {
    expect(await p("(define (f xs i) (list-ref xs i))")).toContain("xs[i]");
    expect(await p("(define (f n) (even? n))")).toContain("n % 2 === 0");
    expect(await p("(define (f n) (odd? n))")).toContain("n % 2 !== 0");
  });

  it("cut → a terse lambda, one `it` param per <> slot", async () => {
    expect(await p("(define (f xs c) (filter (cut dominates? <> c) xs))")).toContain("xs.filter((it) => dominates(it, c))");
  });

  it("cut over apply → a max-of-list mapper", async () => {
    expect(await p("(define (f cols) (map (cut apply max <>) cols))")).toContain("cols.map((it) => Math.max(...it))");
  });

  it("(apply map list rows) → transpose (columns)", async () => {
    expect(await p("(define (f rows) (apply map list rows))")).toContain("rows[0].map((_, i) => rows.map((row) => row[i]))");
  });

  it("multi-list map with a multi-param lambda INLINES (not a broken curry)", async () => {
    const out = await p("(define (f xs ys) (map (lambda (s m) (if (>= s m) 1 0)) xs ys))");
    expect(out).toContain("xs.map((x, i) =>");
    expect(out).toContain("x >= ys[i] ? 1 : 0");
  });
});

describe("internal defines + apply-append", () => {
  it("an internal value define → a block-local const, body returns the trailing expr", async () => {
    const out = await p("(define (f x) (define y (* x 2)) (+ x y))");
    expect(out).toContain("const f = (x) =>");
    expect(out).toContain("const y = x * 2;");
    expect(out).toContain("return x + y;");
  });

  it("an internal function define → a block-local arrow (Scheme's local helper)", async () => {
    const out = await p("(define (f xs) (define (g a) (* a 2)) (g xs))");
    expect(out).toContain("const g = (a) => a * 2;");
    expect(out).toContain("return g(xs);");
  });

  it("(apply append xss) → flat() (concat a list of lists one level)", async () => {
    expect(await p("(define (f xss) (apply append xss))")).toContain("xss.flat()");
  });

  it("(apply (lambda …) xs) parenthesizes the lambda callee, spreads the list", async () => {
    expect(await p("(define (f p) (apply (lambda (a b) (+ a b)) p))")).toContain("((a, b) => a + b)(...p)");
  });
});

describe("statement / top-level position parens", () => {
  it("a top-level dict (the program's value) is parenthesized, not a block", async () => {
    expect(await p("(dict :a 1 :b 2)")).toContain("({ a: 1, b: 2 });");
  });
});

describe("spread peephole — a (list …) literal splices inline, not `...[x]`", () => {
  it("append snoc → `[...acc, x]` (no `...[x]` machine-tell)", async () => {
    expect(await p("(define (f acc x) (append acc (list x)))")).toContain("[...acc, x]");
  });

  it("append with a leading list literal → `[x, ...ys]`", async () => {
    expect(await p("(define (f x ys) (append (list x) ys))")).toContain("[x, ...ys]");
  });

  it("a plain append of two vars still spreads both", async () => {
    expect(await p("(define (f a b) (append a b))")).toContain("[...a, ...b]");
  });

  it("cons onto a list literal flattens → `[x, a, b]`", async () => {
    expect(await p("(define (f x a b) (cons x (list a b)))")).toContain("[x, a, b]");
  });

  it("the dedupe idiom reads clean (reduce + append-snoc)", async () => {
    const out = await p("(define (dedupe xs) (reduce (lambda (x acc) (if (member x acc) acc (append acc (list x)))) (list) xs))");
    expect(out).toContain("? acc : [...acc, x]");
  });
});

describe("let unwrapping — a let/let* body IS the arrow's block (no redundant IIFE)", () => {
  it("let* as a function body becomes the block directly", async () => {
    const out = await p("(define (trace a ex) (let* ((m (:input ex)) (r (run a m))) (dict :m m :r r)))");
    expect(out).toContain("const trace = (a, ex) => {");
    expect(out).toContain("const m = ex.input;");
    expect(out).not.toContain("=> (() =>"); // the IIFE is gone
  });

  it("keeps the IIFE in expression position (a let used as an argument)", async () => {
    expect(await p("(define (f xs) (g (let ((y 1)) (+ y 2)) xs))")).toContain("(() => {");
  });

  it("a let binding that shadows a param is renamed by the namer, so it still unwraps", async () => {
    // The inner `x` resolves to `x2` (distinct from the param), so there's no redeclare —
    // the IIFE the old fresh-scope guard kept is unnecessary.
    const out = await p("(define (f x) (let ((x 5)) (+ x 1)))");
    expect(out).toContain("const f = (x) => {");
    expect(out).toContain("const x2 = 5;");
    expect(out).toContain("return x2 + 1;");
    expect(out).not.toContain("(() => {");
  });

  it("run-view: an infer call in a let* body unwraps so `await` sits in the async fn", async () => {
    const out = await projectToJs('(define runX (require "x.prompt"))\n(define (trace a) (let* ((r (runX (list a) :a a))) r))', {
      target: "run",
    });
    expect(out).toContain("const trace = async (a) =>");
    expect(out).toContain("await runX(");
    expect(out).not.toContain("=> (() =>");
  });

  it("a named let (loop) as a function's sole body unwraps to the arrow's own block", async () => {
    const out = await p("(define (sum xs) (let loop ((ys xs) (acc 0)) (if (null? ys) acc (loop (cdr ys) (+ acc (car ys))))))");
    expect(out).toContain("const sum = (xs) => {");
    expect(out).toContain("const loop = (ys, acc) =>");
    expect(out).toContain("return loop(xs, 0);"); // called once with the inits
    expect(out).not.toContain("=> (() =>"); // no wrapper IIFE at body position
  });

  it("run-view: an expression-position let with an infer call awaits inline (not a sync IIFE)", async () => {
    // The let sits in a ternary arm, so it can't unwrap to a block — it must stay an
    // expression. Its body awaits, so the IIFE is async AND awaited inline (legal: the
    // enclosing fn is async), never a sync `(() => { … await … })()` (a syntax error).
    const out = await projectToJs(
      '(define runX (require "x.prompt"))\n(define (f c a) (if c 0 (let ((r (runX (list a) :a a))) r)))',
      { target: "run" },
    );
    expect(out).toContain("const f = async (c, a) =>");
    expect(out).toContain("await (async () =>"); // async IIFE, awaited inline in the ternary arm
    expect(out).toContain("await runX(");
  });
});

describe("arity bridge (§5)", () => {
  it("single-list map passes a user fn by reference", async () => {
    expect(await p("(define (f xs) (map double xs))")).toContain("xs.map(double)");
  });

  it("single-list map of an accessor builtin destructures to [head]", async () => {
    expect(await p("(define (f pairs) (map car pairs))")).toContain("pairs.map(([head]) => head)");
  });

  it("multi-list map → index-driven traverse (no zip), index named i", async () => {
    const out = await p("(define (f items others) (map list items others))");
    expect(out).toContain("items.map((item, i) => [item, others[i]])");
  });

  it("a map returning a dict parenthesizes the object body (not a block)", async () => {
    // single-list (arrow1) and multi-list paths both wrap the `{…}` so it's an expression.
    expect(await p("(define (f xs) (map (lambda (x) (dict :id (:id x))) xs))")).toContain(
      "xs.map((x) => ({ id: x.id }))",
    );
    expect(await p("(define (f xs ys) (map (lambda (a b) (dict :x a :y b)) xs ys))")).toContain(
      "xs.map((x, i) => ({ x, y: ys[i] }))",
    );
  });

  it("every over two lists → indexed predicate", async () => {
    const out = await p("(define (f scores limits) (every >= scores limits))");
    expect(out).toContain("scores.every((score, i) => score >= limits[i])");
  });

  it("apply + → reduce-sum (acc + singular element)", async () => {
    expect(await p("(define (f scores) (apply + scores))")).toContain("scores.reduce((acc, score) => acc + score, 0)");
  });

  it("append → spread concat (not R.append)", async () => {
    const out = await p("(define (f a b) (append a b))");
    expect(out).toContain("[...a, ...b]");
    expect(out).not.toContain("R.append");
  });

  it("max-by → reduce, inlining the unary key lambda in place (not R.maxBy)", async () => {
    const out = await p("(define (f candidates) (max-by (lambda (c) (:score c)) candidates))");
    expect(out).toContain("candidates.reduce((acc, candidate) => (candidate.score > acc.score ? candidate : acc))");
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
    expect(await p("(define (f nums) (apply - nums))")).toContain("nums.reduce((acc, num) => acc - num)");
    expect(await p("(define (f nums) (apply / nums))")).toContain("nums.reduce((acc, num) => acc / num)");
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

describe("namer heuristics — singular element + acc", () => {
  it("singularizes a plural collection name for a synthetic element param (whole use)", async () => {
    // shown on a whole-use (multi-list driver); a single-list car would destructure instead.
    expect(await p("(define (f items others) (map list items others))")).toContain("items.map((item, i) =>");
  });

  it("derives the element name from an accessor field", async () => {
    const out = await p("(define (f c) (every >= (:scores c) (:limits c)))");
    expect(out).toContain("c.scores.every((score, i) => score >= c.limits[i])");
  });

  it("derives the element name from a getter-call head: (scores a) → score", async () => {
    const out = await p("(define (f a b) (every >= (scores a) (scores b)))");
    expect(out).toContain("scores(a).every((score, i) => score >= scores(b)[i])");
  });

  it("names the reduce accumulator `acc`", async () => {
    expect(await p("(define (f scores) (apply + scores))")).toContain("scores.reduce((acc, score) =>");
  });

  it("falls back to __x when the collection has no good singular (used whole)", async () => {
    expect(await p("(define (f pool others) (map list pool others))")).toContain("pool.map((__x, i) => [__x, others[i]])");
  });

  it("leaves a user-written lambda param untouched (heuristic is synthetic-params-only)", async () => {
    expect(await p("(define (f examples) (map (lambda (ex) (:id ex)) examples))")).toContain(
      "examples.map((ex) => ex.id)",
    );
  });
});

describe("namer — tuple destructuring + index", () => {
  it("a single index-0 access destructures to [head]", async () => {
    expect(await p("(define (f pairs) (map car pairs))")).toContain("pairs.map(([head]) => head)");
  });

  it("a higher index destructures to positional names (the gepa filter shape)", async () => {
    const out = await p("(define (f rows) (filter (lambda (pair) (zero? (cadr pair))) rows))");
    expect(out).toContain("rows.filter(([first, second]) => second === 0)");
  });

  it("a param used whole is NOT destructured", async () => {
    expect(await p("(define (f xs others) (map list xs others))")).not.toContain("[head]");
  });

  it("index param is `i` (free), and `idx` if `i` is the element name", async () => {
    expect(await p("(define (f items others) (map list items others))")).toContain(", i) =>");
  });
});
