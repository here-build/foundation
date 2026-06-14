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
import invariant from "tiny-invariant";

import {
  parseSexprs,
  nodeEq,
  printScheme,
  encodeAccessor,
  accessorStepLetters,
  type Node,
  type PairStep,
} from "./sweet-render.js";

// glyph → canonical op (inverse of INFIX_GLYPH). INJECTIVE: only ==←equal?, &&←and,
// ||←or are remapped; everything else (=, eq?, eqv?, arithmetic, comparison) is its
// own op. So read∘render = id for every equality kind.
const GLYPH_OP: Record<string, string> = { "==": "equal?", "&&": "and", "||": "or" };
const opOf = (glyph: string): string => GLYPH_OP[glyph] ?? glyph;

// glyph → precedence — must mirror sweet-render's INFIX_PREC. `=>` loosest;
// `??` (null-coalescing) ≈ `||`.
const GLYPH_PREC: Record<string, number> = {
  "=>": 0,
  "??": 1,
  "||": 1,
  "&&": 2,
  "==": 3,
  "=": 3,
  "eq?": 3,
  "eqv?": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  // Multiplicative tier MUST mirror sweet-render's INFIX_PREC — render emits
  // `modulo`/`quotient`/`remainder` as infix, so read has to recognise them back
  // or `{a modulo b}` fails as "unbalanced {" (round-trip break).
  "*": 5,
  "/": 5,
  modulo: 5,
  quotient: 5,
  remainder: 5,
};
const isOp = (w: string): boolean => w in GLYPH_PREC;

