// canonizer.ts — the canonizer registry: read-normalize (surface → canonical) AND render-emit
// (canonical → preferred surface), with a per-row round-trip law `read(emit(c)) === c`.
//
// Design: docs/working-proposals/arrival-sweet-extension-design-ideation-2026-06-15.md ("The canonizer
// registry"), modeled on invertible syntax descriptions (Rendel–Ostermann) / Coq Notation (one
// description, both directions) + egg-style preferred-representative extraction (the policy below).
//
// Two row kinds:
//   - spelling rows (glyph ⇌ verb): `&&`⇌`and`, `==`⇌`equal?`, `??`⇌`or/maybe`
//   - precedence rows (arithmetic): multiplicative ⊐ additive — drive read-resolution and emit-elision
//
// DEFERRED (decided, not wired): `||`⇌`or` (pipe-symbol lexer collision); `=>` preferred fn-expr shape
// (V 2026-06-15) — `=>` is a syntax-rules literal in `cond`, so aliasing it as a value needs the cond
// interaction resolved first; the `or/maybe` binding lives in srfi-189 (Maybe module).

import { is_pair } from "./guards.js";
import type { Pair } from "./Pair.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import type { SchemeValue } from "./types.js";

// ---------------------------------------------------------------------------
// spelling rows
// ---------------------------------------------------------------------------

/** Glyph → readable verb (read direction). Conflict-free glyphs only. */
export const GLYPH_MAP: Record<string, string> = {
  "&&": "and",
  "==": "equal?",
  "??": "or/maybe",
};
/** Verb → glyph (emit direction), the inverse of GLYPH_MAP. */
const VERB_TO_GLYPH: Record<string, string> = Object.fromEntries(
  Object.entries(GLYPH_MAP).map(([g, v]) => [v, g]),
);

// ---------------------------------------------------------------------------
// precedence rows (the arithmetic license table — the one formal divergence)
// ---------------------------------------------------------------------------

export interface Fixity {
  prec: number;
  assoc: "left";
}
/** Multiplicative (7) binds tighter than additive (6); both left-assoc. Only these are licensed. */
export const FIXITY: Record<string, Fixity> = {
  "*": { prec: 7, assoc: "left" },
  "/": { prec: 7, assoc: "left" },
  modulo: { prec: 7, assoc: "left" },
  quotient: { prec: 7, assoc: "left" },
  remainder: { prec: 7, assoc: "left" },
  "+": { prec: 6, assoc: "left" },
  "-": { prec: 6, assoc: "left" },
};

/** Operators that prefer the infix surface — `(op a b)` renders as `{a op b}`. Arithmetic + the
 *  round-trippable glyph-verbs + comparison. (`or`/`||` excluded until the pipe-symbol fix.) */
const INFIX_RENDER = new Set<string>([
  ...Object.keys(FIXITY),
  "and",
  "equal?",
  "or/maybe",
  "<",
  ">",
  "<=",
  ">=",
]);

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function symName(v: SchemeValue): string | null {
  if (v instanceof SchemeSymbol) {
    const n = v.__name__;
    return typeof n === "string" ? n : String(v.valueOf());
  }
  return null;
}

/** The operator name of a value, or null if it isn't a symbol. */
export function opName(v: SchemeValue): string | null {
  return symName(v);
}

/** Binding power of a value as an infix operator, or -1 if it isn't a licensed operator. */
export function prec(v: SchemeValue): number {
  const name = symName(v);
  return name !== null && name in FIXITY ? FIXITY[name].prec : -1;
}

// ---------------------------------------------------------------------------
// read direction: glyph → verb
// ---------------------------------------------------------------------------

/** Lower a glyph operator to its verb; pass non-glyphs through unchanged. Run at the operator
 *  position so `&&` and `and` collapse to one equivalence class before classification. */
export function normalizeGlyph(op: SchemeValue): SchemeValue {
  const name = symName(op);
  if (name !== null && name in GLYPH_MAP) {
    return new SchemeSymbol(GLYPH_MAP[name]);
  }
  return op;
}

// ---------------------------------------------------------------------------
// emit direction: canonical s-expr → sweet surface text
// ---------------------------------------------------------------------------

/** Render a canonical form to its preferred sweet surface. Round-trips: `read(renderSweet(c)) = c`.
 *  Infix-preferred operators become `{a op b}` (glyph-substituted, brace-minimal for arithmetic);
 *  everything else is ordinary prefix, recursing so nested infix still surfaces. */
export function renderSweet(form: SchemeValue): string {
  if (!is_pair(form)) return String(form);
  const arr = (form as Pair).to_array(false) as SchemeValue[];
  const head = arr[0];
  const name = symName(head);
  const args = arr.slice(1);
  if (name !== null && INFIX_RENDER.has(name) && args.length >= 2) {
    return "{" + renderInfixBody(name, args) + "}";
  }
  return "(" + arr.map(renderSweet).join(" ") + ")";
}

/** The inside of a `{ … }` — operands joined by the glyph, each braced only when required. */
function renderInfixBody(verb: string, args: SchemeValue[]): string {
  const glyph = VERB_TO_GLYPH[verb] ?? verb;
  return args.map((arg) => renderInfixOperand(arg, verb)).join(` ${glyph} `);
}

/** Render one operand of an infix parent: a nested infix form is emitted braceless only when the
 *  arithmetic precedence makes it unambiguous (child strictly tighter); otherwise it keeps its
 *  braces — conservative, so every form round-trips to the exact tree. */
function renderInfixOperand(arg: SchemeValue, parentVerb: string): string {
  if (is_pair(arg)) {
    const a = (arg as Pair).to_array(false) as SchemeValue[];
    const childName = symName(a[0]);
    if (childName !== null && INFIX_RENDER.has(childName) && a.length - 1 >= 2) {
      const body = renderInfixBody(childName, a.slice(1));
      return canElide(parentVerb, childName) ? body : `{${body}}`;
    }
  }
  return renderSweet(arg);
}

/** Drop a child infix's braces iff both are arithmetic and the child binds strictly tighter. Same- or
 *  lower-precedence (and any non-arithmetic pairing) keep braces — guarantees exact round-trip. */
function canElide(parent: string, child: string): boolean {
  const pp = FIXITY[parent]?.prec;
  const pc = FIXITY[child]?.prec;
  return pp !== undefined && pc !== undefined && pc > pp;
}
