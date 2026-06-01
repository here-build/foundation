/**
 * EXPERIMENT (spike) — classic Scheme → sweet-expression RENDERER.
 *
 * The interesting half of a classic↔sweet bifunctor: sweet→classic is a
 * deterministic reader (SRFI-110 unsweeten), but classic→sweet is a *choice* of
 * layout. This is a first HEURISTIC renderer (width-budget + a fixed head-line
 * rule) to SEE how the sweet shape reads on our real .scm — NOT the MDL-optimal
 * version yet. If the shape is promising, the heuristic's failure modes tell us
 * what an MDL layout-cost must capture (the Yelland/optimal-DP step).
 *
 * Layers rendered (SRFI-105 + SRFI-110):
 *   • curly-infix     (- n 1)            → {n - 1}        ; arithmetic/comparison only
 *   • neoteric        (f x y)            → f(x y)         ; optional (reads odd for data/pairs)
 *   • indentation     big forms          → head on a line, children indented
 *
 * KNOWN v0 LIMITATIONS (deliberate, for the spike):
 *   • COMMENTS ARE DROPPED. Our files lean on them for readability — a real tool
 *     must attach leading/trailing comments to nodes. This shows code shape only.
 *   • head-line rule is fixed ("pull first arg if it fits"), not optimized.
 *   • no $ / \\ group markers, no vectors / #\char.
 */

export type Node = { atom: string; str?: boolean } | { list: Node[] };

// null-safe: items[0] of an empty list `()` is undefined; isAtom(undefined) must
// be false, not throw ('in' on undefined). Empty lists come from `'()` folds.
const isAtom = (n: Node | undefined): n is { atom: string; str?: boolean } => n != null && "atom" in n;

// ── parser: source text → plain tree (comments stripped) ──────────────────────
export function parseSexprs(src: string): Node[] {
  let i = 0;
  const n = src.length;
  const isDelim = (c: string | undefined) =>
    c === undefined || /\s/.test(c) || c === "(" || c === ")" || c === "[" || c === "]" || c === '"' || c === ";";

  const skipWs = () => {
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === ";") { while (i < n && src[i] !== "\n") i++; continue; }
      break;
    }
  };

  const readString = (): Node => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === '"') { i++; return { atom: out, str: true }; }
      out += c; i++;
    }
    throw new Error("unterminated string");
  };

  const readDatum = (): Node => {
    skipWs();
    const c = src[i];
    if (c === undefined) throw new Error("unexpected EOF");
    if (c === "(" || c === "[") return readList(c === "(" ? ")" : "]");
    if (c === ")" || c === "]") throw new Error(`unexpected ${c} at ${i}`);
    if (c === '"') return readString();
    if (c === "'") { i++; return { list: [{ atom: "quote" }, readDatum()] }; }
    if (c === "`") { i++; return { list: [{ atom: "quasiquote" }, readDatum()] }; }
    if (c === ",") {
      i++;
      if (src[i] === "@") { i++; return { list: [{ atom: "unquote-splicing" }, readDatum()] }; }
      return { list: [{ atom: "unquote" }, readDatum()] };
    }
    const start = i;
    while (i < n && !isDelim(src[i])) i++;
    return { atom: src.slice(start, i) };
  };

  function readList(close: ")" | "]"): Node {
    i++; // open
    const items: Node[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === undefined) throw new Error("unbalanced list");
      if (c === ")" || c === "]") { i++; break; }
      items.push(readDatum());
    }
    return { list: items };
  }

  const forms: Node[] = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    forms.push(readDatum());
  }
  return forms;
}

// ── renderer ──────────────────────────────────────────────────────────────────
export interface SweetOpts {
  width: number;
  neoteric: boolean;
  curly: boolean;
  /** Heads whose args are key→value pairs: `dict` + every name bound to a
   *  `(require "….prompt")` callable. Under these, a `:keyword value` run is
   *  rendered as a pair line. Homoiconic: the pair is a tree node in the VIEW
   *  that collapses back to the flat `… k v …` canonical on read. */
  kwargHeads: Set<string>;
  /** Surface glyph for a key→value pair:
   *   "=>" → `:tagline => value`  (key unchanged — keeps construct/access symmetry)
   *   ":"  → `tagline: value`     (JSON/YAML — leading colon flips to trailing) */
  pairGlyph: "=>" | ":";
}
export const DEFAULT_OPTS: SweetOpts = {
  width: 64, neoteric: false, curly: true, kwargHeads: new Set(["dict"]), pairGlyph: ":",
};

