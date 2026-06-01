/**
 * Tests + debug harness for the classic↔sweet renderer spike (sweet-render.ts).
 *
 * Three groups:
 *   1. bijection  — flatten ∘ inflate = id over every real .scm (the core safety
 *                   law: store flat, view paired, read back flat, lose nothing).
 *                   Failures show a classic-printed diff of the offending form.
 *   2. units      — focused render assertions (curly-infix, colon/=> pairing,
 *                   positional-not-paired). Add cases here to probe behaviour.
 *   3. dump       — console.logs the full sweet rendering of each fixture+example
 *                   so you can eyeball it in the run output (always passes).
 *
 * Run + SEE the dumps:  npx vitest run sweet-render --disableConsoleIntercept
 * Watch while editing:  npx vitest sweet-render --disableConsoleIntercept
 *
 * The flag matters: vitest 4 SWALLOWS console.log by default in this package, so
 * without --disableConsoleIntercept the dump group is silent (the tests still
 * pass, you just see nothing). The flag restores stdout. (Alternatively swap
 * console.log → process.stdout.write, which bypasses the intercept flag-free.)
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  schemeToSweet, parseSexprs, collectKwargHeads, inflateKwargs, flattenKwargs,
  type Node,
} from "../sweet-render.js";

const FIX = path.resolve(import.meta.dirname, "fixtures/programs");
const EX = path.resolve(import.meta.dirname, "../../../../../examples/host-custdev");

const scmFiles = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".scm")).map((f) => path.join(dir, f)) : [];

/** [shortLabel, absPath] tuples for it.each titles. */
const cases = (...dirs: string[]): Array<readonly [string, string]> =>
  dirs.flatMap(scmFiles).map((f) => [f.split("/").slice(-2).join("/"), f] as const);

/** Print a parsed tree back to classic s-expr text — used for readable diffs. */
function show(nd: Node): string {
  if ("atom" in nd) return nd.str ? JSON.stringify(nd.atom) : nd.atom;
  return "(" + nd.list.map(show).join(" ") + ")";
}

describe("sweet-render", () => {
  describe("bijection: flatten ∘ inflate = id", () => {
    it.each(cases(FIX, EX))("%s", (_label, file) => {
      const forms = parseSexprs(fs.readFileSync(file, "utf-8"));
      const heads = collectKwargHeads(forms);
      for (const f of forms) {
        // Compare as classic text → vitest shows exactly which subform diverged.
        expect(show(flattenKwargs(inflateKwargs(f, heads)))).toBe(show(f));
      }
    });
  });

  describe("units", () => {
    const sweet = (s: string, opts = {}) => schemeToSweet(s, opts);

    it("curly-infix with display glyphs (= → ==, and/or → &&/||)", () => {
      expect(sweet("(- n 1)")).toBe("{n - 1}");
      expect(sweet("(= n 0)")).toBe("{n == 0}"); // = renders == (avoids assignment read)
      expect(sweet("(equal? a b)")).toBe("{a == b}");
      expect(sweet("(+ a b c)")).toBe("{a + b + c}"); // n-ary same op
      expect(sweet("(and p q)")).toBe("{p && q}");
      expect(sweet("(or p q)")).toBe("{p || q}");
    });

    it("arrow lambda renders curly-wrapped", () => {
      expect(sweet("(lambda (x) (* x 2))")).toBe("{(x) => x * 2}");
      expect(sweet("(lambda (a b) (+ a b))")).toBe("{(a b) => a + b}");
    });

    it("precedence ladder: tighter children drop braces, looser keep them", () => {
      expect(sweet('(or (equal? v "a") (equal? v "b"))')).toBe('{v == "a" || v == "b"}');
      expect(sweet("(* (+ a b) c)")).toBe("{{a + b} * c}");      // + (looser) braced under *
      expect(sweet("(< (- a b) c)")).toBe("{a - b < c}");        // - (tighter) shares under <
      expect(sweet("(and (or a b) c)")).toBe("{{a || b} && c}"); // || (looser) braced under &&
      expect(sweet("(- a (- b c))")).toBe("{a - {b - c}}");      // non-assoc grouping preserved
      expect(sweet("(lambda (r) (or (< (key r) 5) (equal? (key r) v)))"))
        .toBe("{(r) => (key r) < 5 || (key r) == v}");           // arrow + nested precedence
    });

    it("non-infix heads stay prefix", () => {
      expect(sweet("(cons a b)")).toBe("(cons a b)");
    });

    // narrow width forces the dict to break vertically → pairing kicks in
    // (inline forms stay flat classic by design).
    it("dict kwargs pair with colon when broken", () => {
      const out = sweet("(dict :alpha first-value :beta second-value :gamma third-value)", { width: 24 });
      expect(out).toContain("alpha: first-value");
      expect(out).toContain("beta: second-value");
      expect(out).not.toContain(":alpha"); // leading colon flipped to trailing
    });

    it("=> glyph variant keeps the leading colon", () => {
      const out = sweet("(dict :alpha first-value :beta second-value :gamma third-value)", { width: 24, pairGlyph: "=>" });
      expect(out).toContain(":alpha => first-value");
    });

    it("positional args under a non-kwarg head are NOT paired", () => {
      // `where` isn't a kwarg-head; :bucket / value stay positional.
      const out = sweet('(filter (where :bucket "audience-miss") some-very-long-list-name-here)');
      expect(out).toContain('(where :bucket "audience-miss")');
    });

    it("leading positional (cache-key) before kwargs stays unpaired", () => {
      const src = `(define gen (require "x.prompt"))
        (gen the-cache-key :alpha first-value :beta second-value :gamma third-value)`;
      const out = sweet(src);
      expect(out).toContain("the-cache-key");
      expect(out).toContain("alpha: first-value");
    });
  });

  describe("dump (eyeball — logged to stdout)", () => {
    it.each(cases(FIX, EX))("%s", (label, file) => {
      const sweet = schemeToSweet(fs.readFileSync(file, "utf-8"));
      console.log(`\n┌──────── ${label} ────────\n${sweet}\n└────────`);
    });
  });
});
