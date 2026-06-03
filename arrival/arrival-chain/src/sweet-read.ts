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
import { parseSexprs, nodeEq, printScheme, type Node } from "./sweet-render.js";

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

// `start`/`end` are absolute offsets in the ORIGINAL sweet text, present only when
// `tokenize` is given a `base` (single-physical-line LogLines). They thread up into
// `Node.span` for the editor's parameter hints; coalesced multi-line content passes
// no base, so its tokens carry no offsets and produce no hints (graceful).
type Tok =
  | { t: "(" | ")" | "{" | "}" | "[" | "]"; start?: number; end?: number }
  | { t: "quote"; v: "'" | "`" | "," | ",@"; start?: number; end?: number }
  | { t: "word"; v: string; str?: boolean; start?: number; end?: number };

/** `[k]` → k-th element accessor `ca d^k r`; `[k:]` → drop-first-k `c d^k r`.
 *  Inverse of sweet-render's accessorSubscript. [0]=car, [1]=cadr…; [1:]=cdr… */
function subscriptToAccessor(idx: string): string {
  const slice = idx.endsWith(":");
  const k = Number(slice ? idx.slice(0, -1) : idx);
  if (!Number.isInteger(k) || k < (slice ? 1 : 0)) throw new Error(`bad subscript '[${idx}]'`);
  return slice ? "c" + "d".repeat(k) + "r" : "ca" + "d".repeat(k) + "r";
}

// reader-macro prefix → the symbol it expands to (mirrors parseSexprs).
const QUOTE_WRAP: Record<string, string> = { "'": "quote", "`": "quasiquote", ",": "unquote", ",@": "unquote-splicing" };

function tokenize(src: string, base?: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  // Stamp absolute offsets onto a token iff a base is given (see Tok's note).
  const at = (start: number, end: number) => (base == null ? {} : { start: base + start, end: base + end });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === "[" || c === "]") { i++; toks.push({ t: c, ...at(s, i) }); continue; }
    if (c === "'" || c === "`") { i++; toks.push({ t: "quote", v: c, ...at(s, i) }); continue; }
    if (c === ",") { const v = src[i + 1] === "@" ? ",@" : ","; i += v.length; toks.push({ t: "quote", v, ...at(s, i) }); continue; }
    if (c === '"') {
      let str = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") { str += src[i] + (src[i + 1] ?? ""); i += 2; } else { str += src[i]; i++; }
      }
      i++;
      toks.push({ t: "word", v: str, str: true, ...at(s, i) });
      continue;
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !"(){}[]\"".includes(src[j])) j++;
    toks.push({ t: "word", v: src.slice(i, j), ...at(s, j) });
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

  // Run `read`, then stamp the produced node's source span from the tokens it
  // consumed ([first.start, last.end]) — present only when the tokens carry offsets
  // (single-line content). Inert metadata for the editor's parameter hints.
  const spanned = (read: () => Node): Node => {
    const startPos = pos;
    const node = read();
    const s = toks[startPos]?.start;
    const e = toks[pos - 1]?.end;
    if (s != null && e != null && node.span == null) node.span = [s, e];
    return node;
  };

  // Postfix subscripts: consume any `[k]` / `[k:]` following an operand and wrap it
  // in the accessor it sugars (`xs[0]`→(car xs), `xs[1:]`→(cdr xs)). Chains, so
  // `xs[0][1]`→(cadr (car xs)). Binds tighter than infix, so it's applied to each
  // fully-read datum/operand before the infix climber sees it.
  function withSubscripts(node: Node): Node {
    let n = node;
    while (peek() && peek()!.t === "[") {
      next(); // [
      const t = next();
      if (!t || t.t !== "word") throw new Error("expected index inside '[ ]'");
      const close = next();
      if (!close || close.t !== "]") throw new Error("unbalanced '['");
      n = { list: [atom(subscriptToAccessor(t.v)), n] };
    }
    return n;
  }

  // `'`/`` ` ``/`,`/`,@` prefix → (quote datum) etc. Recurses (`''x` → nested).
  function quoted(parseDatum: () => Node): Node {
    const t = peek();
    if (t && t.t === "quote") { next(); return { list: [atom(QUOTE_WRAP[t.v]), quoted(parseDatum)] }; }
    return parseDatum();
  }

  function classicList(): Node {
    const items: Node[] = [];
    while (peek() && peek()!.t !== ")") items.push(spanned(() => withSubscripts(quoted(classicDatum))));
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
    return withSubscripts(quoted((): Node => {
      const t = peek();
      if (!t) throw new Error("unexpected end in curly");
      if (t.t === "(") { next(); return classicList(); }
      if (t.t === "{") { next(); return curly(); }
      if (t.t === "word" && !isOp(t.v)) { next(); return atom(t.v, t.str); }
      throw new Error(`expected operand in curly, got '${t.t === "word" ? t.v : t.t}'`);
    }));
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
  while (pos < toks.length) elems.push(spanned(() => withSubscripts(quoted(classicDatum))));
  return elems;
}