const QUOTE_PREFIX: Record<string, string> = {
  quote: "'", quasiquote: "`", unquote: ",", "unquote-splicing": ",@",
};
// Symbols that READ as infix get curly-sugar — not every binary head.
const INFIX = new Set([
  "+", "-", "*", "/", "<", ">", "<=", ">=", "modulo", "quotient", "remainder",
  "=", "equal?", "eq?", "eqv?", // equality
  "and", "or",                  // logical
]);
// Canonical op → display glyph. STORED op unchanged; the view swaps in the familiar
// symbol. The map is INJECTIVE for a faithful round-trip: only `equal?`→`==` (the
// structural-equality common case), `and`/`or`→`&&`/`||`. `=` (numeric), `eq?`,
// `eqv?` render AS THEMSELVES — they're different ops, and collapsing them to `==`
// would make view+save rewrite `(= n 0)` → `(equal? n 0)`. `{n = 0}` reads fine as a
// comparison; the assignment association is weak inside a visibly-expression curly.
const INFIX_GLYPH: Record<string, string> = {
  "equal?": "==", and: "&&", or: "||",
};
const glyphOf = (op: string): string => INFIX_GLYPH[op] ?? op;

// Precedence ladder (higher binds tighter), keyed on the CANONICAL op. This is a
// deliberate departure from SRFI-105 (which is precedence-free): it lets a child
// that binds tighter than its parent drop its braces, so compound expressions read
// like C/JS — {v == "click" || v == "keep-reading"} instead of {{…} || {…}}.
//   `||` ⟨ `&&` ⟨ comparison ⟨ additive ⟨ multiplicative
const INFIX_PREC: Record<string, number> = {
  or: 1, and: 2,
  "=": 3, "equal?": 3, "eq?": 3, "eqv?": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5, modulo: 5, quotient: 5, remainder: 5,
};
const precOf = (op: string): number => INFIX_PREC[op] ?? 3;

/** Render the INSIDE of an infix node (no outer braces): `a glyph b glyph …`,
 *  recursing through operands at this op's precedence. */
function infixContent(items: Node[], o: SweetOpts): string {
  const op = (items[0] as { atom: string }).atom;
  const myPrec = precOf(op);
  return items.slice(1).map((x) => infixOperand(x, myPrec, o)).join(` ${glyphOf(op)} `);
}

/** Render an operand inside an infix at `parentPrec`. An infix operand keeps its
 *  braces only when it binds the same or looser than the parent (so grouping is
 *  preserved, incl. non-associative `-`/`/`); a tighter operand drops them and
 *  shares the zone. Non-infix operands render normally. */
function infixOperand(nd: Node, parentPrec: number, o: SweetOpts): string {
  if (!isAtom(nd) && nd.list.length >= 3 && isInfix(nd.list, o)) {
    const opPrec = precOf((nd.list[0] as { atom: string }).atom);
    const content = infixContent(nd.list, o);
    return opPrec <= parentPrec ? `{${content}}` : content;
  }
  return inlineSweet(nd, o);
}

/** `(lambda (params…) single-body)` — rendered as an arrow `{(params) => body}`.
 *  Curly-wrapped so it's self-delimiting (drops in anywhere) AND shares the infix
 *  zone (the body composes: `{(x) => x * 2}`). Only single-body, list-param
 *  lambdas; multi-body or rest-param lambdas stay classic `lambda` form. */
const isArrowLambda = (items: Node[]): boolean =>
  items.length === 3 && isAtom(items[0]) && !items[0].str && items[0].atom === "lambda" && !isAtom(items[1]);

/** Render an arrow body. `=>` is the loosest operator (precedence 0), so the body
 *  shares the arrow's `{}` — any infix body (prec ≥ 1) drops its braces. */
function inlineArrowBody(nd: Node, o: SweetOpts): string {
  return infixOperand(nd, 0, o);
}

const isQuoteForm = (items: Node[]): boolean =>
  items.length === 2 && isAtom(items[0]) && !items[0].str && QUOTE_PREFIX[items[0].atom] !== undefined;

const hasDot = (items: Node[]): boolean => items.some((it) => isAtom(it) && !it.str && it.atom === ".");

