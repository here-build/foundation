/**
 * types-emit — the TYPE-FAITHFUL Scheme→TS emitter for the type lens.
 *
 * Distinct from `lower.ts`/`python.ts` (the RUN-faithful idiomatic emitters): this
 * one emits virtual TS that is *type-checked, never run*, against the
 * `@here.build/arrival-type-lens` prelude (`PRE`). Every builtin application
 * lowers to a direct `__arr.<name>(…)` call so TS checks it natively against the
 * merged `ArrShape`; opaque heads fall back to PRE's `sexpr<F>(…)`.
 *
 * Because we never run the output, binding forms lower to PURE TS BLOCK
 * STATEMENTS, not IIFEs — block-scoping is correct for type-checking and adds no
 * function boundary to distort control-flow analysis (V's explicit call; see the
 * type-lens README "Emitter contract").
 *
 * It REUSES the existing front-end (parse → desugar → scope) and produces a span
 * lens: every emitted construct records the IR span it came from, so a tsc
 * diagnostic at a TS offset lifts back onto the right `.scm` form.
 */
import { parseSexprs } from "@here.build/arrival-chain/sweet";

import { desugar } from "./desugar.js";
import { cleanName } from "./names.js";
import {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "./nodes.js";
import { resolveNames } from "./scheme-scope.js";
import { isBuiltin } from "./stdlib.js";

/** One span-lens entry: a [tsStart, tsLength) range of the emitted TS that came
 *  from a [schemeStart, schemeLength) range of the source `.scm`. */
export interface Mapping {
  tsStart: number;
  tsLength: number;
  schemeStart: number;
  schemeLength: number;
}

export interface EmitTypesResult {
  ts: string;
  mappings: Mapping[];
  /** Indices (in source order) of top-level forms whose emit threw and degraded
   *  to an unmapped `unknown` placeholder — so the LSP/host can surface that a
   *  form is unanalyzed without the whole file blanking. */
  droppedForms: number[];
}

/** A TS-identifier name (used unbracketed). Anything else is a bracketed string key. */
const TS_IDENT = /^[A-Z_$][\w$]*$/i;

/** Shared empty host-member set — the default when no host roster is injected. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** `__arr.car` for an identifier-safe builtin, `__arr["string-append"]` otherwise. */
const arrMember = (name: string): string => (TS_IDENT.test(name) ? `__arr.${name}` : `__arr[${JSON.stringify(name)}]`);

/**
 * The emit buffer: appends strings while tracking the running TS offset, and
 * records a {@link Mapping} whenever an emitted run carries an IR span. Spans are
 * `[start, end)` half-open (sweet-render) → `schemeLength = end - start`.
 */
class Buf {
  private readonly parts: string[] = [];
  private len = 0;
  readonly mappings: Mapping[] = [];

  /** Append a literal TS chunk (no span). */
  raw(s: string): this {
    if (s.length > 0) {
      this.parts.push(s);
      this.len += s.length;
    }
    return this;
  }

  /** Append `s`, mapping its whole TS extent back to `node`'s IR span (if any). */
  spanned(s: string, node: Node | undefined): this {
    const span = node && (node as { span?: readonly [number, number] }).span;
    if (s.length > 0 && span) {
      this.mappings.push({
        tsStart: this.len,
        tsLength: s.length,
        schemeStart: span[0],
        schemeLength: span[1] - span[0],
      });
    }
    return this.raw(s);
  }

  get offset(): number {
    return this.len;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** Scope-resolved JS name for a bound identifier occurrence; `cleanName` for free
 *  refs / globals / builtins (absent from `nameOf`). */
type NameOf = Map<Atom, string>;

/**
 * Scan a forest for every identifier that is the target of a `(set! x …)`, by its
 * RESOLVED name — so its `const` declaration becomes a `let`. Reassignment must
 * type-check without widening every binding to `let`, so we only relax the ones
 * actually mutated.
 */
function collectSetBangNames(forest: Node[], nameOf: NameOf): Set<string> {
  const out = new Set<string>();
  const visit = (n: Node): void => {
    if (!isList(n)) return;
    if (head(n) === "set!") {
      const target = n.list[1];
      if (isAtom(target)) out.add(nameOf.get(target) ?? cleanName(target.atom));
    }
    for (const c of n.list) visit(c);
  };
  for (const f of forest) visit(f);
  return out;
}

/** The per-program emit context (shared by every node walk). */
interface Ctx {
  buf: Buf;
  nameOf: NameOf;
  setVars: Set<string>;
  /**
   * Host-injected ambient members (sift's rosetta tools). A head in this set lowers
   * to `__arr["<name>"](…)` exactly like a builtin — so `typeof __arr["<name>"]`
   * resolves against the host's `ArrShape` leaf and `Parameters<…>` of the call
   * narrows the argument slot. The runtime evaluator is unaffected (this emitter is
   * the type-lens only); host tools are conceptually the same category as builtins —
   * ambient functions resolved through `__arr` — so this is the third head case, not
   * a special-case hack. Empty by default → behavior identical to pre-roster emit.
   */
  hostMembers: ReadonlySet<string>;
}

/** Emit a single TS expression for `n` into `ctx.buf`. */
function emitExpr(n: Node, ctx: Ctx): void {
  if (isAtom(n)) return emitAtom(n, ctx);
  if (isList(n)) return emitList(n, ctx);
  // Defensive: an unexpected node shape degrades to a transparent `unknown`.
  ctx.buf.raw("(undefined as unknown)");
}

/** The emitted name for a bound identifier occurrence (namer's, or cleanName). */
function emitName(a: Atom, ctx: Ctx): string {
  return ctx.nameOf.get(a) ?? cleanName(a.atom);
}

function emitAtom(a: Atom, ctx: Ctx): void {
  if (a.str) {
    ctx.buf.spanned(JSON.stringify(decodeString(a.atom)), a);
    return;
  }
  if (isBool(a)) {
    ctx.buf.spanned(a.atom === "#t" ? "true" : "false", a);
    return;
  }
  if (isNumber(a)) {
    ctx.buf.spanned(a.atom, a);
    return;
  }
  // A bare `:keyword` in value position is meaningless (accessor/kwarg-only) —
  // degrade to a transparent `unknown` rather than emit a broken identifier.
  if (a.atom.length > 1 && a.atom.startsWith(":")) {
    ctx.buf.spanned("(undefined as unknown)", a);
    return;
  }
  ctx.buf.spanned(emitName(a, ctx), a);
}

function emitList(n: ListNode, ctx: Ctx): void {
  if (isNil(n)) {
    ctx.buf.spanned("[]", n);
    return;
  }
  const h = n.list[0]!;

  // `(:field obj)` accessor → `(obj)["field"]`. Direct member access is checked
  // natively by TS against a precise dict (and is `unknown`-transparent on an
  // opaque row), so it bites on the field-access moat without a runtime helper.
  if (isKeyword(h)) {
    const obj = n.list[1];
    const start = ctx.buf.offset;
    ctx.buf.raw("(");
    if (obj) emitExpr(obj, ctx);
    else ctx.buf.raw("undefined as unknown");
    ctx.buf.raw(`)[${JSON.stringify(keywordName(h))}]`);
    recordSpan(ctx, start, n);
    return;
  }

  const hName = isAtom(h) && !h.str ? h.atom : undefined;
  if (hName !== undefined) {
    switch (hName) {
      case "quote":
        return emitQuote(n.list[1], ctx, n);
      case "lambda":
        return emitLambda(n, ctx);
      case "if":
        return emitIf(n, ctx);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        // A let in EXPRESSION position has no statement-block placement; type-
        // faithfully it is its body's value. We emit the body expression directly
        // (the binding forms are checked as a block only at statement position —
        // see emitTopLet). For an expression-position let, fall through to a
        // transparent value so the file never blanks. The common case (let at a
        // body/top position) is handled by emitStmt.
        return emitLetExpr(n, ctx);
      case "begin":
        return emitBeginExpr(n, ctx);
      case "dict":
        return emitDict(n, ctx);
      case "set!":
        return emitSetExpr(n, ctx);
      case "define":
        // An internal define in expression position is not meaningful here.
        ctx.buf.spanned("(undefined as unknown)", n);
        return;
    }
    // A builtin OR a host-injected rosetta tool → ambient `__arr` member call.
    if (isBuiltin(hName) || ctx.hostMembers.has(hName)) return emitBuiltinCall(hName, n, ctx);
  }

  // A non-builtin head: a local binding / free fn → direct call `f(a, b)`; an
  // opaque/computed head (e.g. `((car fns) x)`) → the `sexpr` fallback.
  return emitCall(h, n.list.slice(1), ctx, n);
}

/** Record a mapping covering `[start, buf.offset)` back to `node`'s span. */
function recordSpan(ctx: Ctx, start: number, node: Node): void {
  const span = (node as { span?: readonly [number, number] }).span;
  if (!span) return;
  const tsLength = ctx.buf.offset - start;
  if (tsLength > 0) {
    ctx.buf.mappings.push({ tsStart: start, tsLength, schemeStart: span[0], schemeLength: span[1] - span[0] });
  }
}

function emitBuiltinCall(name: string, n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  ctx.buf.raw(arrMember(name)).raw("(");
  emitArgs(n.list.slice(1), ctx);
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** A call whose head is NOT a builtin: a typed local / free fn → direct call;
 *  an opaque computed head → `sexpr(head, …args)`. */
function emitCall(fn: Node, args: Node[], ctx: Ctx, form: ListNode): void {
  const start = ctx.buf.offset;
  if (isAtom(fn) && !fn.str) {
    // A named head — emit a direct call `f(a, b)`. TS checks it against the
    // binding's inferred type (or `any` if free), which is the faithful behavior.
    emitExpr(fn, ctx);
    ctx.buf.raw("(");
    emitArgs(args, ctx);
    ctx.buf.raw(")");
  } else {
    // Opaque / computed head → the typed-apply fallback so arg↔param checking is
    // preserved across the indirect application.
    ctx.buf.raw("sexpr(");
    emitExpr(fn, ctx);
    for (const a of args) {
      ctx.buf.raw(", ");
      emitExpr(a, ctx);
    }
    ctx.buf.raw(")");
  }
  recordSpan(ctx, start, form);
}

/** Comma-separated argument expressions. Keyword args `(:k v)` collapse into a
 *  single trailing options object `{ k: v }`, mirroring the call convention. */
function emitArgs(args: Node[], ctx: Ctx): void {
  const positional: Node[] = [];
  const kwargs: [string, Node][] = [];
  let i = 0;
  while (i < args.length && !isKeyword(args[i])) positional.push(args[i++]!);
  while (i < args.length) {
    const k = args[i]!;
    if (!isKeyword(k)) {
      // A positional after a keyword is malformed; degrade transparently.
      positional.push(k);
      i += 1;
      continue;
    }
    const v = args[i + 1];
    kwargs.push([keywordName(k), v ?? { atom: "#f" }]);
    i += 2;
  }
  for (const [idx, p] of positional.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(p, ctx);
  }
  if (kwargs.length > 0) {
    if (positional.length > 0) ctx.buf.raw(", ");
    ctx.buf.raw("{ ");
    for (const [idx, [k, v]] of kwargs.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      ctx.buf.raw(`${tsKey(cleanName(k))}: `);
      emitExpr(v, ctx);
    }
    ctx.buf.raw(" }");
  }
}

/** A safe object key: bare identifier, or quoted string for anything else. */
function tsKey(k: string): string {
  return TS_IDENT.test(k) ? k : JSON.stringify(k);
}

function emitDict(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const args = n.list.slice(1);
  // `(dict :k v …)` → `__arr.dict([["k", v], …] as const)` — the PRE `Dict<Pairs>`
  // mapped type turns the entry-tuple list into a precise object.
  ctx.buf.raw("__arr.dict([");
  let first = true;
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i]!;
    const key = isKeyword(k) ? keywordName(k) : isAtom(k) ? k.atom : "";
    if (!first) ctx.buf.raw(", ");
    first = false;
    ctx.buf.raw(`[${JSON.stringify(key)}, `);
    emitExpr(args[i + 1]!, ctx);
    ctx.buf.raw("]");
  }
  ctx.buf.raw("] as const)");
  recordSpan(ctx, start, n);
}

function emitIf(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const [, c, a, b] = n.list;
  ctx.buf.raw("(");
  if (c) emitExpr(c, ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(" ? ");
  if (a) emitExpr(a, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" : ");
  if (b) emitExpr(b, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

function emitLambda(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const params = paramAtoms(n.list[1]);
  ctx.buf.raw("(");
  for (const [idx, p] of params.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    if (p.rest) ctx.buf.raw("...");
    ctx.buf.raw(emitName(p.atom, ctx));
    // No param type annotation: TS infers from usage / contextual typing, which
    // is the faithful default. (A NUM-aware pass may annotate later.)
  }
  ctx.buf.raw(") => ");
  emitArrowBody(n.list.slice(2), ctx);
  recordSpan(ctx, start, n);
}

/** The body of a lambda/define arrow. A single expression → `expr`; a sequence →
 *  a `{ … return last; }` block. An object-literal sole body is parenthesized. */
function emitArrowBody(forms: Node[], ctx: Ctx): void {
  if (forms.length === 0) {
    ctx.buf.raw("(undefined as unknown)");
    return;
  }
  if (forms.length === 1) {
    const only = forms[0]!;
    // A let/begin sole body IS the arrow's own block — emit as a real block.
    if (isList(only)) {
      const h = head(only);
      if ((h === "let" || h === "let*" || h === "letrec" || h === "letrec*") && !isAtom(only.list[1])) {
        emitLetBlock(only, ctx, "return ");
        return;
      }
      if (h === "begin") {
        emitBeginBlock(only.list.slice(1), ctx, "return ");
        return;
      }
    }
    // No emitted EXPRESSION starts with a bare `{` (object literals lower to
    // `__arr.dict(…)`, blocks are handled above), so a plain expression body needs
    // no defensive parenthesization.
    emitExpr(only, ctx);
    return;
  }
  emitBeginBlock(forms, ctx, "return ");
}

/** A `(begin a b last)` as a BLOCK: `{ a; b; return last; }` (or `lead`-prefixed). */
function emitBeginBlock(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  ctx.buf.raw("{ ");
  emitBodyForms(forms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** `begin` in EXPRESSION position: not block-placeable, so we emit just the last
 *  form's value (type-faithful — a `begin`'s type is its last form's). */
function emitBeginExpr(n: ListNode, ctx: Ctx): void {
  const forms = n.list.slice(1);
  if (forms.length === 0) {
    ctx.buf.spanned("(undefined as unknown)", n);
    return;
  }
  const start = ctx.buf.offset;
  // Emit leading forms as a comma sequence so any type errors in them still bite,
  // and the value is the last form.
  if (forms.length > 1) ctx.buf.raw("(");
  for (const [idx, f] of forms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(f, ctx);
  }
  if (forms.length > 1) ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** A let / let-star / letrec as a TS BLOCK STATEMENT: `{ const x = v; body }`. The
 *  `lastPrefix` ("" at statement position, "return " inside an arrow body) is
 *  applied to the final body form. */
function emitLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  // Named let `(let loop ((x v)) …)` — a loop, not a binding block. Type-faithful
  // minimal lowering: declare the loop fn + its inits, then run the body block.
  if (isAtom(n.list[1])) {
    emitNamedLetBlock(n, ctx, lastPrefix);
    return;
  }
  const bindings = n.list[1];
  const bodyForms = n.list.slice(2);
  ctx.buf.raw("{ ");
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        const name = emitName(b.list[0], ctx);
        const kw = ctx.setVars.has(name) ? "let" : "const";
        ctx.buf.raw(`${kw} ${name} = `);
        if (b.list[1]) emitExpr(b.list[1], ctx);
        else ctx.buf.raw("undefined as unknown");
        ctx.buf.raw("; ");
      }
    }
  }
  emitBodyForms(bodyForms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** A named let → `{ const loop = (x) => {…}; <lastPrefix>loop(inits); }`. */
function emitNamedLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  const nameAtom = n.list[1] as Atom;
  const name = emitName(nameAtom, ctx);
  const bindings = n.list[2];
  const varAtoms: Atom[] = [];
  const inits: Node[] = [];
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        varAtoms.push(b.list[0]);
        inits.push(b.list[1] ?? { atom: "#f" });
      }
    }
  }
  ctx.buf.raw("{ ");
  ctx.buf.raw(`const ${name} = (`);
  for (const [idx, v] of varAtoms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    ctx.buf.raw(emitName(v, ctx));
  }
  ctx.buf.raw(") => ");
  emitArrowBody(n.list.slice(3), ctx);
  ctx.buf.raw("; ");
  ctx.buf.raw(lastPrefix);
  ctx.buf.raw(`${name}(`);
  for (const [idx, v] of inits.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(v, ctx);
  }
  ctx.buf.raw("); }");
}

/** Emit a body's forms inside an open block: leading forms as statements, the
 *  last form prefixed by `lastPrefix` (e.g. "return " / ""). */
function emitBodyForms(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  for (const [idx, f] of forms.entries()) {
    if (idx === forms.length - 1) ctx.buf.raw(lastPrefix);
    emitStmtInner(f, ctx);
    ctx.buf.raw("; ");
  }
}

/**
 * A let / begin in EXPRESSION position (where a *value* is needed and no statement
 * block can be placed — e.g. `(define r (let ((x 1)) (+ x 1)))`). We emit an
 * immediately-invoked arrow `(() => { const x = …; return …; })()`: the binding
 * forms are still type-checked and the value flows. This is the ONE place an
 * arrow-call appears — the "block-not-IIFE" rule governs STATEMENT/body position
 * (where a bare block suffices and an IIFE would distort CFA); at expression
 * position the arrow is the type-faithful way to bind-and-yield. The block body is
 * built by the same {@link emitLetBlock} used at statement position.
 */
function emitLetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  ctx.buf.raw("(() => ");
  emitLetBlock(n, ctx, "return ");
  ctx.buf.raw(")()");
  recordSpan(ctx, start, n);
}

function emitSetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const target = n.list[1];
  ctx.buf.raw("(");
  if (isAtom(target)) ctx.buf.raw(emitName(target, ctx));
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" = ");
  if (n.list[2]) emitExpr(n.list[2], ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

function emitQuote(datum: Node | undefined, ctx: Ctx, form: Node): void {
  const start = ctx.buf.offset;
  emitQuoteDatum(datum, ctx);
  recordSpan(ctx, start, form);
}

function emitQuoteDatum(datum: Node | undefined, ctx: Ctx): void {
  if (datum === undefined) {
    ctx.buf.raw("undefined as unknown");
    return;
  }
  if (isAtom(datum)) {
    if (datum.str) ctx.buf.raw(JSON.stringify(decodeString(datum.atom)));
    else if (isNumber(datum)) ctx.buf.raw(datum.atom);
    else if (isBool(datum)) ctx.buf.raw(datum.atom === "#t" ? "true" : "false");
    else ctx.buf.raw(JSON.stringify(datum.atom)); // quoted symbol → string
    return;
  }
  ctx.buf.raw("[");
  for (const [idx, d] of datum.list.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitQuoteDatum(d, ctx);
  }
  ctx.buf.raw("]");
}

// ── statement-position emit (top-level + body) ───────────────────────────────

/** Emit a top-level / body form as a STATEMENT. A value-bearing form is a bare
 *  expression here — the caller adds any `return`/`;` prefix/suffix. */
function emitStmtInner(form: Node, ctx: Ctx): void {
  if (isList(form) && head(form) === "define") {
    emitDefine(form, ctx);
    return;
  }
  if (
    isList(form) &&
    (head(form) === "let" || head(form) === "let*" || head(form) === "letrec" || head(form) === "letrec*")
  ) {
    // A let at statement position is a real block statement.
    emitLetBlock(form, ctx, "");
    return;
  }
  if (isList(form) && head(form) === "begin") {
    emitBeginBlock(form.list.slice(1), ctx, "");
    return;
  }
  emitExpr(form, ctx);
}

function emitDefine(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const sig = n.list[1];
  if (isList(sig)) {
    // `(define (f a b) body)` → `const f = (a, b) => { … };`
    const nameAtom = isAtom(sig.list[0]) ? sig.list[0] : undefined;
    const name = nameAtom ? emitName(nameAtom, ctx) : "_";
    const params = paramAtoms({ list: sig.list.slice(1) });
    const kw = ctx.setVars.has(name) ? "let" : "const";
    ctx.buf.raw(`${kw} ${name} = (`);
    for (const [idx, p] of params.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      if (p.rest) ctx.buf.raw("...");
      ctx.buf.raw(emitName(p.atom, ctx));
    }
    ctx.buf.raw(") => ");
    emitArrowBody(n.list.slice(2), ctx);
  } else {
    // `(define x v)` → `const x = <v>;`
    const name = isAtom(sig) ? emitName(sig, ctx) : "_";
    const kw = ctx.setVars.has(name) ? "let" : "const";
    ctx.buf.raw(`${kw} ${name} = `);
    if (n.list[2]) emitExpr(n.list[2], ctx);
    else ctx.buf.raw("undefined as unknown");
  }
  recordSpan(ctx, start, n);
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Parameter atoms, dotted rest `(a b . rest)` flagged. */
function paramAtoms(node: Node | undefined): { atom: Atom; rest: boolean }[] {
  if (!isList(node)) return [];
  const out: { atom: Atom; rest: boolean }[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push({ atom: rest, rest: true });
      break;
    }
    if (isAtom(p)) out.push({ atom: p, rest: false });
  }
  return out;
}

/** Decode a scheme string literal's escapes (parser stores them raw). */
function decodeString(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c;
    }
  });
}