/** Single fully-delimited expression — phase-1 entry (used by the curly/arrow
 *  round-trip tests). For multi-element input it returns the first element. */
export function readSweetExpr(src: string): Node {
  const elems = parseElements(tokenize(stripComments(src)));
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
    else if (c === "(" || c === "{" || c === "[") d++;
    else if (c === ")" || c === "}" || c === "]") d--;
  }
  return d;
}

/** `base` = absolute offset of `content[0]` in the original sweet text, for span
 *  attachment. Set only for a SINGLE-physical-line LogLine (offsets map directly);
 *  a coalesced multi-line one leaves it undefined → its nodes get no spans → no
 *  parameter hints there (rare, and the broken-`{…}` form is still readable). */
interface LogLine { indent: number; content: string; base?: number }

/** Coalesce physical lines whose brackets are unbalanced into one logical line
 *  (so a multi-line `{…}` becomes a single parseable unit; bracket mode overrides
 *  indentation). Logical-line indent = its first physical line's indent. */
function coalesce(physical: { text: string; base: number }[]): LogLine[] {
  const out: LogLine[] = [];
  let i = 0;
  while (i < physical.length) {
    const indent = leadingSpaces(physical[i].text);
    let content = physical[i].text.trim();
    const base = physical[i].base + indent; // content[0]'s absolute offset (trim drops `indent` leading chars)
    let joined = false;
    while (i + 1 < physical.length && bracketDepth(content) > 0) {
      i++;
      content += " " + physical[i].text.trim();
      joined = true;
    }
    out.push(joined ? { indent, content } : { indent, content, base });
    i++;
  }
  return out;
}

/** Parse one logical line + all deeper-indented descendants → the element(s) it
 *  contributes to its parent's list (usually 1; 2 for an inline colon-pair). */
function parseNode(lines: LogLine[], idx: number): { elems: Node[]; next: number } {
  const line = lines[idx];
  const toks = tokenize(line.content, line.base); // `base` absent (coalesced) → no spans
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

/** Blank a `;`-line-comment (to end of line) to SPACES, string-aware — they're
 *  trivia in the sweet view (sweet-render re-emits them from the classic AST's
 *  lead/trail). Length-PRESERVING (comment → spaces, not removed) so every other
 *  char keeps its offset: that's what lets sweet-text spans (for the parameter
 *  hints) stay valid in the editor's comment-bearing buffer. tokenize skips the
 *  spaces, so the parsed Nodes are identical to before. Newlines are kept. */
function stripComments(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++; }
      i--; // the for-loop's i++ re-lands on the \n (or past end), copied next iteration
      continue;
    }
    out += c;
  }
  return out;
}

/** Split into top-level forms (blank-line separated), keeping each form's absolute
 *  start offset in `text` — so spans computed within a form map back to the buffer. */
function splitFormsWithBase(text: string): { text: string; base: number }[] {
  const out: { text: string; base: number }[] = [];
  const sep = /\n[ \t]*\n+/g;
  let last = 0;
  for (let m = sep.exec(text); m; m = sep.exec(text)) {
    out.push({ text: text.slice(last, m.index), base: last });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), base: last });
  return out;
}

