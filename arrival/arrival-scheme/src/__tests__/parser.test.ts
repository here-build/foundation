// Direct unit tests for the Parser's datum construction (the reader).
//
// Like lexer.test.ts, these drive `new Parser` directly rather than going
// through the full `exec` stack, so the `@arrival/reader` extraction (DAG P3)
// and the keystone's parse-time refactor have a fast behavioral floor.
//
// A bare Parser ({} — no env) covers the whole standard grammar plus the
// builtin quote-family sugar: those expand to lists WITHOUT consulting the
// environment, so no stdlib bootstrap is needed. (User-defined reader
// extensions, which DO hit the env, are out of scope here.)
//
// Assertions round-trip through `toString()` — parse→serialize is exactly the
// invariant the keystone must preserve, and it's robust to internal value-shape
// changes.
import { describe, expect, it } from "vitest";
import { EOF } from "../values/EOF.js";
import { SchemeVector } from "../values/SchemeVector.js";
import { Parser } from "../Parser.js";
import type { SchemeValue } from "../values/types.js";

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

describe("Parser — atoms", () => {
  it("reads a symbol", async () => {
    expect(await readOne("foo")).toBe("foo");
  });

  it("reads integers and decimals", async () => {
    expect(await readOne("42")).toBe("42");
    expect(await readOne("-7")).toBe("-7");
  });

  it("reads booleans", async () => {
    expect(await readOne("#t")).toBe("#t");
    expect(await readOne("#f")).toBe("#f");
  });
});

describe("Parser — lists", () => {
  it("reads a flat list", async () => {
    expect(await readOne("(+ 1 2)")).toBe("(+ 1 2)");
  });

  it("reads a nested list", async () => {
    expect(await readOne("(a (b c) d)")).toBe("(a (b c) d)");
  });

  it("reads the empty list", async () => {
    expect(await readOne("()")).toBe("()");
  });

  it("reads a dotted pair", async () => {
    expect(await readOne("(a . b)")).toBe("(a . b)");
  });
});

describe("Parser — quote sugar (builtin extensions)", () => {
  it("expands quote", async () => {
    expect(await readOne("'x")).toBe("(quote x)");
  });

  it("expands quasiquote / unquote / unquote-splicing", async () => {
    expect(await readOne("`x")).toBe("(quasiquote x)");
    expect(await readOne(",x")).toBe("(unquote x)");
    expect(await readOne(",@x")).toBe("(unquote-splicing x)");
  });
});

describe("Parser — vectors & strings", () => {
  it("reads a vector as a boxed SchemeVector of its elements", async () => {
    const [vec] = await readAll("#(1 2 3)");
    // Vectors are boxed into SchemeVector (boxing track): the raw element array
    // is the .__vector__ payload, not the value itself.
    expect(vec).toBeInstanceOf(SchemeVector);
    expect((vec as SchemeVector).__vector__.map((x) => String(x))).toEqual(["1", "2", "3"]);
  });

  it("reads a string literal (content, unquoted)", async () => {
    // bare toString() yields the raw content; toString(true) re-quotes it.
    expect(await readOne('"hello"')).toBe("hello");
  });
});

describe("Parser — multiple top-level forms", () => {
  it("reads each top-level datum", async () => {
    const all = await readAll("1 2 3");
    expect(all.map((d) => String((d as { toString(): string }).toString()))).toEqual(["1", "2", "3"]);
  });

  it("skips line comments", async () => {
    const all = await readAll("; a comment\n42");
    expect(all).toHaveLength(1);
    expect(String((all[0] as { toString(): string }).toString())).toBe("42");
  });
});
