// Direct unit tests for the Lexer FSM (the reader's true leaf).
//
// Until now the lexer was only exercised transitively through end-to-end
// `exec`/`parse` tests, so a refactor of the reader had no fast safety net.
// These tests drive `new Lexer` directly — they're the floor the
// `@arrival/reader` extraction (DAG P3) and the keystone's Parser surgery need.
//
// The lexer is a self-contained incremental FSM with zero dependency on the
// evaluator, so these run without any environment/stdlib bootstrap.
import { describe, expect, it } from "vitest";
import { eof } from "../values/EOF.js";
import { Lexer } from "../reader/Lexer.js";

/** Collect every meaningful token (string form) from an input. */
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

describe("Lexer — atoms & numbers", () => {
  it("tokenizes a bare symbol", () => {
    expect(lex("foo")).toEqual(["foo"]);
  });

  it("tokenizes integers and decimals", () => {
    expect(lex("42")).toEqual(["42"]);
    expect(lex("3.14")).toEqual(["3.14"]);
    expect(lex("-7")).toEqual(["-7"]);
  });

  it("splits whitespace-separated atoms", () => {
    expect(lex("a b c")).toEqual(["a", "b", "c"]);
  });

  it("tokenizes booleans and chars", () => {
    expect(lex("#t #f")).toEqual(["#t", "#f"]);
    expect(lex("#\\a")).toEqual(["#\\a"]);
  });
});

describe("Lexer — structure", () => {
  it("tokenizes parens as distinct tokens", () => {
    expect(lex("(+ 1 2)")).toEqual(["(", "+", "1", "2", ")"]);
  });

  it("tokenizes nested lists", () => {
    expect(lex("(a (b c) d)")).toEqual(["(", "a", "(", "b", "c", ")", "d", ")"]);
  });

  it("tokenizes brackets", () => {
    expect(lex("[a b]")).toEqual(["[", "a", "b", "]"]);
  });

  it("tokenizes the dotted-pair dot", () => {
    expect(lex("(a . b)")).toEqual(["(", "a", ".", "b", ")"]);
  });

  it("tokenizes vector and bytevector openers", () => {
    expect(lex("#(1 2)")).toEqual(["#(", "1", "2", ")"]);
    expect(lex("#u8(1 2)")).toEqual(["#u8(", "1", "2", ")"]);
  });
});

describe("Lexer — strings & quote sugar", () => {
  it("keeps a string literal as one token", () => {
    expect(lex('"hello world"')).toEqual(['"hello world"']);
  });

  it("keeps escapes inside a string as one token", () => {
    expect(lex('"a\\"b"')).toEqual(['"a\\"b"']);
  });

  it("tokenizes quote-family prefixes", () => {
    expect(lex("'x")).toEqual(["'", "x"]);
    expect(lex("`x")).toEqual(["`", "x"]);
    expect(lex(",x")).toEqual([",", "x"]);
    expect(lex(",@x")).toEqual([",@", "x"]);
  });
});

describe("Lexer — edge cases", () => {
  it("returns nothing for empty / whitespace-only input", () => {
    expect(lex("")).toEqual([]);
    expect(lex("   \n\t ")).toEqual([]);
  });

  it("peek without skip is idempotent", () => {
    const lexer = new Lexer("(a b)");
    expect(lexer.peek()).toBe(lexer.peek());
  });

  it("eof is returned past the end", () => {
    const lexer = new Lexer("x");
    lexer.peek(); // skip() advances the last-peeked token, so peek first
    lexer.skip();
    expect(lexer.peek()).toBe(eof);
  });
});
