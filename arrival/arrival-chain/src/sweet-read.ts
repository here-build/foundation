/**
 * Sweet → classic READER, phase 1: the curly-infix + arrow sub-reader.
 *
 * Inverts the render direction (sweet-render.ts) for fully-delimited expressions —
 * `()` classic lists and `{}` curly-infix (with the precedence ladder + arrow +
 * display glyphs). NO indentation layer yet (phase 2) and NO colon-pairs yet
 * (phase 2) — those are the I-expression parts. This phase is unit-testable in
 * isolation via the round-trip law read(render(x)) ≡ x.
 *
 * Since stored entities are ALWAYS raw scm and sweet is rendered live, the law
 * that matters is read∘render = id on classic: viewing then saving must not mutate
 * the stored tree. This file is one half of proving that.
 *
 * SRFI-105 space-significance: inside `{}`, an operator is a WHITESPACE-ISOLATED
 * token equal to an operator string. `config/min-for-boundary` is one atom (the
 * `-`/`/` have no surrounding spaces); ` - ` is the minus operator. The tokenizer
 * stays op-agnostic; only the curly parser treats a word as an operator.
 */
import type { Node } from "./sweet-render.js";

// glyph → canonical op (inverse of INFIX_GLYPH in sweet-render). NOTE the `==`
// collapse is NOT injective on render (=, equal?, eq?, eqv? all render `==`); we
// canonicalize to `equal?`. So `=`/`eq?`/`eqv?` written in classic do NOT survive
// read∘render unchanged — they come back as `equal?` (behaviour-identical for the
// exact-integer comparisons in the showcase; differs only on inexact). Flagged for
// a decision: either accept this canonicalization or un-collapse the glyph.
const GLYPH_OP: Record<string, string> = { "==": "equal?", "&&": "and", "||": "or" };
const opOf = (glyph: string): string => GLYPH_OP[glyph] ?? glyph;

// glyph → precedence (must mirror sweet-render's INFIX_PREC ladder). `=>` loosest.
const GLYPH_PREC: Record<string, number> = {
  "=>": 0, "||": 1, "&&": 2,
  "==": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5,
};
const isOp = (w: string): boolean => w in GLYPH_PREC;

type Tok =
  | { t: "(" | ")" | "{" | "}" }
  | { t: "word"; v: string; str?: boolean };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") { toks.push({ t: c }); i++; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") { s += src[i] + (src[i + 1] ?? ""); i += 2; } else { s += src[i]; i++; }
      }
      i++; // closing quote
      toks.push({ t: "word", v: s, str: true });
      continue;
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !"(){}\"".includes(src[j])) j++;
    toks.push({ t: "word", v: src.slice(i, j) });
    i = j;
  }
  return toks;
}

/** Parse a fully-delimited sweet expression (a `(…)` list, a `{…}` curly, or an
 *  atom) into a classic Node. Phase 1 — no indentation, no colon-pairs. */
export function readSweetExpr(src: string): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => toks[pos++];

  // operand in CLASSIC context: a word is always an atom (even `+`, `-`).
  function classicOperand(): Node {
    const t = next();
    if (t.t === "(") return classicList();
    if (t.t === "{") return curly();
    if (t.t === "word") return t.str ? { atom: t.v, str: true } : { atom: t.v };
    throw new Error(`unexpected '${t.t}' in classic position`);
  }
  function classicList(): Node {
    // `(` already consumed
    const items: Node[] = [];
    while (peek() && peek()!.t !== ")") items.push(classicOperand());
    if (!peek()) throw new Error("unbalanced (");
    next(); // `)`
    return { list: items };
  }

  // operand in CURLY context: a word that is an operator is NOT an operand.
  function curlyOperand(): Node {
    const t = peek();
    if (!t) throw new Error("unexpected end in curly");
    if (t.t === "(") { next(); return classicList(); }
    if (t.t === "{") { next(); return curly(); }
    if (t.t === "word" && !isOp(t.v)) { next(); return t.str ? { atom: t.v, str: true } : { atom: t.v }; }
    throw new Error(`expected operand in curly, got '${t.t === "word" ? t.v : t.t}'`);
  }
  // precedence-climbing; collects same-op runs into one n-ary call (mirrors the
  // render, which joins `a + b + c` flat for `(+ a b c)`).
  function infix(minPrec: number): Node {
    let left = curlyOperand();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "word" || !isOp(t.v) || GLYPH_PREC[t.v] < minPrec) break;
      const glyph = t.v;
      const p = GLYPH_PREC[glyph];
      const operands = [left];
      while (peek() && (peek() as { t: string; v?: string }).t === "word" && (peek() as { v: string }).v === glyph) {
        next(); // the operator
        operands.push(infix(p + 1));
      }
      left = glyph === "=>"
        ? { list: [{ atom: "lambda" }, operands[0], operands[1]] } // params => body
        : { list: [{ atom: opOf(glyph) }, ...operands] };
    }
    return left;
  }
  function curly(): Node {
    // `{` already consumed
    const e = infix(0);
    if (!peek() || peek()!.t !== "}") throw new Error("unbalanced {");
    next(); // `}`
    return e;
  }

  const t = peek();
  if (!t) throw new Error("empty input");
  const result = t.t === "(" ? (next(), classicList())
    : t.t === "{" ? (next(), curly())
    : classicOperand();
  if (pos !== toks.length) throw new Error(`trailing tokens after expression (${toks.length - pos} left)`);
  return result;
}
