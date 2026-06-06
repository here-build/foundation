/**
 * The desugar pre-pass (`desugar.ts`): SRFI-26 `cut`, the threading family
 * (`->`/`~>` first, `->>`/`~>>` last), and `compose`/`comp` (right-to-left) + `pipe`/`flow`
 * (left-to-right). Expansion runs BEFORE the namer / async-analysis / lowering, so threaded
 * and composed forms are ordinary calls/lambdas everywhere — async taint, `Promise.all`, and
 * naming all fall out for free. Semantics mirror the arrival-scheme bootstrap macros exactly.
 * Assertions are against the formatted projection (the whole pipeline).
 */
import { describe, expect, it } from "vitest";
import { projectToJs } from "../project.js";

const p = (src: string) => projectToJs(src);

describe("threading macros (positional, Clojure/Racket — not a `_` placeholder)", () => {
  it("`->` threads as the FIRST arg; bare symbols become unary calls", async () => {
    expect(await p("(define (f persona) (-> persona state-of summarize))")).toContain(
      "summarize(stateOf(persona))",
    );
  });

  it("`->` inserts as the first arg, before a call step's existing args", async () => {
    expect(await p("(define (f n) (-> n (max 0) (min 100)))")).toContain("Math.min(Math.max(n, 0), 100)");
  });

  it("`->>` threads as the LAST arg through a real pipeline", async () => {
    expect(await p("(define (f history) (->> history (take 3) reverse car))")).toContain(
      "[...take(3, history)].reverse()[0]",
    );
  });

  it("`~>` / `~>>` are aliases of `->` / `->>`", async () => {
    expect(await p("(define (f x) (~> x inc))")).toContain("inc(x)");
    expect(await p("(define (f xs) (~>> xs (map double)))")).toContain("xs.map(double)");
  });
});

describe("compose / pipe (keyword accessors stay in head position → no bare-keyword error)", () => {
  it("`compose` is right-to-left and lowers keyword accessors cleanly", async () => {
    expect(await p("(define state-of (compose :state last :versions))")).toContain(
      "const stateOf = (it) => last(it.versions).state;",
    );
  });

  it("`pipe` / `flow` are left-to-right", async () => {
    expect(await p("(define inc2 (pipe inc inc))")).toContain("const inc2 = (it) => inc(inc(it));");
  });

  it("a `compose` used inline as a predicate (count-if) inlines as an arrow", async () => {
    expect(await p("(define (f reactions) (count-if (compose clicking? :verdict) reactions))")).toContain(
      "(it) => clicking(it.verdict)",
    );
  });
});

describe("keyword accessor as a first-class function", () => {
  it("`(map :score xs)` → an arrow accessor (a `:kw` is not a JS reference)", async () => {
    expect(await p("(define (f xs) (map :score xs))")).toContain("xs.map((x) => x.score)");
  });

  it("the full thread-last + keyword-map + reduce pipeline projects", async () => {
    expect(await p("(define (f history) (->> history (take 3) (map :score) avg))")).toContain(
      "avg(take(3, history).map((__x) => __x.score))",
    );
  });
});

describe("desugar runs before async-analysis (threading/compose go async for free)", () => {
  it("a thread-last over an async fn becomes await Promise.all and the caller goes async", async () => {
    const out = await projectToJs(
      '(define rp (require "p.prompt"))\n(define (score x) (rp x))\n(define (f xs) (->> xs (map score)))',
      { target: "run" },
    );
    expect(out).toContain("const f = async (xs) =>");
    expect(out).toContain("await Promise.all(xs.map(score))");
  });
});
