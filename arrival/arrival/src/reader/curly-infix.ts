// curly-infix.ts — SRFI-105 curly-infix `{ … }` canonicalization, run at READ time.
//
// The reader (Parser.read_curly_elements) gathers the flat datum sequence between `{` and `}`;
// this module turns it into a canonical s-expr. `{a + b}` → `(+ a b)`, before the evaluator ever
// runs — so the evaluator, the value layer, the stored/canonical form, and the AI face never see
// `{}`. That is the SRFI-105 "pure reader transform" property, and it's why curly-infix offloads.
//
// DIVERGENCE FROM SRFI-105 (intentional, formal, predictable — V 2026-06-15): where SRFI-105 emits
// `($nfx$ …)` for mixed operators and leaves precedence to the app, we resolve the *arithmetic*
// operators here, at read-time, in plain TS (no `$nfx$` symbol is ever emitted, no Scheme macro is
// involved). Precedence is granted only where it is overlearned (PEMDAS); every other operator mix
// is an errors-as-door `ParseError`. See docs/working-proposals/arrival-sweet-extension-design-ideation-2026-06-15.md §5.2.

import type { SourceLocation } from "../errors.js";
import { ParseError } from "../errors.js";
import { Pair } from "../values/Pair.js";
import { SchemeSymbol } from "../values/SchemeSymbol.js";
import { nil, type SchemeValue } from "../values/types.js";

type Loc = SourceLocation | null | undefined;

interface Fixity {
  prec: number;
  assoc: "left";
}

/** The license table — the ONLY operators that get read-time precedence (the formal divergence).
 *  Multiplicative binds tighter than additive; both left-associative. Levels are relative; only the
 *  ordering matters (headroom left around them deliberately). Anything not here is a door. */
export const FIXITY: Record<string, Fixity> = {
  "*": { prec: 7, assoc: "left" },
  "/": { prec: 7, assoc: "left" },
  modulo: { prec: 7, assoc: "left" },
  quotient: { prec: 7, assoc: "left" },
  remainder: { prec: 7, assoc: "left" },
  "+": { prec: 6, assoc: "left" },
  "-": { prec: 6, assoc: "left" },
};

/** The operator name of a value, or null if it isn't a symbol. */
function opName(v: SchemeValue): string | null {
  if (v instanceof SchemeSymbol) {
    const n = v.__name__;
    return typeof n === "string" ? n : String(v.valueOf());
  }
  return null;
}

/** Binding power of a value as an infix operator, or -1 if it isn't a licensed operator. */
function prec(v: SchemeValue): number {
  const name = opName(v);
  return name !== null && name in FIXITY ? FIXITY[name].prec : -1;
}

function list(items: SchemeValue[]): SchemeValue {
  return Pair.fromArray(items, false) as SchemeValue;
}

/** SRFI-105 element classifier. `E` is the flat sequence read between `{` and `}`. */
export function canonicalizeCurly(E: SchemeValue[], loc?: Loc): SchemeValue {
  const n = E.length;
  if (n === 0) return nil; //                         {}      → ()
  if (n === 1) return E[0]; //                        {x}     → x   (escape, no wrap)
  if (n === 2) return list([E[0], E[1]]); //          {- x}   → (- x)  (unary/prefix; SRFI-105 rule)
  // n >= 3: a same-operator run is n-ary infix; everything else goes to the resolver.
  if (n % 2 === 1 && allSameOperator(E)) {
    const op = E[1];
    const operands = E.filter((_, i) => i % 2 === 0);
    return list([op, ...operands]); //                {a + b + c} → (+ a b c)
  }
  return resolveNfx(E, loc);
}

/** True iff every odd-index element is the same SchemeSymbol (a homogeneous infix run). */
function allSameOperator(E: SchemeValue[]): boolean {
  const op0 = E[1];
  if (!(op0 instanceof SchemeSymbol)) return false;
  for (let i = 1; i < E.length; i += 2) {
    const op = E[i];
    if (!(op instanceof SchemeSymbol) || !SchemeSymbol.is(op, op0)) return false;
  }
  return true;
}

/** Resolve a mixed-operator curly run using the arithmetic license table, or throw a teaching
 *  ParseError. NEVER emits `$nfx$`. */
export function resolveNfx(E: SchemeValue[], loc?: Loc): SchemeValue {
  const n = E.length;
  const at = loc ?? undefined;

  // --- structural / parity doors (checked before any climb) ---
  if (n % 2 === 0) {
    throw new ParseError(
      "malformed infix: even number of elements (missing operand or trailing operator)",
      at,
    );
  }
  for (let i = 1; i < n; i += 2) {
    const name = opName(E[i]);
    if (name === null) {
      throw new ParseError(
        "malformed infix: two operands are adjacent (expected an operator)",
        at,
      );
    }
    if (!(name in FIXITY)) {
      throw new ParseError(
        `ambiguous operator mix: '${name}' has no defined infix precedence here. ` +
          "Add explicit braces to disambiguate, e.g. {{a + b} < c}",
        at,
      );
    }
  }
  for (let i = 0; i < n; i += 2) {
    const name = opName(E[i]);
    if (name !== null && name in FIXITY) {
      throw new ParseError(
        `malformed infix: operator '${name}' where an operand was expected`,
        at,
      );
    }
  }

  // --- all operators licensed, parity valid: precedence-climb ---
  const [node, idx] = parseExpr(E, 0, 0);
  if (idx !== n) {
    throw new ParseError("malformed infix", at);
  }
  return node;
}

/** Precedence-climbing parse (left-assoc, n-ary runs per operator). Returns [node, nextIndex]. */
function parseExpr(E: SchemeValue[], start: number, minPrec: number): [SchemeValue, number] {
  const n = E.length;
  let lhs = E[start];
  let i = start + 1;
  while (i < n && prec(E[i]) >= minPrec) {
    const op = E[i] as SchemeSymbol;
    const opPrec = prec(op);
    const operands: SchemeValue[] = [lhs];
    // gather a maximal same-operator run at this precedence (left-assoc → n-ary node)
    while (i < n && E[i] instanceof SchemeSymbol && SchemeSymbol.is(E[i], op)) {
      i += 1; // consume the operator
      const [rhs, next] = parseExpr(E, i, opPrec + 1); // tighter operators bind first
      operands.push(rhs);
      i = next;
    }
    lhs = list([op, ...operands]);
    // a different operator at the same precedence re-enters the outer loop → left-assoc binary fold
  }
  return [lhs, i];
}