const isInfix = (items: Node[], o: SweetOpts): boolean =>
  o.curly && items.length >= 3 && !hasDot(items) && isAtom(items[0]) && !items[0].str && INFIX.has(items[0].atom);

const isKeyword = (nd: Node): boolean => isAtom(nd) && !nd.str && nd.atom.startsWith(":") && nd.atom.length > 1;

/** A literal `(require "….prompt")` — the inline-require call style used in the
 *  examples (vs. the bound-name style `(define react (require …))` in fixtures).
 *  Both are kwarg-takers; only `.prompt` (not `.hbs`, which takes positionals). */
const isRequirePrompt = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length === 2 &&
  isAtom(nd.list[0]) && nd.list[0].atom === "require" &&
  isAtom(nd.list[1]) && !!nd.list[1].str && nd.list[1].atom.endsWith(".prompt");

const isKwargHead = (items: Node[], o: SweetOpts): boolean =>
  items.length > 0 &&
  ((isAtom(items[0]) && !items[0].str && o.kwargHeads.has(items[0].atom)) || isRequirePrompt(items[0]));

/** A head is a kwarg-taker if it's `dict` or a name bound to a `.prompt` require. */
export function collectKwargHeads(forms: Node[]): Set<string> {
  const heads = new Set<string>(["dict"]);
  for (const f of forms) {
    if (isAtom(f) || f.list.length < 3) continue;
    const [h, name, val] = f.list;
    if (
      isAtom(h) && h.atom === "define" && isAtom(name) &&
      !isAtom(val) && val.list.length === 2 &&
      isAtom(val.list[0]) && val.list[0].atom === "require" &&
      isAtom(val.list[1]) && val.list[1].str && val.list[1].atom.endsWith(".prompt")
    ) heads.add(name.atom);
  }
  return heads;
}

/** One-line rendering, no width check. */
export function inlineSweet(nd: Node, o: SweetOpts): string {
  if (isAtom(nd)) return nd.str ? `"${nd.atom}"` : nd.atom;
  const items = nd.list;
  if (items.length === 0) return "()";
  if (isQuoteForm(items)) return QUOTE_PREFIX[(items[0] as { atom: string }).atom] + inlineSweet(items[1], o);
  if (isInfix(items, o)) {
    return "{" + infixContent(items, o) + "}";
  }
  if (isArrowLambda(items)) {
    return "{" + inlineSweet(items[1], o) + " => " + inlineArrowBody(items[2], o) + "}";
  }
  if (isCoalesce(nd)) {
    return "{" + infixOperand(items[1], 1, o) + " ?? " + infixOperand(items[3], 1, o) + "}";
  }
  if (o.neoteric && !hasDot(items) && isAtom(items[0]) && !items[0].str && QUOTE_PREFIX[items[0].atom] === undefined) {
    return `${items[0].atom}(` + items.slice(1).map((it) => inlineSweet(it, o)).join(" ") + ")";
  }
  return "(" + items.map((it) => inlineSweet(it, o)).join(" ") + ")";
}

/** A flat list = every element is an atom, e.g. a function signature `(f x y)`. */
const isFlatList = (nd: Node): boolean => !isAtom(nd) && nd.list.length > 0 && nd.list.every(isAtom);

/** A function `define` — `(define (name args…) body…)` with a FLAT-LIST signature.
 *  These always render broken (`define (sig)` ⏎ body), never inline as
 *  `(define (f x) body)`, so every function definition is shaped identically
 *  regardless of width (the inline/broken mix reads as an imbalance). */
const isFnDefine = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length >= 2 && isAtom(nd.list[0]) && !nd.list[0].str &&
  nd.list[0].atom === "define" && isFlatList(nd.list[1]);

/** `(cond …)` — always rendered vertical: `cond` ⏎ each clause as `test` ⏎
 *  consequence (never inline, never starting from `(`). Reconstructed by plain
 *  I-expressions: a `test` line + consequence child reads back as (test cons). */
const isCondForm = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length >= 1 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === "cond";

/** `(if X X Y)` (cond ≡ then) — the null-coalescing pattern, rendered `{X ?? Y}`.
 *  Pure sweet sugar over the if-pattern (no stored macro); reads back to (if X X Y),
 *  preserving its eval-twice semantics. `??` precedence ≈ `||`. */