const atom2 = (w: string): Node => ({ atom: w });
/** `{a ?? b}` → (if a a b); right-folds a chain `{a ?? b ?? c}` → (if a a (if b b c)). */
function coalesceNode(ops: Node[]): Node {
  // ops is always a non-empty `??` chain (≥1 operand) — `.at(-1)` is the seed.
  let acc: Node = ops.at(-1)!;
  for (let i = ops.length - 2; i >= 0; i--) acc = { list: [atom2("if"), ops[i]!, ops[i]!, acc] };
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
// `tight` (on `(` only) = no whitespace separates this token from the one before
// it on the same source line. The method-dot reader needs it to tell a call-args
// group `fold(knil)` (tight) from a sibling operand `clicking? (cons …)` (loose) —
// the tokenizer discards whitespace, so adjacency must be recorded as it lexes.
// Computed locally (independent of `base`), so it's present even when offsets aren't.
type Tok =
  | { t: "(" | ")" | "{" | "}" | "[" | "]"; start?: number; end?: number; tight?: boolean }
  | { t: "."; start?: number; end?: number } // method-dot (postfix apply) — see splitMethodDots
  | { t: "quote"; v: "'" | "`" | "," | ",@"; start?: number; end?: number }
  | { t: "word"; v: string; str?: boolean; start?: number; end?: number };

// ident-start glyphs (R7RS initial set, minus digits): a `.` only splits when the
// next char is one of these — so `0.5`/`x.5` (decimals) and `(a . b)` stay whole.
const IDENT_START = /[A-Za-z!$%&*/:<=>?^_~]/;

/** `rewrite_L` — split a raw WORD at each method-dot into `(word? .)* word` tokens.
 *  A `.` at index k splits iff (a) it is SINGLE — neither neighbour is `.` (so `..`
 *  `...` `a...` stay whole), and (b) the next char is an ident-start, non-digit.
 *  Word-INITIAL dots split too (no preceding word emitted) — that is the line-leading
 *  `.map` (§3.4) and the post-delimiter `recv.op.op` case, where `}`/`]`/`)` break
 *  the run so the dot starts a fresh one. `\.` is an escaped LITERAL dot: unescaped
 *  into the symbol here, re-escaped on render. A lone `.` (dotted pair) and a word
 *  with no qualifying dot return `[word]` unchanged — the reclamation is free (corpus
 *  has 0 in-word code dots, 0 space-flanked dotted pairs). */
function splitMethodDots(w: string, s: number, base?: number): Tok[] {
  const out: Tok[] = [];
  const at = (a: number, b: number) => (base == null ? {} : { start: base + s + a, end: base + s + b });
  let seg = "";
  let segStart = 0;
  let k = 0;
  while (k < w.length) {
    const c = w[k];
    if (c === "\\" && w[k + 1] === ".") {
      seg += "."; // escaped literal dot — stays in the symbol
      k += 2;
      continue;
    }
    const prev = k > 0 ? w[k - 1] : undefined;
    const next = w[k + 1];
    if (
      c === "." &&
      prev !== "." && // single dot — `..`/`...` stay whole (k=0 has no prev → passes)
      next !== "." &&
      next !== undefined &&
      IDENT_START.test(next) &&
      !/[0-9]/.test(next)
    ) {
      if (seg.length > 0) out.push({ t: "word", v: seg, ...at(segStart, k) }); // left segment, if any
      out.push({ t: ".", ...at(k, k + 1) });
      seg = "";
      segStart = k + 1;
      k++;
      continue;
    }
    seg += c;
    k++;
  }
  if (seg.length > 0 || out.length === 0) out.push({ t: "word", v: seg, ...at(segStart, k) });
  return out;
}

/** One `[…]` index, classified. Integers are PAIR access (`[k]`→pull, `[k:]`→drop,
 *  fused into `c[ad]+r` words); a `:keyword` is STATIC key access (→ `(:k obj)`, the
 *  recommended keyword-as-fn form); any other identifier or string is DYNAMIC key
 *  access (→ `(@ obj key)`). One bracket surface, disambiguated purely by the index's
 *  shape so the destinations can never collide. Inverse of sweet-render's emission. */
type Subscript = PairStep | { key: string } | { dyn: Node };

function parseSubscript(t: Extract<Tok, { t: "word" }>): Subscript {
  const idx = t.v;
  if (t.str) return { dyn: atom(idx, true) }; // "name" → dynamic string key
  if (/^\d+$/.test(idx)) return { pull: Number(idx) }; // [k]  → take element k
  if (/^\d+:$/.test(idx)) {
    const k = Number(idx.slice(0, -1));
    invariant(k >= 1, () => `bad subscript '[${idx}]'`); // [k:] → drop first k (k ≥ 1)
    return { drop: k };
  }
  if (idx.startsWith(":") && idx.length > 1) return { key: idx }; // :verdict → static key
  return { dyn: atom(idx) }; // identifier → dynamic key
}

/** r7rs `(scheme cxr)` defines accessor words of up to 4 letters (car … cddddr).
 *  The DEFAULT reader caps subscript fusion at this many accessor-word letters, so
 *  a long chain like `x[0][1][2]` lowers to nested standard words `(caddr (cadar
 *  x))` rather than one non-portable `caddadar`. Pass `accessorDepth: Infinity` for
 *  unbounded fusion (one `c[ad]+r` word per chain, resolved by the runtime catchall
 *  on both interpreter and compiler). A single inherently-deep subscript (`x[5]`,
 *  only ever produced by rendering an already-non-standard word) is never split —
 *  splitting would break the sweet-side round-trip — so the cap governs fusion of
 *  ADJACENT subscripts, the only place the reader actually has a choice. */
export const R7RS_ACCESSOR_DEPTH = 4;

// reader-macro prefix → the symbol it expands to (mirrors parseSexprs).
const QUOTE_WRAP: Record<string, string> = {
  "'": "quote",
  "`": "quasiquote",
  ",": "unquote",
  ",@": "unquote-splicing",
};

function tokenize(src: string, base?: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  // Stamp absolute offsets onto a token iff a base is given (see Tok's note).
  const at = (start: number, end: number) => (base == null ? {} : { start: base + start, end: base + end });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const s = i;
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === "[" || c === "]") {
      i++;
      const tight = s > 0 && !/\s/.test(src[s - 1]);
      toks.push({ t: c, ...at(s, i), tight });
      continue;
    }
    if (c === "'" || c === "`") {
      i++;
      toks.push({ t: "quote", v: c, ...at(s, i) });
      continue;
    }
    if (c === ",") {
      const v = src[i + 1] === "@" ? ",@" : ",";
      i += v.length;
      toks.push({ t: "quote", v, ...at(s, i) });
      continue;
    }
    if (c === '"') {
      let str = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          str += src[i] + (src[i + 1] ?? "");
          i += 2;
        } else {
          str += src[i];
          i++;
        }
      }
      i++;
      toks.push({ t: "word", v: str, str: true, ...at(s, i) });
      continue;
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !'(){}[]"'.includes(src[j])) j++;
    for (const tk of splitMethodDots(src.slice(i, j), s, base)) toks.push(tk);
    i = j;
  }
  return toks;
}

