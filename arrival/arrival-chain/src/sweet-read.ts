/**
 * Sweet → classic READER. Inverts sweet-render.ts so a live sweet view can be
 * saved back to canonical scm losslessly (stored entities are ALWAYS raw scm;
 * sweet is a lens). The law: read(render(x)) ≡ x on classic.
 *
 * Two layers:
 *   1. I-expressions (indentation): a line + its more-indented descendants form a
 *      list. `define (f x)` ⏎ body → (define (f x) body). A 1-token line with no
 *      children is just that token; multi-token / has-children becomes a list.
 *   2. delimited sub-exprs: `(…)` classic lists and `{…}` curly-infix (precedence
 *      ladder + arrow → lambda + display glyphs). Bracket mode overrides
 *      indentation — a `{…}` may span physical lines (the broken-infix case), so
 *      lines with unbalanced brackets are coalesced before indentation grouping.
 *   plus colon-pairs: under kwarg calls a `key: value` line contributes :key + value.
 *
 * SRFI-105 space-significance: inside `{}` an operator is a whitespace-isolated
 * token equal to an operator string (so `config/min-for-boundary` is one atom).
 */
import type { Node } from "./sweet-render.js";

// glyph → canonical op (inverse of INFIX_GLYPH). INJECTIVE: only ==←equal?, &&←and,
// ||←or are remapped; everything else (=, eq?, eqv?, arithmetic, comparison) is its
// own op. So read∘render = id for every equality kind.
const GLYPH_OP: Record<string, string> = { "==": "equal?", "&&": "and", "||": "or" };
const opOf = (glyph: string): string => GLYPH_OP[glyph] ?? glyph;

// glyph → precedence — must mirror sweet-render's INFIX_PREC. `=>` loosest;
// `??` (null-coalescing) ≈ `||`.
const GLYPH_PREC: Record<string, number> = {
  "=>": 0, "??": 1, "||": 1, "&&": 2,
  "==": 3, "=": 3, "eq?": 3, "eqv?": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5,
};
const isOp = (w: string): boolean => w in GLYPH_PREC;

const atom2 = (w: string): Node => ({ atom: w });
/** `{a ?? b}` → (if a a b); right-folds a chain `{a ?? b ?? c}` → (if a a (if b b c)). */
function coalesceNode(ops: Node[]): Node {
  let acc = ops[ops.length - 1];
  for (let i = ops.length - 2; i >= 0; i--) acc = { list: [atom2("if"), ops[i], ops[i], acc] };
  return acc;
}

const LET_FAMILY = new Set(["let", "let*", "letrec", "letrec*"]);
const isAtomNode = (n: Node): n is { atom: string; str?: boolean } => "atom" in n;
const bindingShaped = (n: Node): boolean => !isAtomNode(n) && n.list.length === 2 && isAtomNode(n.list[0]);
/** Re-introduce the elided bindings `(( ))` for a let-family form. The render drops
 *  it (each binding shown `name`⏎`value`); here we collect the leading binding-shaped
 *  children back into a bindings list. Non-elided forms (items[1] already a bindings
 *  list — first elem a list, or empty) are left untouched. */
function regroupLetFamily(node: Node): Node {
  if (isAtomNode(node) || node.list.length < 2) return node;
  const h = node.list[0];
  if (!isAtomNode(h) || !LET_FAMILY.has(h.atom)) return node;
  const x = node.list[1];
  const alreadyBindingsList = !isAtomNode(x) && (x.list.length === 0 || !isAtomNode(x.list[0]));
  if (alreadyBindingsList) return node;
  const bindings: Node[] = [];
  let i = 1;
  while (i < node.list.length && bindingShaped(node.list[i])) bindings.push(node.list[i++]);
  if (bindings.length === 0) return node;
  return { list: [h, { list: bindings }, ...node.list.slice(i)] };
}

type Tok =
  | { t: "(" | ")" | "{" | "}" }
  | { t: "quote"; v: "'" | "`" | "," | ",@" }
  | { t: "word"; v: string; str?: boolean };