/** Full reader: sweet text → classic forms. */
export function readSweet(text: string): Node[] {
  // Split into top-level forms by blank line FIRST: in the render, blank lines
  // appear ONLY between top-level forms (a comment is contiguous with its node),
  // so this is the true boundary. THEN blank comments within each form (length-
  // preserving, so form/line offsets stay valid for span attachment). Stripping
  // BEFORE the split would instead let an inner comment's blank line split one form
  // into two (form-count drift → reprint).
  return splitFormsWithBase(text)
    .map(({ text: f, base }) => ({ text: stripComments(f), base }))
    .filter(({ text: f }) => f.trim().length > 0)
    .map(({ text: formText, base: formBase }) => {
      // Physical lines with absolute bases — blank lines dropped, but offsets keep
      // counting (incl. each consumed "\n") so a kept line's base is exact.
      const physical: { text: string; base: number }[] = [];
      let off = 0;
      for (const lineText of formText.split("\n")) {
        if (lineText.trim().length > 0) physical.push({ text: lineText, base: formBase + off });
        off += lineText.length + 1;
      }
      const lines = coalesce(physical);
      const { elems } = parseNode(lines, 0);
      return elems.length === 1 ? elems[0] : { list: elems };
    });
}

// ── save-back: sweet → classic, preserving unchanged forms ──────────────────────

/** Byte spans of the top-level forms in classic source, in order. Inter-form
 *  whitespace and `;` line-comments are NOT part of any span (preserved verbatim
 *  on splice). String- and comment-aware so brackets inside them don't miscount. */
export function topFormSpans(src: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    // Skip inter-form whitespace + line comments.
    while (i < n) {
      if (/\s/.test(src[i])) { i++; continue; }
      if (src[i] === ";") { while (i < n && src[i] !== "\n") i++; continue; }
      break;
    }
    if (i >= n) break;
    const start = i;
    // A form may carry leading quote/quasiquote/unquote prefixes (they bind tight).
    while (i < n && (src[i] === "'" || src[i] === "`" || src[i] === ",")) i += src[i] === "," && src[i + 1] === "@" ? 2 : 1;
    if (i < n && (src[i] === "(" || src[i] === "[")) {
      // Balanced bracket group, string- & comment-aware.
      let depth = 0;
      let inStr = false;
      for (; i < n; i++) {
        const c = src[i];
        if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === ";") { while (i + 1 < n && src[i + 1] !== "\n") i++; }
        else if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") { if (--depth === 0) { i++; break; } }
      }
    } else if (i < n && src[i] === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else {
      // Bare atom (symbol / number).
      while (i < n && !/\s/.test(src[i]) && !"()[];\"".includes(src[i])) i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

/**
 * Fold an edited sweet view back into canonical classic. Every UNCHANGED top-level
 * form is preserved byte-for-byte (its comments + hand-formatting intact); only
 * forms whose AST changed are reprinted (canonical, via printScheme). Falls back to
 * a whole-file canonical reprint when the form correspondence is uncertain — the
 * form count differs (a form added/removed in sweet) or a span doesn't parse to
 * exactly one form. Throws if the sweet text is malformed (the caller keeps its
 * buffer and skips the save). The law: `sweetToScheme(schemeToSweet(c), c) === c`
 * byte-for-byte — viewing-then-saving an UNEDITED sweet view never touches storage.
 */
export function sweetToScheme(sweetText: string, prevClassic: string): string {
  const sweetForms = readSweet(sweetText); // throws on malformed sweet → caller handles
  const reprintAll = (): string => sweetForms.map((f) => printScheme(f)).join("\n\n") + "\n";

  const spans = topFormSpans(prevClassic);
  if (spans.length !== sweetForms.length) return reprintAll(); // form added/removed → uncertain

  const prevParsed = spans.map((s) => parseSexprs(prevClassic.slice(s.start, s.end)));
  if (prevParsed.some((forms) => forms.length !== 1)) return reprintAll(); // ambiguous split → uncertain

  // Certain: 1:1 correspondence. Splice changed forms in from the end so earlier
  // spans' offsets stay valid; unchanged forms (and all inter-form bytes) survive.
  let out = prevClassic;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (nodeEq(sweetForms[i], prevParsed[i][0])) continue; // unchanged → keep original bytes
    out = out.slice(0, spans[i].start) + printScheme(sweetForms[i]) + out.slice(spans[i].end);
  }
  return out;
}