const atom = (w: string, str?: boolean): Node => (str ? { atom: w, str: true } : { atom: w });
const isColonKey = (t: Tok): t is Extract<Tok, { t: "word" }> =>
  t.t === "word" && !t.str && t.v.length > 1 && t.v.endsWith(":") && !t.v.slice(0, -1).includes(":");

/** Parse a token array into a SEQUENCE of classic elements: `(…)` lists, `{…}`
 *  curlies, quoted data, and atoms. Colon-keys are NOT handled here — parseNode
 *  strips a line-leading `key:` first, so trailing-colon tokens never reach this. */
function parseElements(toks: Tok[], accessorDepth: number = R7RS_ACCESSOR_DEPTH): Node[] {
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

  // Postfix subscripts: consume any `[…]` following an operand. Integer indices FUSE
  // into pair-accessor words (`xs[0]`→(car xs), `xs[1:]`→(cdr xs), `xs[0][1]`→(cadar
  // xs) — one word, not (cadr (car xs))), capped at `accessorDepth` accessor-word
  // letters (overflow flushes the current word and starts fresh, so default mode
  // emits only portable standard words). A KEY index (`[:k]` / `[ident]`) can't be
  // part of a c[ad]+r word, so it flushes the pending pair run and wraps on its own:
  // `xs[:verdict]`→(:verdict xs), `xs[k]`→(@ xs k). Binds tighter than infix, so it's
  // applied to each fully-read datum/operand before the infix climber sees it.
  function withSubscripts(node: Node): Node {
    let n = node;
    let pairs: PairStep[] = [];
    let letters = 0;
    const flush = (): void => {
      if (pairs.length === 0) return;
      n = { list: [atom(encodeAccessor(pairs)), n] };
      pairs = [];
      letters = 0;
    };
    while (peek()?.t === "[" || peek()?.t === ".") {
      if (peek()!.t === ".") {
        // method-dot step `.op`, `.op { B }`, `.op(args)`, `.op(args){ B }` — the
        // receiver-last fold: every step seats the receiver in the LAST arg slot,
        // exactly as a subscript does. A method breaks the c[ad]+r run (flush first).
        next(); // .
        const opTok = next();
        invariant(!!opTok && opTok.t === "word" && !opTok.str, "expected method name after '.'");
        flush();
        const op = atom(opTok.v);
        const args: Node[] = []; // optional positional group: seed for fold/reduce (§7.3)
        // Only a TIGHT paren is call-args: `fold(knil)`. A space-separated `(…)` is a
        // sibling operand (`(clicking? x) (cons …)`), not args — never swallow it.
        const argParen = peek();
        if (argParen?.t === "(" && argParen.tight) {
          next();
          while (peek() && peek()!.t !== ")") args.push(datum());
          invariant(peek()?.t === ")", "unbalanced '(' in method args");
          next();
        }
        // Only a TIGHT brace is THIS step's trailing lambda (`map{…}`, `fold(knil){…}`).
        // A space-separated `{…}` is a sibling curly operand (`recv.op {n + 1}`) — leave
        // it for parseElements, else a bare method swallows its neighbour. Tight on `op`
        // (bare) or on the closing `)` of a tight arg-group; mirrors the arg-paren rule.
        const lamBrace = peek();
        if (lamBrace?.t === "{" && lamBrace.tight) {
          next();
          const lam = trailingLambda(); // arrow / implicit-`it` body; consumes `}`
          n = { list: [op, lam, ...args, n] }; // (op Λ args… recv)
        } else {
          n = { list: [op, ...args, n] }; // (op args… recv)  — bare / positional pipe
        }
        continue;
      }
      next(); // [
      const t = next();
      invariant(!!t && t.t === "word", "expected index inside '[ ]'");
      const close = next();
      invariant(!!close && close.t === "]", "unbalanced '['");
      const sub = parseSubscript(t);
      if ("pull" in sub || "drop" in sub) {
        const cost = accessorStepLetters(sub);
        if (letters > 0 && letters + cost > accessorDepth) flush();
        pairs.push(sub);
        letters += cost;
      } else {
        flush(); // a key access breaks the c[ad]+r run
        n =
          "key" in sub
            ? { list: [atom(sub.key), n] } // (:verdict obj) — static keyword-as-fn
            : { list: [atom("@"), n, sub.dyn] }; // (@ obj key)  — dynamic field access
      }
    }
    flush();
    return n;
  }

  // `'`/`` ` ``/`,`/`,@` prefix → (quote datum) etc. Recurses (`''x` → nested).
  function quoted(parseDatum: () => Node): Node {
    const t = peek();
    if (t?.t === "quote") {
      next();
      return { list: [atom(QUOTE_WRAP[t.v]), quoted(parseDatum)] };
    }
    return parseDatum();
  }

  // The standard datum read: span the BASE operand first (so `5` inside `5[0]`
  // is its own align/hover target), then the subscript-wrapped whole (so the
  // sugared (car 5) node spans `5[0]`) — spanned() only fills empty spans, so
  // the two stamps never fight.
  const datum = (): Node => spanned(() => withSubscripts(spanned(() => quoted(classicDatum))));

  function classicList(): Node {
    const items: Node[] = [];
    while (peek() && peek()!.t !== ")") items.push(datum());
    invariant(!!peek(), "unbalanced (");
    next();
    return { list: items };
  }
  function classicDatum(): Node {
    const t = next();
    if (t.t === "(") return classicList();
    if (t.t === "{") return curly();
    if (t.t === "word") return atom(t.v, t.str);
    invariant(false, () => `unexpected '${t.t}'`);
  }

  function curlyAtomic(): Node {
    const t = peek();
    invariant(!!t, "unexpected end in curly");
    if (t.t === "(") {
      next();
      return classicList();
    }
    if (t.t === "{") {
      next();
      return curly();
    }
    if (t.t === "word" && !isOp(t.v)) {
      next();
      return atom(t.v, t.str);
    }
    invariant(false, () => `expected operand in curly, got '${t.t === "word" ? t.v : t.t}'`);
  }
  function curlyOperand(): Node {
    // double-spanned like `datum`: infix operands are read OUTSIDE classicList's
    // item loop, so they need their own stamps (atoms in `{n - 1}` are
    // hover/align targets; the inner stamp covers a subscripted base).
    return spanned(() => withSubscripts(spanned(() => quoted(curlyAtomic))));
  }
  function infix(minPrec: number): Node {
    let left = curlyOperand();
    for (;;) {
      const t = peek();
      if (t?.t !== "word" || !isOp(t.v) || GLYPH_PREC[t.v] < minPrec) break;
      const glyph = t.v;
      const p = GLYPH_PREC[glyph];
      const operands = [left];
      for (let tk = peek(); tk?.t === "word" && tk.v === glyph; tk = peek()) {
        next();
        operands.push(infix(p + 1));
      }
      left =
        glyph === "=>"
          ? { list: [atom("lambda"), operands[0], operands[1]] }
          : glyph === "??"
            ? coalesceNode(operands)
            : { list: [atom(opOf(glyph)), ...operands] };
    }
    return left;
  }
  function curly(): Node {
    const e = infix(0);
    invariant(!!peek() && peek()!.t === "}", "unbalanced {");
    next();
    return e;
  }

  // A `{ … }` trailing lambda after `.op` (caller has consumed the `{`). The body
  // is read as a curly infix to precedence 0, so a top-level `=>` surfaces as a
  // lambda node with EXPLICIT params (`{(acc x) => …}` ⇒ (lambda (acc x) …)). With
  // no top `=>`, the body is wrapped in the IMPLICIT single-param pronoun `it`
  // (§3.3): `{B}` ⇒ (lambda (it) B). Consumes the closing `}`.
  function trailingLambda(): Node {
    const body = infix(0);
    invariant(peek()?.t === "}", "unbalanced { in trailing lambda");
    next();
    const isLam =
      !isAtomNode(body) && body.list.length >= 2 && isAtomNode(body.list[0]) && body.list[0].atom === "lambda";
    return isLam ? body : { list: [atom("lambda"), { list: [atom("it")] }, body] };
  }

  const elems: Node[] = [];
  while (pos < toks.length) elems.push(datum());
  return elems;
}

