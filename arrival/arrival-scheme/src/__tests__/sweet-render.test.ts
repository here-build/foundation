// canonizer render side — `renderSweet` emits the preferred sweet surface from a canonical s-expr,
// and the round-trip law `read(renderSweet(c)) === c` holds (the registry's bidirectional bifunctor).
import { describe, expect, it } from "vitest";
import { EOF } from "../EOF.js";
import { Parser } from "../Parser.js";
import { renderSweet } from "../canonizer.js";
import type { SchemeValue } from "../types.js";

async function read(src: string): Promise<SchemeValue> {
  const parser = new Parser({});
  parser.parse(src);
  const obj = await parser.read_object();
  return obj as SchemeValue;
}

describe("renderSweet — emit canonical → preferred sweet surface", () => {
  it("arithmetic infix (incl. n-ary)", async () => {
    expect(renderSweet(await read("(+ a b)"))).toBe("{a + b}");
    expect(renderSweet(await read("(* a b)"))).toBe("{a * b}");
    expect(renderSweet(await read("(+ a b c)"))).toBe("{a + b + c}");
  });
  it("precedence — brace-minimal where the child binds tighter", async () => {
    expect(renderSweet(await read("(+ a (* b c))"))).toBe("{a + b * c}");
    expect(renderSweet(await read("(* (+ a b) c)"))).toBe("{{a + b} * c}");
  });
  it("glyph substitution on emit (verb → glyph)", async () => {
    expect(renderSweet(await read("(and a b)"))).toBe("{a && b}");
    expect(renderSweet(await read("(equal? a b)"))).toBe("{a == b}");
    expect(renderSweet(await read("(or/maybe a b)"))).toBe("{a ?? b}");
  });
  it("comparison renders infix; non-arith nesting keeps braces", async () => {
    expect(renderSweet(await read("(< a b)"))).toBe("{a < b}");
    expect(renderSweet(await read("(and (equal? a b) c)"))).toBe("{{a == b} && c}");
  });
  it("non-infix heads stay prefix; nested infix still surfaces", async () => {
    expect(renderSweet(await read("(f x y)"))).toBe("(f x y)");
    expect(renderSweet(await read("(f (+ a b))"))).toBe("(f {a + b})");
  });
});

describe("renderSweet — round-trip law: read(renderSweet(c)) === c", () => {
  const cases = [
    "(+ a b)",
    "(* a b)",
    "(+ a b c)",
    "(+ a (* b c))",
    "(* (+ a b) c)",
    "(- (+ a b) c)",
    "(and a b)",
    "(equal? a b)",
    "(or/maybe a b)",
    "(and a b c)",
    "(< a b)",
    "(and (equal? a b) c)",
    "(f x y)",
    "(f (+ a b))",
    "(+ a (+ b c))",
    "(+ (+ a b) c)",
  ];
  for (const c of cases) {
    it(c, async () => {
      const form = await read(c);
      const back = await read(renderSweet(form));
      expect(String(back)).toBe(String(form));
    });
  }
});