const isCoalesce = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length === 4 && isAtom(nd.list[0]) && !nd.list[0].str &&
  nd.list[0].atom === "if" && nodeEq(nd.list[1], nd.list[2]);

const LET_FAMILY = new Set(["let", "let*", "letrec", "letrec*"]);
const isBindingShaped = (nd: Node): boolean => !isAtom(nd) && nd.list.length === 2 && isAtom(nd.list[0]);
/** A `let`/`let*`/`letrec`/`letrec*` whose bindings can be ELIDED in the view
 *  (each binding shown as `name` ⏎ `value`, dropping the `(( ))`). Safe only when
 *  every binding is `(sym val)` AND the body's first expr is NOT itself binding-
 *  shaped (else the reader couldn't tell where bindings end). Named `let` excluded
 *  (items[1] would be a symbol, not a bindings list). Unsafe → generic render
 *  (bindings stay a `(( ))` paren group), which is still faithful. */
const isLetElidable = (nd: Node): boolean => {
  if (isAtom(nd) || nd.list.length < 2) return false;
  const [h, binds] = nd.list;
  if (!isAtom(h) || h.str || !LET_FAMILY.has(h.atom)) return false;
  if (isAtom(binds) || binds.list.length === 0 || !binds.list.every(isBindingShaped)) return false;
  const body = nd.list.slice(2);
  return body.length > 0 && !isBindingShaped(body[0]);
};

/** Break a too-long curly-infix `{a op b op …}` operator-led: first operand after
 *  `{`, each subsequent on its own line prefixed with the operator. Recurses, so a
 *  nested long curly (e.g. `{{a - b} < c}`) breaks at every level that overflows. */
function formatInfix(items: Node[], col: number, o: SweetOpts): string {
  const op = (items[0] as { atom: string }).atom;
  const operands = items.slice(1);
  let out = "{" + formatSweet(operands[0], col + 1, o);
  const contCol = col + 2;
  for (let k = 1; k < operands.length; k++) {
    const g = glyphOf(op);
    out += "\n" + " ".repeat(contCol) + g + " " + formatSweet(operands[k], contCol + g.length + 1, o);
  }
  return out + "}";
}

/** Render a node starting at column `col`; breaks to indented sweet form when it
 *  exceeds the width budget. First line is unindented (caller positions it). */