/** Single fully-delimited expression — phase-1 entry (used by the curly/arrow
 *  round-trip tests). For multi-element input it returns the first element. */
export function readSweetExpr(src: string, opts: ReadOpts = {}): Node {
  const elems = parseElements(tokenize(stripComments(src)), opts.accessorDepth);
  invariant(elems.length === 1, () => `expected one expression, got ${elems.length}`);
  return elems[0];
}

/** Reader knobs. `accessorDepth` caps pair-accessor subscript fusion (see
 *  R7RS_ACCESSOR_DEPTH); omit for the portable default, `Infinity` for unbounded. */
export interface ReadOpts {
  accessorDepth?: number;
}

// ── I-expression layer ────────────────────────────────────────────────────────

const leadingSpaces = (s: string): number => s.length - s.trimStart().length;

/** Net bracket depth of a string, ignoring brackets inside "strings". */
function bracketDepth(s: string): number {
  let d = 0,
    inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"': {
        inStr = true;
        break;
      }
      case "(":
      case "{":
      case "[": {
        d++;
        break;
      }
      case ")":
      case "}":
      case "]":
        {
          d--;
          // No default
        }
        break;
    }
  }
  return d;
}

/** `base` = absolute offset of `content[0]` in the original sweet text, for span
 *  attachment. Set only for a SINGLE-physical-line LogLine (offsets map directly);
 *  a coalesced multi-line one leaves it undefined → its nodes get no spans → no
 *  parameter hints there (rare, and the broken-`{…}` form is still readable). */
