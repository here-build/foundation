// SRFI-105 curly-infix `{ … }` — reader integration (read direction).
//
// Drives `new Lexer` / `new Parser` directly (no exec/stdlib), mirroring
// lexer.test.ts and parser.test.ts. Assertions round-trip through `toString()`:
// `{a + b}` reads to the datum `(+ a b)`, so a normal list serialization proves
// the transform happened at read time — no render change is involved.
//
// Covers the SRFI-105 base classifier, our arithmetic-precedence divergence
// (resolveNfx, in core), the errors-as-door cases (no `$nfx$` ever), quote
// distribution, and non-regression of `()`/`[]` list reading.
import { describe, expect, it } from "vitest";
import { eof } from "../values/EOF.js";
import { Lexer } from "../reader/Lexer.js";
import { EOF } from "../values/EOF.js";
import { Parser } from "../reader/Parser.js";
import { SchemeSymbol } from "../values/SchemeSymbol.js";
import { canonicalizeCurly, FIXITY } from "../reader/curly-infix.js";
import type { SchemeValue } from "../values/types.js";

function lex(input: string): string[] {
  const lexer = new Lexer(input);
  const out: string[] = [];
  while (true) {
    const token = lexer.peek();
    if (token === eof) break;
    out.push(token as string);
    lexer.skip();
  }
  return out;
}

async function readAll(src: string): Promise<SchemeValue[]> {
  const parser = new Parser({});
  parser.parse(src);
  const out: SchemeValue[] = [];
  while (true) {
    const obj = await parser.read_object();
    if (obj instanceof EOF) break;
    out.push(obj as SchemeValue);
  }
  return out;
}

async function readOne(src: string): Promise<string> {
  const [datum] = await readAll(src);
  return String((datum as { toString(): string }).toString());
}

describe("curly-infix — lexer tokenization", () => {
  it("splits braces as standalone tokens", () => {
    expect(lex("{a + b}")).toEqual(["{", "a", "+", "b", "}"]);
  });
  it("tokenizes empty braces", () => {
    expect(lex("{}")).toEqual(["{", "}"]);
  });
  it("keeps a hyphenated symbol whole (only whitespace-bounded operators split)", () => {
    expect(lex("{n-1 + n-2}")).toEqual(["{", "n-1", "+", "n-2", "}"]);
  });
  it("nests braces", () => {
    expect(lex("{a * {b + c}}")).toEqual(["{", "a", "*", "{", "b", "+", "c", "}", "}"]);
  });
  it("splits a trailing brace off a symbol", () => {
    expect(lex("a}")).toEqual(["a", "}"]);
  });
  it("non-regression: square brackets unaffected", () => {
    expect(lex("[a b]")).toEqual(["[", "a", "b", "]"]);
  });
});

describe("curly-infix — SRFI-105 base classifier", () => {
  it("empty → ()", async () => {
    expect(await readOne("{}")).toBe("()");
  });
  it("single element escapes", async () => {
    expect(await readOne("{x}")).toBe("x");
  });
  it("two elements → prefix/unary", async () => {
    expect(await readOne("{- x}")).toBe("(- x)");
  });
  it("binary → prefix", async () => {
    expect(await readOne("{a + b}")).toBe("(+ a b)");
  });
  it("same-operator run → n-ary", async () => {
    expect(await readOne("{a + b + c}")).toBe("(+ a b c)");
    expect(await readOne("{a + b + c + d}")).toBe("(+ a b c d)");
  });
  it("nested curly on the right", async () => {
    expect(await readOne("{a * {b + c}}")).toBe("(* a (+ b c))");
  });
  it("nested curly on the left", async () => {
    expect(await readOne("{{a + b} - c}")).toBe("(- (+ a b) c)");
  });
  it("hyphenated operands stay whole", async () => {
    expect(await readOne("{n-1 + n-2}")).toBe("(+ n-1 n-2)");
  });
});

describe("curly-infix — arithmetic precedence (our formal divergence)", () => {
  it("multiplicative binds tighter than additive", async () => {
    expect(await readOne("{4 + 5 * 6}")).toBe("(+ 4 (* 5 6))");
    expect(await readOne("{a * b + c}")).toBe("(+ (* a b) c)");
    expect(await readOne("{a + b * c}")).toBe("(+ a (* b c))");
  });
  it("same-level mixed operators fold left-associatively", async () => {
    expect(await readOne("{a + b - c}")).toBe("(- (+ a b) c)");
  });
  it("additive run stays n-ary while multiplicative collapses to one operand", async () => {
    expect(await readOne("{a + b * c + d}")).toBe("(+ a (* b c) d)");
    expect(await readOne("{a * b * c + d}")).toBe("(+ (* a b c) d)");
  });
  it("named arithmetic operators are licensed", async () => {
    expect(await readOne("{10 modulo 3 + 1}")).toBe("(+ (modulo 10 3) 1)");
  });
});

