/**
 * Effect analysis — the abstract interpreter that answers "does running this cell penetrate the
 * membrane (infer/http/sql/mcp)?" WITHOUT executing. The studio shows `▶` only when it does.
 *
 * The load-bearing case is the one execution-by-running can't get right: a penetration sitting
 * in an UNFORCED lambda body. `(define (ask q) (infer q))` is pure to evaluate (binding a lambda
 * touches nothing) — no button. Only a later `(ask "x")` penetrates. We assert both halves, and
 * the cross-cell thread (helper defined in one cell, called in the next) that option B was for.
 */
import { parseGenerator } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import { cellTriggers, formsTrigger, rootEffectEnv } from "../effect-analysis.js";

const triggers = async (src: string) => formsTrigger(await parseGenerator(src));

describe("effect-analysis — direct penetration", () => {
  it("flags a bare (infer …)", async () => {
    expect(await triggers(`(infer "what is 2+2?")`)).toBe(true);
  });
  it("flags infer/chat, http/get, http/post, sql/query, mcp/call, mcp/list", async () => {
    expect(await triggers(`(infer/chat (list))`)).toBe(true);
    expect(await triggers(`(http/get "https://x")`)).toBe(true);
    expect(await triggers(`(http/post "https://x" body)`)).toBe(true);
    expect(await triggers(`(sql/query "select 1")`)).toBe(true);
    expect(await triggers(`(mcp/call "srv" "tool" args)`)).toBe(true);
    expect(await triggers(`(mcp/list "srv")`)).toBe(true);
  });
  it("does NOT flag pure arithmetic / list building", async () => {
    expect(await triggers(`(+ 1 2 3)`)).toBe(false);
    expect(await triggers(`(map (lambda (x) (* x x)) (list 1 2 3))`)).toBe(false);
  });
  it("does NOT flag pure getters/middleware (mcp/llm constructors, derive)", async () => {
    expect(await triggers(`(mcp "github")`)).toBe(false);
    expect(await triggers(`(llm "gpt")`)).toBe(false);
    expect(await triggers(`(derive x (lambda (v) v))`)).toBe(false);
  });
});

describe("effect-analysis — unforced lambda body (the execution-probe trap)", () => {
  it("a define-only cell with infer in the body does NOT trigger", async () => {
    // The user's stated concern: "otherwise we will halt on infer inside declare".
    expect(await triggers(`(define (ask q) (infer q))`)).toBe(false);
  });
  it("a bare (lambda … (infer …)) does NOT trigger — referencing is pure", async () => {
    expect(await triggers(`(lambda (q) (infer q))`)).toBe(false);
  });
  it("but CALLING the latent helper in the same cell triggers", async () => {
    expect(await triggers(`(define (ask q) (infer q)) (ask "hi")`)).toBe(true);
  });
  it("(define x (infer …)) triggers — the expr is evaluated at definition", async () => {
    expect(await triggers(`(define answer (infer "q"))`)).toBe(true);
  });
  it("(define f (lambda … infer)) binds latent WITHOUT triggering", async () => {
    expect(await triggers(`(define ask (lambda (q) (infer q)))`)).toBe(false);
  });
});

describe("effect-analysis — cross-cell taint (option B: threaded env)", () => {
  it("helper defined in cell 1, called in cell 2 → cell 2 triggers, cell 1 does not", async () => {
    const env = rootEffectEnv();
    const cell1 = await parseGenerator(`(define (ask q) (infer q))`);
    const cell2 = await parseGenerator(`(ask "what is the capital of France?")`);
    expect(cellTriggers(cell1, env)).toBe(false); // pure define → no button
    expect(cellTriggers(cell2, env)).toBe(true); // calls the latent helper → button
  });
  it("a pure helper called downstream stays pure across cells", async () => {
    const env = rootEffectEnv();
    const cell1 = await parseGenerator(`(define (double x) (* x 2))`);
    const cell2 = await parseGenerator(`(double 21)`);
    expect(cellTriggers(cell1, env)).toBe(false);
    expect(cellTriggers(cell2, env)).toBe(false);
  });
  it("isolated cell (fresh env) does NOT see another cell's define", async () => {
    await parseGenerator(`(define (ask q) (infer q))`); // not threaded
    expect(await triggers(`(ask "x")`)).toBe(false); // unknown symbol defaults pure
  });
});

describe("effect-analysis — built-in HOF fn-arg latency", () => {
  it("(map infer xs) triggers — map calls its latent fn arg", async () => {
    expect(await triggers(`(map infer (list "a" "b"))`)).toBe(true);
  });
  it("(for-each (lambda (x) (infer x)) xs) triggers", async () => {
    expect(await triggers(`(for-each (lambda (x) (infer x)) (list 1 2))`)).toBe(true);
  });
  it("(map car xs) does not trigger", async () => {
    expect(await triggers(`(map car (list (list 1) (list 2)))`)).toBe(false);
  });
});

describe("effect-analysis — quote is data, quasiquote walks only unquotes", () => {
  it("'(infer x) is data, does not trigger", async () => {
    expect(await triggers(`(quote (infer "x"))`)).toBe(false);
    expect(await triggers(`'(infer "x")`)).toBe(false);
  });
  it("quasiquote with no unquote is data", async () => {
    expect(await triggers("`(infer x)")).toBe(false);
  });
  it("quasiquote with an unquoted penetration triggers", async () => {
    expect(await triggers("`(result ,(infer \"x\"))")).toBe(true);
  });
});

describe("effect-analysis — control forms over-approximate (safe direction)", () => {
  it("infer in an if branch triggers (can't prove the branch is dead)", async () => {
    expect(await triggers(`(if #t (infer "x") 0)`)).toBe(true);
    expect(await triggers(`(if #f 0 (infer "x"))`)).toBe(true);
  });
  it("infer in a cond clause triggers", async () => {
    expect(await triggers(`(cond (#t (infer "x")) (else 0))`)).toBe(true);
  });
  it("begin with a penetration triggers", async () => {
    expect(await triggers(`(begin (display "hi") (infer "x"))`)).toBe(true);
  });
});

describe("effect-analysis — let family and scope shadowing", () => {
  it("(let ((x (infer …))) …) triggers — init crosses the membrane", async () => {
    expect(await triggers(`(let ((x (infer "q"))) x)`)).toBe(true);
  });
  it("named let that calls infer in its body triggers", async () => {
    expect(await triggers(`(let loop ((n 3)) (if (> n 0) (begin (infer n) (loop (- n 1))) n))`)).toBe(true);
  });
  it("a local binding shadowing 'infer' as a pure value is not flagged when only referenced", async () => {
    // `infer` rebound to a pure lambda param/binding → referencing it is pure.
    expect(await triggers(`(let ((infer (lambda (x) x))) infer)`)).toBe(false);
  });
});
