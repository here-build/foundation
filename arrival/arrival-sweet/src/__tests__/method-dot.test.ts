import { describe, expect, it } from "vitest";

import { schemeToSweet, printScheme } from "../sweet-render.js";
import { readSweetExpr, readSweet } from "../sweet-read.js";

const render = (scheme: string): string => schemeToSweet(scheme).trim();
const read = (sweet: string): string => printScheme(readSweetExpr(sweet));
const readAll = (sweet: string): string => readSweet(sweet).map((f) => printScheme(f)).join("\n");

// §2/§3/§4.3 — the method dot reads as the receiver-last fold: every step seats the
// receiver in the LAST arg slot, unifying subscript `[…]` and method `.op`.
describe("read: method dot → receiver-last fold", () => {
  const cases: Array<[string, string]> = [
    // braced HOF — the thread-last pipe into a collection-last op. The lambda-brace
    // binds TIGHT to the op (`map{…}`), isomorphic to a tight arg-group `fold(knil)`.
    ["xs.map{ it * 2 }", "(map (lambda (it) (* it 2)) xs)"],
    ["xs.filter{ it == 0 }", "(filter (lambda (it) (equal? it 0)) xs)"],
    // explicit params (≥2 antecedents break the `it` pronoun → must name; §7.3)
    ["xs.map{(y) => y}", "(map (lambda (y) y) xs)"],
    ["xs.fold(knil){(acc x) => acc + x}", "(fold (lambda (acc x) (+ acc x)) knil xs)"],
    // bare unary dots — the visible unary pipe `x.f.g ↦ (g (f x))`
    ["x.f.g", "(g (f x))"],
    ["n.number->string.display", "(display (number->string n))"],
    // mixed: method then subscript, method body with subscript key
    ["closure.map{ it[:verdict][0] }", "(map (lambda (it) (car (:verdict it))) closure)"],
    ["xs.map{ it * 2 }[0]", "(car (map (lambda (it) (* it 2)) xs))"],
    // a LOOSE brace is a sibling curly operand, not the method's lambda — a bare
    // method next to an infix curly must not swallow it (the §7.3 round-trip guard).
    ["(begin n.number->string.display {n + 1})", "(begin (display (number->string n)) (+ n 1))"],
  ];
  for (const [sweet, scheme] of cases) it(`${sweet} → ${scheme}`, () => expect(read(sweet)).toBe(scheme));
});

// §5 render gate — emit a chain iff ≥2 steps OR the single step is accessor / key /
// braced method. A lone bare unary canonicalizes to prefix (the §5 exceptionless cut).
describe("render: chain gate (≥2 steps OR a single accessor/key/braced)", () => {
  const cases: Array<[string, string]> = [
    ["(map (lambda (it) (* it 2)) xs)", "xs.map{ it * 2 }"],
    ["(filter (lambda (it) (equal? it 0)) xs)", "xs.filter{ it == 0 }"],
    ["(map (lambda (y) y) xs)", "xs.map{(y) => y}"],
    ["(map (lambda (it) (car (:verdict it))) closure)", "closure.map{ it[:verdict][0] }"],
    // ≥2 bare steps surface; a lone bare unary stays prefix
    ["(display (number->string n))", "n.number->string.display"],
    ["(not p)", "(not p)"], // lone bare unary → prefix, never p.not
    ["(g (f x))", "x.f.g"],
    // a bare op passed as a VALUE has no receiver step — never sugared
    ["(map car xs)", "(map car xs)"],
  ];
  for (const [scheme, sweet] of cases) it(`${scheme} → ${sweet}`, () => expect(render(scheme)).toBe(sweet));
});

// The render gate's canonical sublanguage: render ∘ ⟦·⟧ = id on C (cyclic idempotence).
describe("cyclic idempotence: sweet → scheme → sweet", () => {
  for (const sweet of [
    "xs.map{ it * 2 }",
    "xs.filter{ it == 0 }",
    "xs.map{(y) => y}",
    "closure.map{ it[:verdict][0] }",
    "x.f.g",
    "n.number->string.display",
  ]) {
    it(sweet, () => expect(render(read(sweet))).toBe(sweet));
  }
});

// §3.4 — a child line whose first token is a method-DOT folds onto the parent line's
// value (same CST + §4.3 fold as the inline chain, just broken by indentation).
describe("newline method chains (⏎.op)", () => {
  it("folds dot-lines onto the parent value", () => {
    const sweet = ["closure", "  .map{ it[:verdict] }", "  .filter{ it == \"miss\" }", "  .length"].join("\n");
    expect(readAll(sweet)).toBe(
      "(length (filter (lambda (it) (equal? it \"miss\")) (map (lambda (it) (:verdict it)) closure)))",
    );
  });

  it("inline and newline chains share one CST", () => {
    const inline = read("closure.map{ it[:verdict] }.length");
    const broken = readAll(["closure", "  .map{ it[:verdict] }", "  .length"].join("\n"));
    expect(broken).toBe(inline);
  });

  it("a long method chain renders broken: base ⏎ one .op per line", () => {
    const out = schemeToSweet(
      "(length (filter (lambda (item) (equal? (longish-field-name item) \"audience-miss\")) (map (lambda (item) (transform-the-record item)) the-closure-collection)))",
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("the-closure-collection");
    expect(lines.every((l, i) => i === 0 || l.trimStart().startsWith("."))).toBe(true);
  });
});

// §1 rewrite_L — a `\.` is a LITERAL dot in the symbol (unescaped on read, re-escaped
// on render); a `.` before a digit (`0.5`) or a double dot (`...`) never splits.
describe("dot-split edge cases", () => {
  it("escaped \\. is a literal-dot symbol, round-tripping", () => {
    expect(read("a\\.b")).toBe("a.b"); // one symbol "a.b", not (b a)
    expect(render("a.b")).toBe("a\\.b"); // re-escaped on the way back
  });
  it("decimals and ellipsis are never split", () => {
    expect(read("0.5")).toBe("0.5");
    expect(read("(x ...)")).toBe("(x ...)");
  });
});