// reader-macro prefix → the symbol it expands to (mirrors parseSexprs).
const QUOTE_WRAP: Record<string, string> = { "'": "quote", "`": "quasiquote", ",": "unquote", ",@": "unquote-splicing" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") { toks.push({ t: c }); i++; continue; }
    if (c === "'" || c === "`") { toks.push({ t: "quote", v: c }); i++; continue; }
    if (c === ",") { const v = src[i + 1] === "@" ? ",@" : ","; toks.push({ t: "quote", v }); i += v.length; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") { s += src[i] + (src[i + 1] ?? ""); i += 2; } else { s += src[i]; i++; }
      }
      i++;
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

const atom = (w: string, str?: boolean): Node => (str ? { atom: w, str: true } : { atom: w });
const isColonKey = (t: Tok): boolean => t.t === "word" && !t.str && t.v.length > 1 && t.v.endsWith(":") && !t.v.slice(0, -1).includes(":");

/** Parse a token array into a SEQUENCE of classic elements: `(…)` lists, `{…}`
 *  curlies, quoted data, and atoms. Colon-keys are NOT handled here — parseNode
 *  strips a line-leading `key:` first, so trailing-colon tokens never reach this. */
function parseElements(toks: Tok[]): Node[] {
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => toks[pos++];

  // `'`/`` ` ``/`,`/`,@` prefix → (quote datum) etc. Recurses (`''x` → nested).
  function quoted(parseDatum: () => Node): Node {
    const t = peek();
    if (t && t.t === "quote") { next(); return { list: [atom(QUOTE_WRAP[t.v]), quoted(parseDatum)] }; }
    return parseDatum();
  }

  function classicList(): Node {
    const items: Node[] = [];
    while (peek() && peek()!.t !== ")") items.push(quoted(classicDatum));
    if (!peek()) throw new Error("unbalanced (");
    next();
    return { list: items };
  }
  function classicDatum(): Node {
    const t = next();
    if (t.t === "(") return classicList();
    if (t.t === "{") return curly();
    if (t.t === "word") return atom(t.v, t.str);
    throw new Error(`unexpected '${t.t}'`);
  }

  function curlyOperand(): Node {
    return quoted((): Node => {
      const t = peek();
      if (!t) throw new Error("unexpected end in curly");
      if (t.t === "(") { next(); return classicList(); }
      if (t.t === "{") { next(); return curly(); }
      if (t.t === "word" && !isOp(t.v)) { next(); return atom(t.v, t.str); }
      throw new Error(`expected operand in curly, got '${t.t === "word" ? t.v : t.t}'`);
    });
  }
  function infix(minPrec: number): Node {
    let left = curlyOperand();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "word" || !isOp(t.v) || GLYPH_PREC[t.v] < minPrec) break;
      const glyph = t.v;
      const p = GLYPH_PREC[glyph];
      const operands = [left];
      while (peek() && (peek() as Tok).t === "word" && (peek() as { v: string }).v === glyph) {
        next();
        operands.push(infix(p + 1));
      }
      left = glyph === "=>"
        ? { list: [atom("lambda"), operands[0], operands[1]] }
        : glyph === "??"
        ? coalesceNode(operands)
        : { list: [atom(opOf(glyph)), ...operands] };
    }
    return left;
  }
  function curly(): Node {
    const e = infix(0);
    if (!peek() || peek()!.t !== "}") throw new Error("unbalanced {");
    next();
    return e;
  }

  const elems: Node[] = [];
  while (pos < toks.length) elems.push(quoted(classicDatum));
  return elems;
}

/** Single fully-delimited expression — phase-1 entry (used by the curly/arrow
 *  round-trip tests). For multi-element input it returns the first element. */
export function readSweetExpr(src: string): Node {
  const elems = parseElements(tokenize(src));
  if (elems.length !== 1) throw new Error(`expected one expression, got ${elems.length}`);
  return elems[0];
}

// ── I-expression layer ────────────────────────────────────────────────────────

const leadingSpaces = (s: string): number => s.length - s.trimStart().length;

/** Net bracket depth of a string, ignoring brackets inside "strings". */
function bracketDepth(s: string): number {
  let d = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "{") d++;
    else if (c === ")" || c === "}") d--;
  }
  return d;
}

interface LogLine { indent: number; content: string }

/** Coalesce physical lines whose brackets are unbalanced into one logical line
 *  (so a multi-line `{…}` becomes a single parseable unit; bracket mode overrides
 *  indentation). Logical-line indent = its first physical line's indent. */
function coalesce(physical: string[]): LogLine[] {
  const out: LogLine[] = [];
  let i = 0;
  while (i < physical.length) {
    const indent = leadingSpaces(physical[i]);
    let content = physical[i].trim();
    while (i + 1 < physical.length && bracketDepth(content) > 0) {
      i++;
      content += " " + physical[i].trim();
    }
    out.push({ indent, content });
    i++;
  }
  return out;
}

/** Parse one logical line + all deeper-indented descendants → the element(s) it
 *  contributes to its parent's list (usually 1; 2 for an inline colon-pair). */
function parseNode(lines: LogLine[], idx: number): { elems: Node[]; next: number } {
  const line = lines[idx];
  const toks = tokenize(line.content);
  const childElems: Node[] = [];
  let j = idx + 1;
  while (j < lines.length && lines[j].indent > line.indent) {
    const r = parseNode(lines, j);
    childElems.push(...r.elems);
    j = r.next;
  }

  // colon-pair: a line whose FIRST token is a TRAILING-colon key (`summary:`) is a
  // kwarg pair → :summary + value. Value = rest-of-line ++ children (one expr).
  // (Leading-colon `:personas` is an accessor HEAD, not a key — it falls through.)
  if (toks.length >= 1 && isColonKey(toks[0])) {
    const key = atom(":" + (toks[0] as { v: string }).v.slice(0, -1));
    const valueElems = parseElements(toks.slice(1));
    const all = [...valueElems, ...childElems];
    if (all.length === 0) throw new Error(`colon key '${(toks[0] as { v: string }).v}' has no value`);
    return { elems: [key, all.length === 1 ? all[0] : { list: all }], next: j };
  }

  const head = parseElements(toks);
  if (childElems.length === 0) return { elems: head, next: j };
  // head tokens + children form one list (e.g. `define (f x)` ⏎ body, `(else …)`).
  // regroupLetFamily re-wraps elided let/let* bindings into their `(( ))`.
  return { elems: [regroupLetFamily({ list: [...head, ...childElems] })], next: j };
}

/** Full reader: sweet text → classic forms. */
export function readSweet(text: string): Node[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((f) => f.replace(/\n+$/, ""))
    .filter((f) => f.trim().length > 0)
    .map((formText) => {
      const physical = formText.split("\n").filter((l) => l.trim().length > 0);
      const lines = coalesce(physical);
      const { elems } = parseNode(lines, 0);
      return elems.length === 1 ? elems[0] : { list: elems };
    });
}
