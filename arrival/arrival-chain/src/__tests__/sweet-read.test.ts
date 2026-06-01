/**
 * Read direction, phase 1: curly-infix + arrow reader (sweet-read.ts).
 *
 * The law: read(render(x)) ≡ x on classic — viewing-then-saving must not mutate
 * stored scm. Here over fully-delimited expressions (no indentation/colon-pairs;
 * those are phase 2). Renders with inlineSweet (always one line) so we exercise
 * the curly path, then reads back and compares trees.
 */
import { describe, it, expect } from "vitest";
import { parseSexprs, inlineSweet, DEFAULT_OPTS, nodeEq, type Node } from "../sweet-render.js";
import { readSweetExpr } from "../sweet-read.js";

const classic = (src: string): Node => parseSexprs(src)[0];
const show = (n: Node): string => ("atom" in n ? (n.str ? JSON.stringify(n.atom) : n.atom) : "(" + n.list.map(show).join(" ") + ")");
const roundTrips = (src: string) => {
  const tree = classic(src);
  const sweet = inlineSweet(tree, DEFAULT_OPTS);
  const back = readSweetExpr(sweet);
  return { sweet, ok: nodeEq(back, tree), got: show(back), want: show(tree) };
};

describe("sweet-read: read(render(x)) ≡ x", () => {
  // these survive the round-trip exactly
  it.each([
    "(equal? a b)",
    "(or (equal? v \"click\") (equal? v \"keep-reading\"))",
    "(and (or a b) c)",
    "(* (+ a b) c)",
    "(< (- a b) c)",
    "(+ a b c)",                                  // n-ary flattens + re-collects
    "(- a (- b c))",                              // non-assoc grouping
    "(lambda (x) (* x 2))",
    "(lambda (a b) (+ a b))",
    "(lambda (r) (or (< (key r) 5) (equal? (key r) v)))",
    "(map (lambda (p) (list p (cell p))) xs)",    // classic call wrapping an arrow operand
  ])("%s", (src) => {
    const r = roundTrips(src);
    expect(r.ok, `${src}\n  render→ ${r.sweet}\n  read→   ${r.got}`).toBe(true);
  });

  // KNOWN non-injectivity: `=`/`eq?`/`eqv?` render `==`, which reads back `equal?`.
  // Behaviour-identical for exact integers (the showcase's only `=` use), but NOT
  // syntactically faithful — a decision for V (accept canonicalization vs un-collapse).
  it("numeric = canonicalizes to equal? on round-trip (documented)", () => {
    const r = roundTrips("(= n 0)");
    expect(r.sweet).toBe("{n == 0}");
    expect(r.got).toBe("(equal? n 0)"); // NOT (= n 0)
  });
});