export function formatSweet(nd: Node, col: number, o: SweetOpts): string {
  const flat = inlineSweet(nd, o);
  // Function defines, cond, and elidable let-family always break (uniform shape,
  // even if they'd fit); everything else stays inline when it fits.
  if (col + flat.length <= o.width && !isFnDefine(nd) && !isCondForm(nd) && !isLetElidable(nd)) return flat;
  if (isAtom(nd)) return flat;
  const items = nd.list;
  if (items.length === 0) return "()";
  // A 1-element list `(X)` can't break via indentation — a lone indented child
  // reads back as X, not (X) — so keep it inline even past the width budget
  // (e.g. a single long `let` binding `((cls (map …)))`). Round-trip > width here.
  if (items.length === 1) return flat;

  if (isCoalesce(nd)) return inlineSweet(nd, o); // keep `{X ?? Y}`, never break as an `if`

  // let-family with elidable bindings: `let*` ⏎ each binding `name` ⏎ `value` ⏎ body.
  // The `(( ))` is dropped in the view; the reader re-groups leading binding-shaped
  // children. (Unsafe lets never reach here — isLetElidable already excluded them.)
  if (isLetElidable(nd)) {
    const pad2 = " ".repeat(col + 2);
    const pad4 = " ".repeat(col + 4);
    const out = [(items[0] as { atom: string }).atom];
    // isLetElidable guarantees items[1] is a non-empty list of binding-shaped
    // `(name value)` 2-lists (see its `binds.list.every(isBindingShaped)` gate),
    // so these narrowing casts are sound — same idiom as items[0] above.
    for (const b of (items[1] as { list: Node[] }).list) {
      const bind = (b as { list: Node[] }).list;
      out.push(pad2 + formatSweet(bind[0], col + 2, o));      // binding name
      out.push(pad4 + formatSweet(bind[1], col + 4, o));      // binding value
    }
    for (const bodyExpr of items.slice(2)) out.push(pad2 + formatSweet(bodyExpr, col + 2, o));
    return out.join("\n");
  }

  // cond: `cond` ⏎ each clause as `test` ⏎ consequence(s). A 1-element clause
  // `(test)` stays a paren group (can't break losslessly). Reconstructed by plain
  // I-expressions (a `test` line + consequence child → (test cons)).
  if (isCondForm(nd)) {
    const pad2 = " ".repeat(col + 2);
    const pad4 = " ".repeat(col + 4);
    const out = ["cond"];
    for (const clause of items.slice(1)) {
      if (isAtom(clause) || clause.list.length < 2) { out.push(pad2 + inlineSweet(clause, o)); continue; }
      out.push(pad2 + formatSweet(clause.list[0], col + 2, o)); // test (curly if infix)
      for (const cons of clause.list.slice(1)) out.push(pad4 + formatSweet(cons, col + 4, o));
    }
    return out.join("\n");
  }

  if (isQuoteForm(items)) {
    const pre = QUOTE_PREFIX[(items[0] as { atom: string }).atom];
    return pre + formatSweet(items[1], col + pre.length, o);
  }
  if (isInfix(items, o)) return formatInfix(items, col, o); // operator-led break when over width

  // kwarg-head break: render `:key value` runs as `:key => value` pair lines.
  // The pair is a synthetic (=> k v) view-node; it stays atomic (never split
  // mid-pair — the failure the flat indenter had). Leading positionals (e.g. a
  // .prompt cache-key) render before the first keyword, untouched.
  if (isKwargHead(items, o)) {
    let line = inlineSweet(items[0], o);
    let i = 1;
    if (i < items.length && !isKeyword(items[i])) {
      const a1 = inlineSweet(items[i], o);
      if (col + line.length + 1 + a1.length <= o.width) { line += " " + a1; i++; }
    }
    const pad = " ".repeat(col + 2);
    const out = [line];
    while (i < items.length) {
      if (isKeyword(items[i]) && i + 1 < items.length) {
        // "=>" keeps the keyword as-is; ":" flips leading→trailing colon (JSON/YAML).
        const raw = (items[i] as { atom: string }).atom;
        const keyPart = o.pairGlyph === ":" ? `${raw.slice(1)}:` : `${raw} =>`;
        const vFlat = inlineSweet(items[i + 1], o);
        if (col + 2 + keyPart.length + 1 + vFlat.length <= o.width) {
          // fits: `key: value` on one line.
          out.push(pad + keyPart + " " + vFlat);
        } else {
          // value must break: HANG it on the next line at a fixed +2 step rather
          // than aligning under the value's start column — aligning makes deep
          // nesting staircase rightward (key-length compounds per level). The
          // hang keeps indentation linear in depth, YAML-style (`key:` ⏎ block).
          out.push(pad + keyPart);
          out.push(" ".repeat(col + 4) + formatSweet(items[i + 1], col + 4, o));
        }
        i += 2;
      } else {
        out.push(pad + formatSweet(items[i], col + 2, o));
        i++;
      }
    }
    return out.join("\n");
  }

  // sweet break: head on its own line (+ first arg if it still fits), rest indented.
  // If the head is itself a long compound (e.g. a `let` binding `(v (triage …))`),
  // BREAK it rather than inlining — inlining a compound head is what produced
  // 190-char lines for binding lists. A short/atom head keeps the first-arg pull.
  const headFlat = inlineSweet(items[0], o);
  const headFits = col + headFlat.length <= o.width;
  let line = headFits ? headFlat : formatSweet(items[0], col, o);
  let idx = 1;
  // Pull the first arg onto the head line ONLY if ≥1 element still remains as a
  // child (`items.length > 2`). A broken list is recovered by the reader as
  // "head line + indented children" — if pulling left ZERO children, the line
  // would read back as a flat token sequence, silently dropping the list's parens
  // (`((c …) (b …))` → `(c …) (b …)`). Keeping a child preserves the list.
  if (headFits && items.length > 2) {
    const a1 = inlineSweet(items[1], o);
    if (col + headFlat.length + 1 + a1.length <= o.width) { line += " " + a1; idx = 2; }
  }
  const pad = " ".repeat(col + 2);
  const out = [line];
  for (; idx < items.length; idx++) out.push(pad + formatSweet(items[idx], col + 2, o));
  return out.join("\n");
}

