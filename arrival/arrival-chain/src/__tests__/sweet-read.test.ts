/**
 * Read direction, phase 1: curly-infix + arrow reader (sweet-read.ts).
 *
 * The law: read(render(x)) ≡ x on classic — viewing-then-saving must not mutate
 * stored scm. Here over fully-delimited expressions (no indentation/colon-pairs;
 * those are phase 2). Renders with inlineSweet (always one line) so we exercise
 * the curly path, then reads back and compares trees.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseSexprs, schemeToSweet, inlineSweet, DEFAULT_OPTS, nodeEq, type Node } from "../sweet-render.js";
import { readSweetExpr, readSweet } from "../sweet-read.js";

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
    "(= n 0)",                                     // numeric = round-trips faithfully now
    "(eq? a b)",                                   // eq?/eqv? render & read as themselves
    "(eqv? x y)",
  ])("%s", (src) => {
    const r = roundTrips(src);
    expect(r.ok, `${src}\n  render→ ${r.sweet}\n  read→   ${r.got}`).toBe(true);
  });

  // The glyph map is injective now, so equality round-trips by KIND, not collapsed.
  it("equality kinds stay distinct through the round-trip", () => {
    expect(roundTrips("(= n 0)").got).toBe("(= n 0)");          // numeric, NOT equal?
    expect(roundTrips("(equal? a b)").got).toBe("(equal? a b)"); // structural
    expect(roundTrips("(eq? a b)").got).toBe("(eq? a b)");       // identity
  });
});

describe("full reader: classic → schemeToSweet → readSweet ≡ classic", () => {
  const FIX = path.resolve(import.meta.dirname, "fixtures/programs");
  const EX = path.resolve(import.meta.dirname, "../../../../../examples/host-custdev");
  const files = [FIX, EX].flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".scm")).map((f) => path.join(dir, f)) : [],
  );

  it.each(files.map((f) => [f.split("/").slice(-2).join("/"), f] as const))("%s", (_label, file) => {
    const src = fs.readFileSync(file, "utf-8");
    const classicForms = parseSexprs(src);
    const sweet = schemeToSweet(src);
    const back = readSweet(sweet);
    expect(back.length, "form count").toBe(classicForms.length);
    for (let i = 0; i < classicForms.length; i++) {
      expect(
        nodeEq(back[i], classicForms[i]),
        `form ${i} (${file.split("/").pop()})\n  classic: ${show(classicForms[i])}\n  sweet:\n${sweet.split("\n\n")[i]}\n  read:    ${show(back[i])}`,
      ).toBe(true);
    }
  });
});
