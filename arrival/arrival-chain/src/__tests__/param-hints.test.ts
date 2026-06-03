/**
 * Parameter inlay hints over classic scheme: a call to a `(define (f …)…)` gets a
 * hint before each positional arg naming its formal. Pins the resolver — the define
 * shapes it reads, the binding sites it skips, and the edges (builtins, arity,
 * kwargs, rest, parse error).
 */
import { describe, expect, it } from "vitest";
import { paramHints, paramHintsSweet } from "../param-hints.js";
import { schemeToSweet } from "../sweet-render.js";

/** The char immediately at a hint's pos — should be the first char of its arg. */
const charAt = (src: string, pos: number): string => src[pos];

describe("paramHints", () => {
  it("hints each positional arg of a call to a function-define, in order, at the arg's start", () => {
    const src = `(define (evolve pool budget rng iter) (list pool budget rng iter))
(evolve (list seed) (- BUDGET 1) SEED-RNG 0)`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    // Each pos lands on the start of the arg it labels.
    expect(src.startsWith("(list seed)", hints[0].pos)).toBe(true);
    expect(src.startsWith("(- BUDGET 1)", hints[1].pos)).toBe(true);
    expect(src.startsWith("SEED-RNG", hints[2].pos)).toBe(true);
    expect(charAt(src, hints[3].pos)).toBe("0");
  });

  it("reads the (define f (lambda …)) shape too", () => {
    const src = `(define greet (lambda (name greeting) greeting))\n(greet "ada" "hi")`;
    expect(paramHints(src).map((h) => h.name)).toEqual(["name", "greeting"]);
  });

  it("does NOT hint the define's own formals (binding site, not a call)", () => {
    expect(paramHints(`(define (f a b) (+ a b))`)).toEqual([]);
  });

  it("skips builtins — no define to read formals from", () => {
    expect(paramHints(`(define (f a) a)\n(list 1 2 3)`)).toEqual([]); // f uncalled; list not hinted
  });

  it("stops at arity — a 3rd arg to a 2-param fn gets no hint", () => {
    expect(paramHints(`(define (f a b) a)\n(f 1 2 3)`).map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("skips a kwarg call (self-labeling)", () => {
    expect(paramHints(`(define (f a b) a)\n(f :a 1 :b 2)`)).toEqual([]);
  });

  it("hints nested calls independently", () => {
    const names = paramHints(`(define (f x) x)\n(define (g y) y)\n(f (g 1))`)
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(["x", "y"]);
  });

  it("drops a dotted-rest tail from positional hints", () => {
    expect(paramHints(`(define (f a . rest) a)\n(f 1 2 3)`).map((h) => h.name)).toEqual(["a"]);
  });

  it("returns [] on a parse error (mid-edit)", () => {
    expect(paramHints(`(define (f a b`)).toEqual([]);
  });
});

describe("paramHintsSweet — the sweet lens", () => {
  it("hints over RENDERED sweet, at sweet-text offsets pointing to each arg", () => {
    const classic = `(define (evolve pool budget rng iter) (list pool budget rng iter))

(evolve (list seed) (- BUDGET (length paretoset)) SEED-RNG 0)`;
    const sweet = schemeToSweet(classic); // what the sweet editor buffer shows
    const hints = paramHintsSweet(sweet);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    // Each pos is in-bounds, ascending, and lands on a non-whitespace char (an arg start).
    let prev = -1;
    for (const h of hints) {
      expect(h.pos).toBeGreaterThan(prev);
      expect(/\S/.test(sweet[h.pos])).toBe(true);
      prev = h.pos;
    }
  });

  it("hand-written sweet (indented body + curly arg) — names resolve", () => {
    const sweet = `define (evolve pool budget rng iter)
  (list pool budget rng iter)

evolve (list seed) {BUDGET - (length paretoset)} SEED-RNG 0`;
    const hints = paramHintsSweet(sweet);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    expect(sweet.startsWith("(list seed)", hints[0].pos)).toBe(true);
    expect(sweet.startsWith("{BUDGET", hints[1].pos)).toBe(true);
    expect(sweet.startsWith("SEED-RNG", hints[2].pos)).toBe(true);
    expect(sweet[hints[3].pos]).toBe("0");
  });

  it("returns [] on malformed sweet", () => {
    expect(paramHintsSweet(`define (f a b`)).toEqual([]);
  });
});