/**
 * Emit type-faithful virtual TS for an arrival-chain Scheme program, with a span
 * lens back to the source. The emitted module references the `@here.build/
 * arrival-type-lens` prelude globals (`__arr`, `sexpr`, `Dict`) — prepend `PRE`
 * (unmapped) before type-checking.
 *
 * Each top-level form is emitted under its own try/catch: a parse/emit failure on
 * one form degrades THAT form to an unmapped `unknown` (recorded in
 * `droppedForms`) and never throws out of `emitTypes`, so the LSP never blanks all
 * diagnostics. The module ends with `export {};` so top-level `const` bindings
 * are module-scoped and never collide across files in a shared program.
 */
export interface EmitTypesOptions {
  /** Host-injected ambient member names (sift rosetta tools) — heads lowered via
   *  `__arr[...]` so the type-lens resolves their signatures. See `Ctx.hostMembers`. */
  hostMembers?: ReadonlySet<string>;
}

export function emitTypes(scheme: string, opts?: EmitTypesOptions): EmitTypesResult {
  const buf = new Buf();
  const droppedForms: number[] = [];

  let forest: Node[];
  try {
    forest = desugar(parseSexprs(scheme));
  } catch {
    // Whole-program parse failure: emit an empty module rather than throw.
    return { ts: "export {};\n", mappings: [], droppedForms: [] };
  }

  const nameOf = resolveNames(forest, []);
  const setVars = collectSetBangNames(forest, nameOf);
  const ctxBase: Ctx = { buf, nameOf, setVars, hostMembers: opts?.hostMembers ?? EMPTY_SET };

  for (const [idx, form] of forest.entries()) {
    // `(require …)` is an environment directive (load a file into the env), not
    // a value form — there is nothing to type-check IN THIS BUFFER. Emitting it
    // as a call produced a bogus `Cannot find name 'require'` (+ an @types/node
    // upsell) from tsc. Skipped + recorded; the names a require brings into
    // scope stay unresolved until the lens grows cross-file resolution.
    if (isList(form) && head(form) === "require") {
      droppedForms.push(idx);
      continue;
    }
    const checkpoint = buf.offset;
    try {
      emitStmtTop(form, ctxBase);
      buf.raw(";\n");
    } catch {
      // Degrade this form to a transparent `unknown`. We can't easily rewind the
      // buffer, so append a fresh transparent statement; the partial emit (if any)
      // is harmless TS prefix. Record the drop.
      if (buf.offset === checkpoint) buf.raw("undefined as unknown;\n");
      droppedForms.push(idx);
    }
  }

  buf.raw("export {};\n");
  return { ts: buf.toString(), mappings: buf.mappings, droppedForms };
}

/** A top-level form: define → const; let/begin → block statement; else → expr stmt. */
function emitStmtTop(form: Node, ctx: Ctx): void {
  emitStmtInner(form, ctx);
}