describe("curly-infix — any single operator folds (SRFI-105)", () => {
  it("a lone boolean/comparison operator is a plain binary", async () => {
    expect(await readOne("{a && b}")).toBe("(&& a b)");
    expect(await readOne("{a < b}")).toBe("(< a b)");
  });
  it("a same-operator run folds n-ary regardless of which operator", async () => {
    expect(await readOne("{a && b && c}")).toBe("(&& a b c)");
    expect(await readOne("{a < b < c}")).toBe("(< a b c)");
  });
  it("any symbol in operator position is the operator", async () => {
    expect(await readOne("{a b c}")).toBe("(b a c)");
  });
});

describe("curly-infix — errors-as-door for MIXED operators (never emits $nfx$)", () => {
  // NOTE: `||` is R7RS pipe-symbol syntax (`|sym|`), so we use `&&`/`and`/`<` here.
  // The `||`→`or` (and `&&`→`and`, `==`→`equal?`) glyph map is a separate, deferred sweet feature.
  it("doors on mixed boolean/comparison operators", async () => {
    await expect(readOne("{a && b and c}")).rejects.toThrow("ambiguous operator mix");
    await expect(readOne("{a < b && c}")).rejects.toThrow("ambiguous operator mix");
  });
  it("doors on arithmetic mixed with an unlicensed operator, with a teaching hint", async () => {
    await expect(readOne("{a + b < c}")).rejects.toThrow("ambiguous operator mix");
    await expect(readOne("{a + b < c}")).rejects.toThrow("{{a + b} < c}");
  });
  it("doors on malformed parity / trailing operator", async () => {
    await expect(readOne("{a + b +}")).rejects.toThrow("malformed infix");
    await expect(readOne("{+ a + b}")).rejects.toThrow("malformed infix");
  });
  it("doors on a non-operator wedged into an operator slot", async () => {
    await expect(readOne("{a + b 5 c}")).rejects.toThrow("malformed infix");
  });
});

describe("curly-infix — quote distribution", () => {
  it("quote wraps the resolved datum", async () => {
    expect(await readOne("'{a + b}")).toBe("(quote (+ a b))");
    expect(await readOne("'{a + b + c}")).toBe("(quote (+ a b c))");
  });
  it("quasiquote/unquote compose", async () => {
    expect(await readOne("`{,a + ,b}")).toBe("(quasiquote (+ (unquote a) (unquote b)))");
  });
});

describe("curly-infix — non-regression", () => {
  it("square brackets still read as an ordinary list", async () => {
    expect(await readOne("[a b]")).toBe("(a b)");
  });
  it("parenthesized forms unchanged", async () => {
    expect(await readOne("(+ 1 2)")).toBe("(+ 1 2)");
  });
  it("curly nested inside a normal list", async () => {
    expect(await readOne("(a {b + c} d)")).toBe("(a (+ b c) d)");
  });
  it("bracket-list as a curly operand", async () => {
    expect(await readOne("{[a b] + c}")).toBe("(+ (a b) c)");
  });
  it("reads multiple top-level curly forms", async () => {
    const out = await readAll("{a + b} {c * d}");
    expect(out.map((d) => String(d))).toEqual(["(+ a b)", "(* c d)"]);
  });
});

describe("curly-infix — structural errors", () => {
  it("unterminated brace", async () => {
    await expect(readOne("{a + b")).rejects.toThrow("unterminated curly-infix");
  });
  it("stray closing brace", async () => {
    await expect(readOne("}")).rejects.toThrow("unexpected '}'");
  });
  it("dotted pair is rejected inside curly", async () => {
    await expect(readOne("{a . z}")).rejects.toThrow("'.' not allowed in curly-infix");
  });
  it("deep nesting trips the stack-depth guard", async () => {
    await expect(readOne("{".repeat(3000))).rejects.toThrow("nesting depth exceeded");
  });
});

describe("curly-infix — pure module is independently testable", () => {
  it("FIXITY licenses exactly the arithmetic operators", () => {
    expect(Object.keys(FIXITY).sort()).toEqual(
      ["*", "+", "-", "/", "modulo", "quotient", "remainder"].sort(),
    );
    expect(FIXITY["*"].prec).toBeGreaterThan(FIXITY["+"].prec);
  });
  it("canonicalizeCurly escapes a single element", () => {
    const sym = new SchemeSymbol("x");
    expect(canonicalizeCurly([sym])).toBe(sym);
  });
});