interface LogLine {
  indent: number;
  content: string;
  base?: number;
}

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
      content += ` ${physical[i].text.trim()}`;
      joined = true;
    }
    out.push(joined ? { indent, content } : { indent, content, base });
    i++;
  }
  return out;
}

/** Parse one logical line + all deeper-indented descendants → the element(s) it
 *  contributes to its parent's list (usually 1; 2 for an inline colon-pair). */
function parseNode(lines: LogLine[], idx: number, accessorDepth?: number): { elems: Node[]; next: number } {
  const line = lines[idx];
  const toks = tokenize(line.content, line.base); // `base` absent (coalesced) → no spans
  const childElems: Node[] = [];
  // §3.4 newline method chains: a leading run of direct-child LEAF lines whose first
  // token is a method-DOT are not arguments — their tokens fold onto the parent
  // line's value (same CST + §4.3 receiver-last fold as the inline `recv.op` chain,
  // just broken across lines by SRFI-110 indentation). Collected before the value is
  // parsed; appended to `toks` so `withSubscripts` consumes the `.op` run.
  const contToks: Tok[] = [];
  let j = idx + 1;
  while (j < lines.length && lines[j].indent > line.indent) {
    const childToks = tokenize(lines[j].content, lines[j].base);
    const isStepLine = childToks[0]?.t === "." && (j + 1 >= lines.length || lines[j + 1].indent <= lines[j].indent);
    if (childElems.length === 0 && isStepLine) {
      contToks.push(...childToks);
      j++;
      continue;
    }
    const r = parseNode(lines, j, accessorDepth);
    childElems.push(...r.elems);
    j = r.next;
  }
  const headToks = contToks.length > 0 ? [...toks, ...contToks] : toks;

  // colon-pair: a line whose FIRST token is a TRAILING-colon key (`summary:`) is a
  // kwarg pair → :summary + value. Value = rest-of-line ++ children (one expr).
  // (Leading-colon `:personas` is an accessor HEAD, not a key — it falls through.)
  const head0 = toks[0];
  if (toks.length > 0 && isColonKey(head0)) {
    const key = atom(`:${head0.v.slice(0, -1)}`);
    const valueElems = parseElements(toks.slice(1), accessorDepth);
    const all = [...valueElems, ...childElems];
    invariant(all.length > 0, () => `colon key '${head0.v}' has no value`);
    return { elems: [key, all.length === 1 ? all[0] : { list: all }], next: j };
  }

  const head = parseElements(headToks, accessorDepth);
  if (childElems.length === 0) {
    // SRFI-110: a CHILDLESS line of multiple datums is a list (`string-upcase s`
    // → (string-upcase s)) — same rule readSweet applies to a whole top-level
    // form. Splicing them as siblings instead silently rewrote a hand-typed
    // body to junk on save-back. (The render never emits such lines — inline
    // children keep their parens — so the round-trip law never exercised this.)
    if (head.length > 1) {
      const node: Node = { list: head };
      if (line.base != null) node.span = [line.base, line.base + line.content.length];
      return { elems: [node], next: j };
    }
    return { elems: head, next: j };
  }
  // head tokens + children form one list (e.g. `define (f x)` ⏎ body, `(else …)`).
  // regroupLetFamily re-wraps elided let/let* bindings into their `(( ))`.
  const node = regroupLetFamily({ list: [...head, ...childElems] });
  // Span the composite from its line extents (when both endpoints are on
  // un-coalesced lines) — the whole-form span a definition/diagnostic lift
  // lands on when its classic span covers the entire form.
  const last = lines[j - 1];
  if (node.span == null && line.base != null && last.base != null) {
    node.span = [line.base, last.base + last.content.length];
  }
  return { elems: [node], next: j };
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
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      i--; // the for-loop's i++ re-lands on the \n (or past end), copied next iteration
      continue;
    }
    out += c;
  }
  return out;
}

