import { describe, expect, it } from "vitest";

import { alignSweetClassic } from "../sweet-align.js";
import { schemeToSweet } from "../sweet-render.js";

/** Translate the position of `needle`'s first char in `sweet` to classic and
 *  read back what classic token sits there — the round-trip a hover query makes. */
function classicTokenAt(sweet: string, needle: string): string | null {
  const a = alignSweetClassic(sweet);
  if (a === null) return null;
  const pos = sweet.indexOf(needle);
  if (pos === -1) throw new Error(`needle '${needle}' not in sweet text`);
  const cPos = a.toClassic(pos);
  if (cPos === null) return null;
  const m = /^[\w\-!$%&*+./<=>?@^~]+/.exec(a.classic.slice(cPos));
  return m ? m[0] : a.classic[cPos];
}

describe("alignSweetClassic", () => {
  it("derives the canonical classic from the sweet buffer", () => {
    const sweet = schemeToSweet(`(define (double n) (* n 2))`);
    const a = alignSweetClassic(sweet);
    expect(a).not.toBeNull();
    expect(a!.classic).toContain("(define (double n)");
    expect(a!.classic).toContain("(* n 2)");
  });

  it("maps positions through exact atom pairs, offset-precise", () => {
    const sweet = schemeToSweet(`(define (double n) (* n 2))`);
    expect(classicTokenAt(sweet, "double")).toBe("double");
    // Mid-atom: position on 'u' of double still lands inside the classic atom.
    const a = alignSweetClassic(sweet)!;
    const pos = sweet.indexOf("double") + 2;
    const cPos = a.toClassic(pos)!;
    expect(a.classic.slice(cPos - 2, cPos + 4)).toBe("double");
  });

  it("maps atoms inside curly-infix back to the prefix form", () => {
    // {n - 1} in sweet ↔ (- n 1) in classic: n and 1 are exact pairs.
    const sweet = schemeToSweet(`(define (dec n) (- n 1))`);
    expect(sweet).toContain("{n - 1}");
    expect(classicTokenAt(sweet, "n -")).toBe("n");
  });

  it("declines positions on sugar (the infix glyph) instead of guessing", () => {
    const sweet = schemeToSweet(`(define (eq-check a b) (equal? a b))`);
    expect(sweet).toContain("==");
    const a = alignSweetClassic(sweet)!;
    expect(a.toClassic(sweet.indexOf("=="))).toBeNull();
  });

  it("lifts a classic span inside sugar to the enclosing paired node", () => {
    const sweet = schemeToSweet(`(define (eq-check a b) (equal? a b))`);
    const a = alignSweetClassic(sweet)!;
    // The classic `equal?` atom has no exact sweet twin (rendered `==`) — a
    // diagnostic on it lifts to a containing span, still inside the sweet text.
    const eqPos = a.classic.indexOf("equal?");
    const span = a.toSweet(eqPos, "equal?".length);
    expect(span).not.toBeNull();
    const lifted = sweet.slice(span!.start, span!.start + span!.length);
    expect(lifted).toContain("==");
  });

  it("round-trips spans through elided let bindings", () => {
    const classic = `(define (f xs) (let ((head (car xs)) (rest (cdr xs))) (cons head rest)))`;
    const sweet = schemeToSweet(classic);
    expect(sweet).not.toContain("(("); // bindings elided in the view
    const a = alignSweetClassic(sweet)!;
    const cPos = a.toClassic(sweet.indexOf("head"))!;
    expect(a.classic.slice(cPos, cPos + 4)).toBe("head");
    // And back: the classic `rest` binder maps to the sweet `rest` line.
    const rPos = a.classic.indexOf("rest");
    const span = a.toSweet(rPos, 4)!;
    expect(sweet.slice(span.start, span.start + span.length)).toBe("rest");
  });

  it("maps string literals (spans include the quotes on both sides)", () => {
    const sweet = schemeToSweet(`(define greeting (string-append "hello" name))`);
    const a = alignSweetClassic(sweet)!;
    const sPos = sweet.indexOf('"hello"');
    const cPos = a.toClassic(sPos + 1)!; // inside the string
    expect(a.classic.slice(cPos - 1, cPos + 6)).toBe('"hello"');
  });

  it("returns null on a mid-edit unparseable buffer", () => {
    expect(alignSweetClassic("define (f x\n  {x +")).toBeNull();
  });

  it("survives sweet-only edits: alignment is over the buffer as typed", () => {
    // Hand-written sweet (not a render output) still aligns — the classic is
    // derived from THIS buffer, not recovered from any stored original.
    const sweet = "define (triple n)\n  {n * 3}";
    const a = alignSweetClassic(sweet)!;
    expect(a.classic).toBe("(define (triple n) (* n 3))");
    const cPos = a.toClassic(sweet.indexOf("triple"))!;
    expect(a.classic.slice(cPos, cPos + 6)).toBe("triple");
  });
});
