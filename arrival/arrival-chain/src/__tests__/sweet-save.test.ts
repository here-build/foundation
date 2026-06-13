/**
 * Save-back direction: editable sweet → canonical classic (sweet-read.ts's
 * sweetToScheme + topFormSpans, sweet-render.ts's printScheme).
 *
 * The laws under test:
 *   1. printScheme round-trips at the AST level — parseSexprs(printScheme(f)) ≡ f,
 *      at every width (it only adds whitespace over inlineScheme's encoding).
 *   2. STORAGE STABILITY (the bifunctor's GetPut on text): saving an UNEDITED sweet
 *      view is byte-identical — sweetToScheme(schemeToSweet(c), c) === c. This
 *      jointly validates topFormSpans (span boundaries) + the no-churn splice path.
 *   3. topFormSpans counts top-level forms exactly as parseSexprs does.
 *   4. an edit splices only the changed form (untouched forms survive byte-for-byte);
 *      a form added/removed falls back to canonical reprint; malformed sweet throws.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseSexprs, printScheme, nodeEq, schemeToSweet, type Node } from "@here.build/arrival-scheme";
import { sweetToScheme, topFormSpans } from "../sweet-read.js";

const FIX = path.resolve(import.meta.dirname, "fixtures/programs");
const EX = path.resolve(import.meta.dirname, "../../../../../examples/host-custdev");
const files = [FIX, EX].flatMap((dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".scm")).map((f) => path.join(dir, f)) : [],
);
const labelled = files.map((f) => [f.split("/").slice(-2).join("/"), f] as const);
const show = (n: Node): string => ("atom" in n ? (n.str ? JSON.stringify(n.atom) : n.atom) : "(" + n.list.map(show).join(" ") + ")");

describe("printScheme: parseSexprs(printScheme(f)) ≡ f", () => {
  it.each(labelled)("%s", (label, file) => {
    const forms = parseSexprs(fs.readFileSync(file, "utf-8"));
    for (const f of forms) {
      for (const width of [80, 20, 9999]) {
        const printed = printScheme(f, 0, width);
        const back = parseSexprs(printed);
        expect(back.length, `${label} w=${width}\n${printed}`).toBe(1);
        expect(
          nodeEq(back[0], f),
          `${label} w=${width}\n  printed:\n${printed}\n  got:  ${show(back[0])}\n  want: ${show(f)}`,
        ).toBe(true);
      }
    }
  });
});

describe("topFormSpans counts forms like parseSexprs", () => {
  it.each(labelled)("%s", (_label, file) => {
    const src = fs.readFileSync(file, "utf-8");
    expect(topFormSpans(src).length).toBe(parseSexprs(src).length);
  });
});

describe("storage stability: sweetToScheme(schemeToSweet(c), c) === c (byte-identical)", () => {
  it.each(labelled)("%s", (label, file) => {
    const src = fs.readFileSync(file, "utf-8");
    const out = sweetToScheme(schemeToSweet(src), src);
    expect(out, `unedited save-back must not touch storage for ${label}`).toBe(src);
  });
});

describe("sweetToScheme edits", () => {
  it("per-form splice preserves the untouched form byte-for-byte", () => {
    const src = "(define x 1)\n\n(define (f n)\n  (+ n 100))\n";
    const sweet = schemeToSweet(src);
    const edited = sweet.replace("(define x 1)", "(define x 42)"); // value-defines render classic-inline
    expect(edited).not.toBe(sweet); // the edit landed
    const out = sweetToScheme(edited, src);
    // the untouched second form survived byte-for-byte (its hand-formatting intact)
    expect(out).toContain("(define (f n)\n  (+ n 100))");
    const got = parseSexprs(out);
    expect(got.length).toBe(2);
    expect(nodeEq(got[0], parseSexprs("(define x 42)")[0])).toBe(true);
    expect(nodeEq(got[1], parseSexprs("(define (f n) (+ n 100))")[0])).toBe(true);
  });

  it("a form added in sweet → canonical whole-file reprint (count mismatch)", () => {
    const src = "(define x 1)\n";
    const sweet = schemeToSweet(src) + "\n\n(define y 2)";
    const got = parseSexprs(sweetToScheme(sweet, src));
    expect(got.length).toBe(2);
    expect(nodeEq(got[0], parseSexprs("(define x 1)")[0])).toBe(true);
    expect(nodeEq(got[1], parseSexprs("(define y 2)")[0])).toBe(true);
  });

  it("malformed sweet throws (caller keeps its buffer and skips the save)", () => {
    expect(() => sweetToScheme("(((", "(+ a 1)\n")).toThrow();
  });
});