/** Split into top-level forms (blank-line separated), keeping each form's absolute
 *  start offset in `text` — so spans computed within a form map back to the buffer.
 *  Exported so a lenient consumer (param hints) can read forms one-at-a-time and
 *  skip an unparseable one rather than lose the whole file. */
export function splitFormsWithBase(text: string): { text: string; base: number }[] {
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
export function readSweet(text: string, opts: ReadOpts = {}): Node[] {
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
      const { elems } = parseNode(lines, 0, opts.accessorDepth);
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
      if (/\s/.test(src[i])) {
        i++;
        continue;
      }
      if (src[i] === ";") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      break;
    }
    if (i >= n) break;
    const start = i;
    // A form may carry leading quote/quasiquote/unquote prefixes (they bind tight).
    while (i < n && (src[i] === "'" || src[i] === "`" || src[i] === ","))
      i += src[i] === "," && src[i + 1] === "@" ? 2 : 1;
    if (i < n && (src[i] === "(" || src[i] === "[")) {
      // Balanced bracket group, string- & comment-aware.
      let depth = 0;
      let inStr = false;
      for (; i < n; i++) {
        const c = src[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === ";") {
          while (i + 1 < n && src[i + 1] !== "\n") i++;
        } else if (c === "(" || c === "[") depth++;
        else if ((c === ")" || c === "]") && --depth === 0) {
          i++;
          break;
        }
      }
    } else if (i < n && src[i] === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else {
      // Bare atom (symbol / number).
      while (i < n && !/\s/.test(src[i]) && !'()[];"'.includes(src[i])) i++;
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
export function sweetToScheme(sweetText: string, prevClassic: string, opts: ReadOpts = {}): string {
  const sweetForms = readSweet(sweetText, opts); // throws on malformed sweet → caller handles
  const reprintAll = (): string => `${sweetForms.map((f) => printScheme(f)).join("\n\n")}\n`;

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