// ── the pairing bijection (the bifunctor's core, as homoiconic tree-rewrites) ──
//
// inflate: flat canonical → view tree, grouping each `:key value` run under a
//   kwarg-head into a `(=> key value)` pair node (the internal tag is `=>`; the
//   DISPLAY glyph — `:` or `=>` — is a separate render choice).
// flatten: view tree → flat canonical, splicing every pair node back to `key value`.
// Law: flatten(inflate(t)) ≡ t. Storage stays flat (lowest entropy); the paired
// form exists only in the view. Odd-arity/non-keyword simply doesn't pair (and is
// already dict's own runtime error), so the transform is total AND lossless.
const PAIR_TAG = "=>";
const isPairNode = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length === 3 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === PAIR_TAG;

export function inflateKwargs(nd: Node, heads: Set<string>): Node {
  if (isAtom(nd)) return nd;
  const items = nd.list.map((c) => inflateKwargs(c, heads));
  if (!isKwargHead(items, { ...DEFAULT_OPTS, kwargHeads: heads })) return { list: items };
  const out: Node[] = [items[0]];
  let i = 1;
  while (i < items.length) {
    if (isKeyword(items[i]) && i + 1 < items.length) {
      out.push({ list: [{ atom: PAIR_TAG }, items[i], items[i + 1]] });
      i += 2;
    } else { out.push(items[i]); i++; }
  }
  return { list: out };
}

export function flattenKwargs(nd: Node): Node {
  if (isAtom(nd)) return nd;
  const out: Node[] = [];
  for (const c of nd.list) {
    if (isPairNode(c)) out.push(flattenKwargs((c as { list: Node[] }).list[1]), flattenKwargs((c as { list: Node[] }).list[2]));
    else out.push(flattenKwargs(c));
  }
  return { list: out };
}

/** Structural equality on parsed trees (atom text + string-ness; list shape). */
export function nodeEq(a: Node, b: Node): boolean {
  if (isAtom(a) && isAtom(b)) return a.atom === b.atom && !!a.str === !!b.str;
  if (!isAtom(a) && !isAtom(b)) return a.list.length === b.list.length && a.list.every((x, i) => nodeEq(x, b.list[i]));
  return false;
}

/** Single-line classic serialization of a Node — the trivial inverse of
 *  parseSexprs at the atom level. String atoms wrap RAW (`"${atom}"`), exactly
 *  as inlineSweet does and as parseSexprs decodes them, so the AST round-trips. */
export function inlineScheme(nd: Node): string {
  if (isAtom(nd)) return nd.str ? `"${nd.atom}"` : nd.atom;
  return "(" + nd.list.map(inlineScheme).join(" ") + ")";
}

/** Pretty classic (prefix-only) serialization of a Node: inline when it fits the
 *  width, else break — the head (and, when the head is a bare symbol and the pair
 *  still fits, the first operand) stay on the open-paren line; the rest indent at
 *  col+2. Pure s-expressions, NO sweet transforms — this is the canonical-classic
 *  writer the sweet save-back emits for a CHANGED form. It only adds whitespace
 *  over inlineScheme, so parseSexprs(printScheme(f)) ≡ f. */
export function printScheme(nd: Node, col = 0, width = DEFAULT_OPTS.width): string {
  const flat = inlineScheme(nd);
  if (isAtom(nd) || col + flat.length <= width) return flat;
  const items = nd.list;
  if (items.length <= 1) return flat; // () / (X): nothing to gain by breaking
  // Keep the head on the open line; pull the first operand up too when the head
  // is a bare symbol and the pair still fits — so `(define (f x)` / `(if test`
  // read naturally instead of head-alone.
  const pair = `${inlineScheme(items[0])} ${inlineScheme(items[1])}`;
  const pull = isAtom(items[0]) && items.length > 2 && col + 1 + pair.length <= width;
  const lead = pull ? pair : inlineScheme(items[0]);
  const pad = " ".repeat(col + 2);
  const rest = items.slice(pull ? 2 : 1).map((it) => pad + printScheme(it, col + 2, width));
  return `(${lead}\n${rest.join("\n")})`;
}

/** Render a whole source file's top-level forms as sweet, blank-line separated. */
export function schemeToSweet(src: string, opts: Partial<SweetOpts> = {}): string {
  const forms = parseSexprs(src);
  const o = { ...DEFAULT_OPTS, kwargHeads: collectKwargHeads(forms), ...opts };
  return forms.map((f) => formatSweet(f, 0, o)).join("\n\n");
}
