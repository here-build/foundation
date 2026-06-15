/**
 * Bridge - connects the Operator/Profunctor system with the Scheme runtime.
 *
 * This module provides:
 * 1. Strict numeric coercion into the SchemeExact/SchemeInexact tower (`coerceNumeric`)
 * 2. Wrapped operators that work with boxed Scheme values
 * 3. Drop-in replacements for global_env numeric operations
 */

import foldCase from "fold-case";
import unicodeProperties from "unicode-properties";

import { AValue, unionProvenance } from "./AValue.js";
import { isBridgeInitialized, markBridgeInitialized } from "./boot.js";
import { BOOTSTRAP_SCHEME } from "./bootstrap.js";
import { HalfBaked, is_half_baked, type Interval } from "./HalfBaked.js";
import type { Environment } from "./Environment.js";
import { SchemeBool, schemeFalse, schemeTrue } from "./SchemeBool.js";
import { SchemeBytevector } from "./SchemeBytevector.js";
import { SchemeVector } from "./SchemeVector.js";
import {
  assertAllocatable,
  asBytevector,
  asVector,
  charValue,
  coerceNumeric,
  eqv,
  getAllocationLimit,
  isSchemeNumber,
  setAllocationLimit,
  stringValue,
  toIndex,
  withInputProvenance,
} from "./op-helpers.js";
import { global_env, env as userEnv, exec } from "./stdlib.js";
import { exec as generatorExec } from "./evaluator.js";
import { SchemeString } from "./SchemeString.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import type { Operator, Codec } from "./membrane.js";
import type { SchemeNumeric } from "./numbers.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import * as ops from "./operators/index.js";
// Import directly from source files to avoid circular dependency during init
import { isCircularList, Pair } from "./Pair.js";
import { collapseProvenance, taintString } from "./provenance-collapse.js";
import { structuralEqual } from "./structural-equal.js";
import { Nil, SchemeCharacter, nil, type SchemeValue } from "./types.js";
import { type } from "./utils/typecheck.js";
import { is_false, is_promise } from "./guards.js";
import { promise_all, unpromise } from "./utils/promises.js";
import { Values } from "./Values.js";
import invariant from "tiny-invariant";
import "./errors.js";
// Import global environment for initBridge - this is safe because bridge.ts
// doesn't get imported during lips.ts initialization

// The allocation cap, value-type coercions (charValue/stringValue/toIndex/
// asVector/asBytevector), eqv, coerceNumeric/isSchemeNumber, and the provenance
// stamp (withInputProvenance) now live in the leaf `op-helpers.ts` — shared with
// the value-domain cluster packs. Re-exported below for the external importers
// (evaluator, tests) that still reach for them via `bridge.js`.
export { coerceNumeric, getAllocationLimit, isSchemeNumber, setAllocationLimit };

// ============================================================================
// R7RS Error Types (Section 6.11)
// ============================================================================

/**
 * R7RS error object - represents errors created by the `error` procedure
 */
export class R7RSError extends Error {
  readonly irritants: unknown[];
  readonly name: string = "R7RSError";

  constructor(message: string, ...irritants: unknown[]) {
    super(message);
    this.irritants = irritants;
  }
}

/**
 * R7RS read error - represents errors during reading/parsing
 */
export class R7RSReadError extends R7RSError {
  readonly name = "R7RSReadError";
}

/**
 * R7RS file error - represents file I/O errors
 */
export class R7RSFileError extends R7RSError {
  readonly name = "R7RSFileError";
}

/**
 * Raised exception wrapper - used to carry non-Error exceptions through JS try/catch
 */
export class RaisedException extends Error {
  readonly name = "RaisedException";

  constructor(
    public readonly value: unknown,
    public readonly continuable: boolean = false,
  ) {
    super(value instanceof Error ? value.message : String(value));
  }
}

/**
 * Coerce a value to a SchemeNumeric (SchemeExact / SchemeInexact).
 *
 * STRICT: only bigints, JS numbers, existing SchemeNumerics, and objects whose
 * `valueOf()` yields one of those convert. Anything else — notably strings —
 * throws. This rejection is load-bearing: `(* 0 "")` must fail rather than
 * silently coerce the string, so numeric builtins surface a type error instead
 * of producing a nonsense result. (Contrast `parseNumber`, which PARSES numeric
 * literal strings — a different job.)
 */
/**
 * Wrap an Operator to work with LIPS values.
 * Returns a function that converts args from LIPS, calls the operator, and converts result back.
 *
 * Provenance flows through every builtin routed here. Concretely: when downstream
 * Scheme like `(if (< (length cls) 3) ...)` branches, the boolean produced by `<`
 * must remember it was derived from `cls` so the consumer can attribute behavior
 * back to that source. Comparison/arithmetic results are produced by `op.call`,
 * which has no knowledge of the input AValues — stamping has to happen at this
 * boundary or it would have to be added (and could be forgotten) in ~50 operator
 * sites. Doing it once here covers `+ - * /`, the six comparisons, gcd/lcm,
 * sqrt/log/trig, bitwise, and the dozens of r7rs entries under wrappedOps.
 *
 * Empty-provenance short-circuit: most call sites are parser-produced literals
 * (`(+ 1 2)`) where neither argument carries any source ids. The union is empty,
 * `withProvenance` would just clone, and the clone is observationally identical —
 * skip the allocation. The `instanceof AValue` guard on `result` also covers
 * operators whose `op.call` returns raw JS (no provenance surface to stamp).
 *
 * Comparison-op bool boxing: operators declared with `out: Bool` (numEq/lt/gt/
 * lte/gte, zero?/positive?/negative?/odd?/even?, finite?/infinite?/nan?, the
 * type predicates) produce raw JS `true|false` via `Bool.fromJS = v => v`
 * (membrane.ts:456-462). Without the boxing branch below, `(if (< x 5) ...)`
 * loses lineage at `restrictControlFlowProvenance` (evaluator.ts:629 —
 * `predicate instanceof AValue === false`), because most real `if`/`cond`
 * predicates ARE comparisons. We only box when provenance is non-empty: with
 * empty provenance, the boxed singletons would survive into call sites that
 * still rely on raw `=== false` / `!== false` checks (the same landmine
 * `withInputProvenance` in lips.ts:2042-2054 calls out as sealed).
 */
export function wrapOperator<In extends any[], InRest extends Codec<any, any> | undefined, Out extends Codec<any, any>>(
  op: Operator<In, InRest, Out>,
): (...args: unknown[]) => unknown {
  // Why stamp coerceNumeric failures HERE: a type error from coercion (e.g. a
  // string passed to `*`) travels up through several catch paths that swallow or
  // rewrap it, and a downstream `env.get(first)` retry leaves only the outer
  // form's name on the message — so the symptom mis-presents as an unbound-symbol
  // lookup failure on an unrelated operator. This boundary is the only frame that
  // holds both pieces needed to name the real cause (op.name here, type() on the
  // args). The original TypeError rides along via `cause` so the membrane stack
  // still traces the converter's invariant. We don't catch op.call itself —
  // operator-internal failures already carry `op.name` (see membrane.ts).
  //
  // The synchronous numeric core: convert args, apply the operator, stamp
  // provenance. Factored out so the speculative path can run it either eagerly
  // or after forcing a HalfBaked carrier.
  const applyNumeric = (callArgs: unknown[]): unknown => {
    const provenance = unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue));
    let converted: SchemeNumeric[];
    try {
      converted = callArgs.map(coerceNumeric);
    } catch (cause) {
      // Find the first non-numeric arg so the error names what actually failed,
      // not just "some arg." Mirror isSchemeNumber's contract — anything it
      // rejects is what coerceNumeric would have thrown on.
      const badIndex = callArgs.findIndex((a) => !isSchemeNumber(a));
      const typeNames = callArgs.map(type).join(", ");
      const detail = badIndex >= 0
        ? `argument ${badIndex} is ${type(callArgs[badIndex])}`
        : "argument type mismatch";
      throw new TypeError(
        `Cannot apply ${op.name} to (${typeNames}): ${detail}`,
        { cause },
      );
    }
    const result: unknown = op.call(converted);
    if (provenance.size > 0) {
      if (result instanceof AValue) return result.withProvenance(provenance);
      // Box JS bool coming out of comparison/predicate operators (Bool codec).
      // Empty-provenance path returns raw bool to keep find/`!== false` callers alive.
      if (typeof result === "boolean") {
        return (result ? schemeTrue : schemeFalse).withProvenance(provenance);
      }
    }
    return result;
  };

  // Use Object.defineProperty to set the name from operator
  const fn = function (...args: unknown[]): unknown {
    // ── Tier 2 speculative evaluation ──────────────────────────────────────
    // A `HalfBaked` reaches this wrapper ONLY for the comparison ops marked
    // `__speculate__` below (the dispatch choke forces it for every other
    // numeric op). For a comparison against a still-filling cardinality
    // interval we can often decide the result EARLY — that early-decision
    // promise is what collapses the enclosing `if`. If we can't decide here
    // (both operands HalfBaked, undecidable interval at call time, etc.), we
    // force the carrier(s) and run the normal numeric path — never wrong,
    // just not early. `args.some(is_half_baked)` is only ever true here.
    if (args.some(is_half_baked)) {
      const decided = SPECULATIVE_OPS.has(op.name) ? speculativeCompare(op.name, args) : undefined;
      if (decided !== undefined) return decided;
      return Promise.all(
        args.map((a) => (is_half_baked(a) ? a.force() : a)),
      ).then(applyNumeric);
    }
    return applyNumeric(args);
  };
  // Mark the comparison ops so the dispatch choke leaves their HalfBaked args
  // unforced — this wrapper reads the interval instead of a settled value.
  if (SPECULATIVE_OPS.has(op.name)) {
    (fn as { __speculate__?: boolean }).__speculate__ = true;
  }
  Object.defineProperty(fn, "name", { value: op.name });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Tier 2 speculative comparison against a HalfBaked cardinality interval.
// See docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md.
// ════════════════════════════════════════════════════════════════════════════

/** The comparison ops that can decide early against a narrowing interval. */
const SPECULATIVE_OPS = new Set(["=", "<", ">", "<=", ">="]);

/** `(op k hb)` ⟺ `(reflect[op] hb k)` — used to normalize the HalfBaked to the left. */
const REFLECT: Record<string, string> = { ">=": "<=", "<=": ">=", ">": "<", "<": ">", "=": "=" };

/**
 * The early-decision verdict for `(op interval k)`: returns a definite boolean
 * the instant the interval is decisive, or `undefined` to keep waiting. Sound by
 * construction — every branch only fires when the interval ENTIRELY lies on one
 * side of `k`, so the answer cannot change as the interval narrows further.
 */
function verdictFor(op: string, k: number): ((iv: Interval) => boolean | undefined) | undefined {
  switch (op) {
    case ">=":
      return (iv) => (iv.lo >= k ? true : iv.hi < k ? false : undefined);
    case ">":
      return (iv) => (iv.lo > k ? true : iv.hi <= k ? false : undefined);
    case "<=":
      return (iv) => (iv.hi <= k ? true : iv.lo > k ? false : undefined);
    case "<":
      return (iv) => (iv.hi < k ? true : iv.lo >= k ? false : undefined);
    case "=":
      return (iv) => (iv.lo === iv.hi && iv.lo === k ? true : iv.hi < k || iv.lo > k ? false : undefined);
    default:
      return undefined;
  }
}

/** Best-effort numeric extraction of the concrete operand; undefined ⇒ can't speculate. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof AValue && typeof (v as { valueOf?: () => unknown }).valueOf === "function") {
    const n = Number((v as { valueOf: () => unknown }).valueOf());
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Try to decide a binary comparison where exactly one operand is a number-domain
 * `HalfBaked` (a narrowing cardinality interval) and the other is a concrete
 * number. Returns an early-decision `Promise<boolean>` (provenance-stamped to
 * match the eager path), or `undefined` when speculation doesn't apply — caller
 * then forces and runs normally.
 */
function speculativeCompare(name: string, args: unknown[]): unknown | undefined {
  if (args.length !== 2) return undefined;
  const [a, b] = args;
  const aHB = is_half_baked(a);
  const bHB = is_half_baked(b);
  if (aHB === bHB) return undefined; // need exactly one HalfBaked operand
  const hb = (aHB ? a : b) as HalfBaked;
  const k = toNumber(aHB ? b : a);
  if (k === undefined) return undefined;
  // Normalize so the interval is on the left of the operator.
  const verdict = verdictFor(aHB ? name : REFLECT[name], k);
  if (!verdict) return undefined;
  const provenance = unionProvenance(args.filter((x): x is AValue => x instanceof AValue));
  return hb.decide(verdict).then((bool) =>
    provenance.size > 0 ? (bool ? schemeTrue : schemeFalse).withProvenance(provenance) : bool,
  );
}

/**
 * Create a type predicate that doesn't throw on non-numbers
 */
function makeTypePredicate(name: string, predicate: (n: SchemeNumeric) => boolean): unknown {
  const fn = (value: unknown): boolean => {
    if (!isSchemeNumber(value)) {
      return false;
    }
    try {
      const converted = coerceNumeric(value);
      return predicate(converted);
    } catch {
      return false;
    }
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

// Fantasy Land Ord: the comparison operators consult `fantasy-land/lte` when their operands
// are ordered ENTITIES (a DateTime, a Version, …), exactly as equal? consults a Setoid's
// `fantasy-land/equals`. All four relations derive from the single `lte`; a chain (< a b c)
// holds iff each adjacent pair does. Numeric operands take the original numeric/speculative
// path unchanged — the FL check is one inexpensive property read, false for every number.
interface FLOrd {
  "fantasy-land/lte"(other: unknown): boolean;
}
const isOrd = (x: unknown): x is FLOrd =>
  x != null && typeof (x as Partial<FLOrd>)["fantasy-land/lte"] === "function";
const flLte = (a: FLOrd, b: unknown): boolean => Boolean(a["fantasy-land/lte"](b));
// The four relations of a total order, all derived from the single `lte`.
const ORD_REL: Record<"<" | ">" | "<=" | ">=", (a: FLOrd, b: FLOrd) => boolean> = {
  "<": (a, b) => !flLte(b, a),
  ">": (a, b) => !flLte(a, b),
  "<=": (a, b) => flLte(a, b),
  ">=": (a, b) => flLte(b, a),
};
// n-ary ordered comparison derived purely from the operands' `fantasy-land/lte`
// (wave-1 Ord). The per-type order lives in the entity's instance, so the
// string<? / char<? families are now type-agnostic chains over it — adding a new
// ordered type needs no new comparison builtin.
function deriveOrd(sym: "<" | ">" | "<=" | ">="): (...args: unknown[]) => boolean {
  const rel = ORD_REL[sym];
  return (...args: unknown[]): boolean => {
    for (let i = 0; i < args.length - 1; i++) {
      if (!rel(args[i] as FLOrd, args[i + 1] as FLOrd)) return false;
    }
    return true;
  };
}
function wrapOrd(numeric: (...a: unknown[]) => unknown, sym: "<" | ">" | "<=" | ">="): (...a: unknown[]) => unknown {
  const rel = ORD_REL[sym];
  const fn = (...args: unknown[]): unknown => {
    // FL-Ord only intercepts ENTITY operands; numeric/HalfBaked args take the wrapped
    // numeric op untouched, so its speculative early-collapse path is preserved.
    if (args.length >= 2 && args.some(isOrd)) {
      for (let i = 0; i < args.length - 1; i++) {
        const a = args[i];
        const b = args[i + 1];
        if (!isOrd(a) || !isOrd(b)) return numeric(...args); // mixed → numeric path's clear error
        if (!rel(a, b)) return schemeFalse;
      }
      return schemeTrue;
    }
    return numeric(...args);
  };
  // Preserve the speculation marker + operator name from the wrapped op so the evaluator's
  // speculative-eval path still engages (it forces HalfBaked args unless __speculate__ is set,
  // and keys early-collapse on op.name).
  (fn as { __speculate__?: boolean }).__speculate__ = (numeric as { __speculate__?: boolean }).__speculate__;
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

export const wrappedOps = {
  "+": wrapOperator(ops.add),
  "-": wrapOperator(ops.sub),
  "*": wrapOperator(ops.mul),
  "/": wrapOperator(ops.div),
  quotient: wrapOperator(ops.quotient),
  remainder: wrapOperator(ops.remainder),
  modulo: wrapOperator(ops.modulo),
  "floor-quotient": wrapOperator(ops.floorQuotient),
  "floor-remainder": wrapOperator(ops.floorRemainder),
  "truncate-quotient": wrapOperator(ops.truncateQuotient),
  "truncate-remainder": wrapOperator(ops.truncateRemainder),

  "floor/"(n1: unknown, n2: unknown): unknown {
    const a = coerceNumeric(n1);
    const b = coerceNumeric(n2);
    const aExact = a instanceof SchemeExact ? a : new SchemeExact(BigInt(Math.trunc(a.real)));
    const bExact = b instanceof SchemeExact ? b : new SchemeExact(BigInt(Math.trunc(b.real)));
    const q = ops.floorQuotient.call([aExact, bExact]);
    const r = ops.floorRemainder.call([aExact, bExact]);
    const qNum = q instanceof SchemeExact ? q : new SchemeExact(q as unknown as bigint);
    const rNum = r instanceof SchemeExact ? r : new SchemeExact(r as unknown as bigint);
    return Values.from([qNum, rNum]);
  },

  "truncate/"(n1: unknown, n2: unknown): unknown {
    const a = coerceNumeric(n1);
    const b = coerceNumeric(n2);
    const aExact = a instanceof SchemeExact ? a : new SchemeExact(BigInt(Math.trunc(a.real)));
    const bExact = b instanceof SchemeExact ? b : new SchemeExact(BigInt(Math.trunc(b.real)));
    const q = ops.truncateQuotient.call([aExact, bExact]);
    const r = ops.truncateRemainder.call([aExact, bExact]);
    const qNum = q instanceof SchemeExact ? q : new SchemeExact(q as unknown as bigint);
    const rNum = r instanceof SchemeExact ? r : new SchemeExact(r as unknown as bigint);
    return Values.from([qNum, rNum]);
  },

  numerator: wrapOperator(ops.numerator),
  denominator: wrapOperator(ops.denominator),
  "make-rectangular": wrapOperator(ops.makeRectangular),
  "make-polar": wrapOperator(ops.makePolar),
  "real-part": wrapOperator(ops.realPart),
  "imag-part": wrapOperator(ops.imagPart),
  magnitude: wrapOperator(ops.magnitude),
  angle: wrapOperator(ops.angle),
  abs: wrapOperator(ops.abs),
  gcd: wrapOperator(ops.gcd),

  lcm(...args: unknown[]): SchemeNumeric {
    if (args.length === 0) return new SchemeExact(1n);
    let hasInexact = false;
    const exactArgs: SchemeExact[] = [];
    for (const arg of args) {
      const n = coerceNumeric(arg);
      if (n instanceof SchemeInexact) {
        hasInexact = true;
        exactArgs.push(new SchemeExact(BigInt(Math.trunc(n.real))));
      } else {
        exactArgs.push(new SchemeExact(n.num / n.denom));
      }
    }
    const result = ops.lcm.call(exactArgs);
    const resultBigint = result instanceof SchemeExact ? result.num : (result as bigint);
    return hasInexact ? new SchemeInexact(Number(resultBigint)) : new SchemeExact(resultBigint);
  },

  expt: wrapOperator(ops.expt),
  "=": wrapOperator(ops.numEq),
  "<": wrapOrd(wrapOperator(ops.lt), "<"),
  ">": wrapOrd(wrapOperator(ops.gt), ">"),
  "<=": wrapOrd(wrapOperator(ops.lte), "<="),
  ">=": wrapOrd(wrapOperator(ops.gte), ">="),
  max: wrapOperator(ops.max),
  min: wrapOperator(ops.min),
  "zero?": wrapOperator(ops.isZero),
  "positive?": wrapOperator(ops.isPositive),
  "negative?": wrapOperator(ops.isNegative),
  "odd?": wrapOperator(ops.isOdd),
  "even?": wrapOperator(ops.isEven),
  floor: wrapOperator(ops.floor),
  ceiling: wrapOperator(ops.ceiling),
  truncate: wrapOperator(ops.truncate),
  round: wrapOperator(ops.round),
  sqrt: wrapOperator(ops.sqrt),
  exp: wrapOperator(ops.exp),
  log: wrapOperator(ops.log),
  sin: wrapOperator(ops.sin),
  cos: wrapOperator(ops.cos),
  tan: wrapOperator(ops.tan),
  asin: wrapOperator(ops.asin),
  acos: wrapOperator(ops.acos),
  atan: wrapOperator(ops.atan),
  "bitwise-and": wrapOperator(ops.bitwiseAnd),
  "bitwise-ior": wrapOperator(ops.bitwiseIor),
  "bitwise-xor": wrapOperator(ops.bitwiseXor),
  "bitwise-not": wrapOperator(ops.bitwiseNot),
  "arithmetic-shift": wrapOperator(ops.arithmeticShift),

  // R7RS Type predicates
  "number?"(value: unknown): boolean {
    return isSchemeNumber(value);
  },

  "complex?": makeTypePredicate("complex?", (n) => n.isComplex),
  "real?": makeTypePredicate("real?", (n) => n.isReal),
  "rational?": makeTypePredicate("rational?", (n) => n.isRational),
  "integer?": makeTypePredicate("integer?", (n) => n.isInteger),
  "exact?": makeTypePredicate("exact?", (n) => n.isExact),
  "inexact?": makeTypePredicate("inexact?", (n) => !n.isExact),
  "exact-integer?": makeTypePredicate("exact-integer?", (n) => n.isExact && n.isInteger),
  "finite?": makeTypePredicate("finite?", (n) => n.isFinite),
  "infinite?": makeTypePredicate("infinite?", (n) => !n.isFinite && !n.isNaN),
  "nan?": makeTypePredicate("nan?", (n) => n.isNaN),

  // ============================================================================
  // LIPS-style aliases (for backwards compatibility with global_env)
  // ============================================================================

  "**": wrapOperator(ops.expt),

  "1+"(n: unknown): SchemeNumeric {
    const converted = coerceNumeric(n);
    const one = new SchemeExact(1n);
    return ops.add.call([converted, one]);
  },

  "1-"(n: unknown): SchemeNumeric {
    const converted = coerceNumeric(n);
    const one = new SchemeExact(1n);
    return ops.sub.call([converted, one]);
  },

  "%": wrapOperator(ops.remainder),
  "==": wrapOperator(ops.numEq),
  "|": wrapOperator(ops.bitwiseIor),
  "&": wrapOperator(ops.bitwiseAnd),
  "~": wrapOperator(ops.bitwiseNot),

  ">>"(a: unknown, b: unknown): SchemeNumeric {
    const aNum = coerceNumeric(a);
    const bNum = coerceNumeric(b);
    return ops.arithmeticShift.call([aNum, bNum]);
  },

  "<<"(a: unknown, b: unknown): SchemeNumeric {
    const aNum = coerceNumeric(a);
    const bNum = coerceNumeric(b);
    const negB = ops.sub.call([bNum]);
    return ops.arithmeticShift.call([aNum, negB]);
  },

  // R7RS exactness conversion
  inexact(z: unknown): SchemeInexact {
    const n = coerceNumeric(z);
    if (n instanceof SchemeInexact) return n;
    const exact = n;
    if (exact.denom === 1n) return new SchemeInexact(Number(exact.num));
    return new SchemeInexact(Number(exact.num) / Number(exact.denom));
  },

  exact(z: unknown): SchemeExact {
    const n = coerceNumeric(z);
    if (n instanceof SchemeExact) return n;
    const inexact = n;
    invariant(inexact.imag === 0, "Cannot convert complex number with non-zero imaginary part to exact");
    const real = inexact.real;
    TypeError.invariant(Number.isFinite(real), "Cannot convert infinity or NaN to exact");
    if (Number.isInteger(real)) return new SchemeExact(BigInt(real));
    // JS Number.toString picks between fixed (`0.5`) and exponential (`1e-10`,
    // `1e+21`) notations based on magnitude. The fixed-notation path uses the
    // decimal-place count to derive the denominator. The exponential path was
    // unhandled — `indexOf(".") === -1` short-circuited to `BigInt(real)` and
    // threw RangeError on the non-integer float. Parse the mantissa+exponent
    // and combine into a single power-of-10 denominator.
    const str = real.toString();
    const expMatch = str.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    if (expMatch) {
      const [, sign, intPart, fracPart = "", expStr] = expMatch;
      const exp = Number(expStr);
      // Combine: value = sign * (intPart.fracPart) * 10^exp
      //                = sign * (intPart fracPart) * 10^(exp - fracPart.length)
      const digits = intPart + fracPart;
      const netExp = exp - fracPart.length;
      const mantissa = BigInt(`${sign}${digits}`);
      const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
      if (netExp >= 0) {
        return new SchemeExact(mantissa * 10n ** BigInt(netExp));
      }
      const denomBig = 10n ** BigInt(-netExp);
      const absNum = mantissa < 0n ? -mantissa : mantissa;
      const g = gcd(absNum, denomBig);
      return new SchemeExact(mantissa / g, denomBig / g);
    }
    const decimalIndex = str.indexOf(".");
    if (decimalIndex === -1) return new SchemeExact(BigInt(real));
    const decimals = str.length - decimalIndex - 1;
    const scale = 10n ** BigInt(decimals);
    const num = BigInt(Math.round(real * Number(scale)));
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    const g = gcd(num < 0n ? -num : num, scale);
    return new SchemeExact(num / g, scale / g);
  },

  "number->string"(z: unknown, radix?: unknown): string {
    const n = coerceNumeric(z);
    const base = radix === undefined ? 10 : Number(coerceNumeric(radix).valueOf());
    if (n instanceof SchemeExact) {
      if (n.denom === 1n) return n.num.toString(base);
      return `${n.num.toString(base)}/${n.denom.toString(base)}`;
    }
    const inexact = n;
    // Inexact mark preservation (R7RS § 6.2): `(number->string 5.0)` must NOT
    // return "5" — round-tripping through `string->number` would yield an
    // exact integer, violating the exactness contract. `SchemeInexact.toString()`
    // already appends `.0` to integers and emits the chibi-compatible
    // `+inf.0` / `+nan.0` markers. Delegate for base-10 (the only base R7RS
    // actually specifies for inexact formatting); for non-decimal bases the
    // JS Number formatter is the only realistic option.
    if (base === 10) {
      return inexact.toString();
    }
    if (inexact.imag !== 0) {
      const realPart = inexact.real.toString(base);
      const imagPart = inexact.imag >= 0 ? `+${inexact.imag.toString(base)}i` : `${inexact.imag.toString(base)}i`;
      return realPart + imagPart;
    }
    return inexact.real.toString(base);
  },

  // ============================================================================
  // R7RS Character Operations (Section 6.6)
  // ============================================================================

  "char?"(obj: unknown): boolean {
    return obj instanceof SchemeCharacter;
  },

  "char=?"(...chars: unknown[]): boolean {
    if (chars.length < 2) return true;
    const first = charValue(chars[0]);
    return chars.slice(1).every((c) => charValue(c) === first);
  },

  // char</>/<=/>= derive from SchemeCharacter's fantasy-land/lte (wave-1 Ord) via
  // the shared deriveOrd chain — see ORD_REL above.
  "char<?": deriveOrd("<"),
  "char>?": deriveOrd(">"),
  "char<=?": deriveOrd("<="),
  "char>=?": deriveOrd(">="),

  // Case-insensitive comparisons
  "char-ci=?"(...chars: unknown[]): boolean {
    if (chars.length < 2) return true;
    const first = charValue(chars[0]).toLowerCase();
    return chars.slice(1).every((c) => charValue(c).toLowerCase() === first);
  },

  "char-ci<?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]).toLowerCase() >= charValue(chars[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "char-ci>?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]).toLowerCase() <= charValue(chars[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "char-ci<=?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]).toLowerCase() > charValue(chars[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "char-ci>=?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]).toLowerCase() < charValue(chars[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  // Character classification
  // R7RS § 6.6: each predicate returns #t iff the character's Unicode general
  // category falls in the expected set. The previous round-trip-case heuristic
  // (`lower !== upper`) misses every category-Lo script (CJK, Hangul, Hebrew,
  // Arabic, …) because Lo has no case mapping → lower === upper → predicate
  // returns #f. `unicodeProperties.getCategory(codepoint)` is the source of
  // truth.
  "char-alphabetic?"(char: unknown): boolean {
    const cp = charValue(char).codePointAt(0)!;
    // Letter categories: Lu (upper), Ll (lower), Lt (title), Lm (modifier), Lo (other).
    switch (unicodeProperties.getCategory(cp)) {
      case "Lu":
      case "Ll":
      case "Lt":
      case "Lm":
      case "Lo":
        return true;
      default:
        return false;
    }
  },

  "char-numeric?"(char: unknown): boolean {
    const cp = charValue(char).codePointAt(0)!;
    // Number categories: Nd (decimal digit), Nl (letter number), No (other).
    // The previous `isDigit` only matched Nd — CJK numerals (Nl) and Roman
    // numerals (Nl) were misclassified.
    switch (unicodeProperties.getCategory(cp)) {
      case "Nd":
      case "Nl":
      case "No":
        return true;
      default:
        return false;
    }
  },

  "char-whitespace?"(char: unknown): boolean {
    // JS \s ≈ Unicode White_Space property — covers ASCII tab/LF/CR/space
    // plus the Z* categories (Zs/Zl/Zp) plus a few format chars. Closer to
    // R7RS than getCategory alone (which would miss tab/LF as Cc).
    return /^\s$/.test(charValue(char));
  },

  "char-upper-case?"(char: unknown): boolean {
    const cp = charValue(char).codePointAt(0)!;
    return unicodeProperties.getCategory(cp) === "Lu";
  },

  "char-lower-case?"(char: unknown): boolean {
    const cp = charValue(char).codePointAt(0)!;
    return unicodeProperties.getCategory(cp) === "Ll";
  },

  "digit-value"(char: unknown): number | false {
    const c = charValue(char);
    const codePoint = c.codePointAt(0)!;
    if (!unicodeProperties.isDigit(codePoint)) return false;
    const numericValue = unicodeProperties.getNumericValue(codePoint);
    return numericValue === null ? false : numericValue;
  },

  // Case conversion
  "char-upcase"(char: unknown): SchemeCharacter {
    return new SchemeCharacter(charValue(char).toUpperCase());
  },

  "char-downcase"(char: unknown): SchemeCharacter {
    return new SchemeCharacter(charValue(char).toLowerCase());
  },

  "char-foldcase"(char: unknown): SchemeCharacter {
    const c = charValue(char);
    const folded = foldCase(c);
    // R7RS § 6.6: char-foldcase returns a character (single Unicode scalar).
    // When fold would expand to MULTIPLE chars (Eszett ß → "ss", Greek final
    // sigma, etc.), there is no single-char result, so the operation MUST
    // return the input unchanged. Truncating to `folded[0]` produces a
    // different character (ß → s) which violates the round-trip identity.
    return [...folded].length === 1 ? new SchemeCharacter(folded) : char as SchemeCharacter;
  },

  // Character/integer conversion
  // R7RS § 6.6: return the Unicode SCALAR (code point), not the UTF-16 code unit.
  // `charCodeAt(0)` is wrong for non-BMP chars (e.g. emoji): it returns the high
  // surrogate (e.g. 0xD83D for 😀) instead of the full code point (0x1F600).
  // `codePointAt(0)` reads a full surrogate pair when present.
  "char->integer"(char: unknown): SchemeExact {
    return new SchemeExact(BigInt(charValue(char).codePointAt(0)!));
  },

  // R7RS § 6.6: inverse of char->integer over Unicode scalar range.
  // `fromCharCode` silently truncates above 0xFFFF (modulo 0x10000), corrupting
  // any non-BMP code point. `fromCodePoint` accepts up to U+10FFFF and emits
  // the correct surrogate pair. Surrogate code points themselves (D800..DFFF)
  // are NOT Unicode scalars per the standard; reject explicitly.
  "integer->char"(n: unknown): SchemeCharacter {
    const num = coerceNumeric(n);
    const code = num instanceof SchemeExact ? Number(num.num) : Math.floor(num.real);
    invariant(code >= 0 && code <= 0x10ffff, `integer->char: code point ${code} out of Unicode range`);
    invariant(code < 0xd800 || code > 0xdfff, `integer->char: surrogate code point ${code.toString(16)} is not a Unicode scalar`);
    return new SchemeCharacter(String.fromCodePoint(code));
  },

  // ============================================================================
  // R7RS String Operations (Section 6.7)
  // ============================================================================

  "make-string"(k: unknown, char?: unknown): SchemeString {
    const len = Number(coerceNumeric(k).valueOf());
    // O(1) cap check BEFORE `.repeat(len)` allocates — see assertAllocatable.
    assertAllocatable(len, "make-string");
    const c = char ? charValue(char) : "\u0000";
    // Both the length and (when present) the filling char contribute lineage —
    // `(make-string n user-char)` should remember user-char as a source even
    // though the length is what dictates the result's size.
    return withInputProvenance(
      char === undefined ? [k] : [k, char],
      new SchemeString(c.repeat(len)),
    );
  },

  string(...chars: unknown[]): SchemeString {
    // Union of every character argument — same shape as `vector` below.
    return withInputProvenance(chars, new SchemeString(chars.map(charValue).join("")));
  },

  "string-length"(str: unknown): SchemeExact {
    return new SchemeExact(BigInt([...stringValue(str)].length));
  },

  "string-ref"(str: unknown, k: unknown): SchemeCharacter {
    const idx = Number(coerceNumeric(k).valueOf());
    return new SchemeCharacter([...stringValue(str)][idx]);
  },

  // string-set! / string-fill! — OMITTED by the purity invariant (frozen
  // entities); doored in bootstrap.ts. See plan-2026-06-11-purity-pass.

  // String comparison
  "string=?"(...strs: unknown[]): boolean {
    if (strs.length < 2) return true;
    const first = stringValue(strs[0]);
    return strs.slice(1).every((s) => stringValue(s) === first);
  },

  // string</>/<=/>= derive from SchemeString's fantasy-land/lte (wave-1 Ord) via
  // the shared deriveOrd chain — same adapter as the char family.
  "string<?": deriveOrd("<"),
  "string>?": deriveOrd(">"),
  "string<=?": deriveOrd("<="),
  "string>=?": deriveOrd(">="),

  // Case-insensitive string comparison
  "string-ci=?"(...strs: unknown[]): boolean {
    if (strs.length < 2) return true;
    const first = stringValue(strs[0]).toLowerCase();
    return strs.slice(1).every((s) => stringValue(s).toLowerCase() === first);
  },

  "string-ci<?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() >= stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci>?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() <= stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci<=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() > stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci>=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() < stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-append"(...strs: unknown[]): string | SchemeString {
    // Collapsing op: the result inherits lineage from every input — and DEEP, so a
    // nested structure (a list/vector/array of inference-stamped values) is hoisted,
    // not just the top-level AValue args. Without this, `(string-append prefix
    // (join "" parts))` forgets where `parts` came from. See provenance-collapse.ts.
    return taintString(strs.map(stringValue).join(""), collapseProvenance(...strs));
  },

  "string->list"(str: unknown, start?: unknown, end?: unknown): unknown {
    const chars = [...stringValue(str)];
    const startIdx = start === undefined ? 0 : toIndex(start);
    const endIdx = end === undefined ? chars.length : toIndex(end);
    let result: unknown = nil;
    for (let i = endIdx - 1; i >= startIdx; i--) result = new Pair(new SchemeCharacter(chars[i]), result);
    return result;
  },

  "list->string"(list: unknown): SchemeString {
    const chars: string[] = [];
    let current = list;
    while (current && current !== nil && current instanceof Pair) {
      chars.push(charValue(current.car));
      current = current.cdr;
    }
    return new SchemeString(chars.join(""));
  },

  "string-copy"(str: unknown, start?: unknown, end?: unknown): SchemeString {
    const chars = [...stringValue(str)];
    const startIdx = start === undefined ? 0 : toIndex(start);
    const endIdx = end === undefined ? chars.length : toIndex(end);
    // The copy is a fresh allocation but semantically the same lineage as `str`
    // (start/end indices don't carry meaning here, they shape the slice).
    return withInputProvenance([str], new SchemeString(chars.slice(startIdx, endIdx).join("")));
  },

  // string-copy! — OMITTED by the purity invariant (mutates its destination);
  // doored in bootstrap.ts. The non-mutating `string-copy` stays.

  // Case conversion for strings — case is a presentation transform, not a
  // new origin; inherit the source's lineage so downstream `define` of the
  // result still traces to the original infer/query call.
  "string-upcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(stringValue(str).toUpperCase()));
  },

  "string-downcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(stringValue(str).toLowerCase()));
  },

  "string-foldcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(foldCase(stringValue(str))));
  },

  // ============================================================================
  // R7RS Exception Handling (Section 6.11)
  // ============================================================================

  "error-object?"(obj: unknown): boolean {
    return obj instanceof R7RSError;
  },

  "error-object-message"(err: unknown): string {
    // R7RS § 6.11: `error-object-message` is only defined over error objects
    // (values produced by the `error` procedure). The previous permissive
    // implementation returned `err.message` for any JS `Error` and stringified
    // anything else — meaning callers couldn't distinguish "real R7RS error"
    // from "some other thrown value happened to expose a message field."
    // Fail loudly instead.
    TypeError.invariant(err instanceof R7RSError, "error-object-message: argument is not an error object");
    return err.message;
  },

  "error-object-irritants"(err: unknown): unknown {
    if (err instanceof R7RSError) {
      // Convert JS array to Scheme list
      let result: unknown = nil;
      for (let i = err.irritants.length - 1; i >= 0; i--) {
        result = new Pair(err.irritants[i], result);
      }
      return result;
    }
    return nil;
  },

  "read-error?"(obj: unknown): boolean {
    return obj instanceof R7RSReadError;
  },

  "file-error?"(obj: unknown): boolean {
    return obj instanceof R7RSFileError;
  },

  "make-error-object"(message: unknown, ...irritants: unknown[]): R7RSError {
    const msg = message instanceof SchemeString ? message.valueOf() : String(message);
    return new R7RSError(msg, ...irritants);
  },

  "raise-exception"(obj: unknown): never {
    throw new RaisedException(obj, false);
  },

  "raise-continuable-exception"(obj: unknown): never {
    throw new RaisedException(obj, true);
  },

  "raised-exception?"(obj: unknown): boolean {
    return obj instanceof RaisedException;
  },

  "raised-exception-value"(exc: unknown): unknown {
    if (exc instanceof RaisedException) {
      return exc.value;
    }
    return exc;
  },

  "raised-exception-continuable?"(exc: unknown): boolean {
    if (exc instanceof RaisedException) {
      return exc.continuable;
    }
    return false;
  },

  // Throw the object directly (not wrapped in Error with toString)
  // This preserves the original object type for R7RS exception handling
  "%raise"(obj: unknown): never {
    throw obj;
  },

  // R7RS 6.3 Booleans
  "boolean=?"(...bools: unknown[]): boolean {
    if (bools.length < 2) return true;
    // L1 boxes `#t` / `#f` as SchemeBool — unwrap before comparing, otherwise
    // `(boolean=? #t #t)` would compare two distinct singletons and pass, but
    // the type-guard one line up would already have rejected the schemeTrue
    // singleton as `typeof !== "boolean"`. Mirror `boolean?`'s post-L1 fix.
    const unwrap = (b: unknown): boolean | undefined => {
      if (typeof b === "boolean") return b;
      if (b instanceof SchemeBool) return b.value;
      return undefined;
    };
    const first = unwrap(bools[0]);
    if (first === undefined) return false;
    return bools.every((b) => unwrap(b) === first);
  },

  // R7RS 6.5 Symbols
  "symbol=?"(...syms: unknown[]): boolean {
    if (syms.length < 2) return true;
    const first = syms[0];
    if (!(first instanceof SchemeSymbol)) return false;
    const firstName = first.__name__;
    return syms.every((s) => s instanceof SchemeSymbol && s.__name__ === firstName);
  },

  // R7RS 6.4 Pairs and lists
  "make-list"(k: unknown, fill?: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    const value = fill === undefined ? false : fill;
    let result: unknown = nil;
    for (let i = 0; i < count; i++) {
      result = new Pair(value, result);
    }
    // Stamp the head Pair only — internal cons cells share the same lineage
    // by definition; downstream traversal reads provenance off whichever pair
    // is bound. Parallel to lips.ts `cons` which only stamps the produced cell.
    return withInputProvenance(fill === undefined ? [k] : [k, fill], result);
  },

  "list-tail"(list: unknown, k: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-tail: list too short`);
      current = current.cdr;
    }
    return current;
  },

  "list-ref"(list: unknown, k: unknown): unknown {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-ref: list too short`);
      current = current.cdr;
    }
    TypeError.invariant(current instanceof Pair, `list-ref: index out of bounds`);
    return current.car;
  },

  "list-set!"(list: unknown, k: unknown, obj: unknown): void {
    const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
    let current = list;
    for (let i = 0; i < count; i++) {
      TypeError.invariant(current instanceof Pair, `list-set!: list too short`);
      current = current.cdr;
    }
    TypeError.invariant(current instanceof Pair, `list-set!: index out of bounds`);
    current.car = obj;
  },

  "list-copy"(list: unknown): unknown {
    // `=== nil` would miss Nil clones (singletons minted via withProvenance by
    // the evaluator's control-flow provenance pass). A clone bypassed the
    // guard, fell to the `!(instanceof Pair)` improper-list branch on the next
    // line, and aliased the input by reference — violating R7RS list-copy's
    // fresh-allocation contract. `instanceof Nil` keeps the freshness story
    // intact for both the singleton and any clones.
    if (list instanceof Nil) return nil;
    if (!(list instanceof Pair)) return list;
    if (isCircularList(list)) TypeError.invariant(false, "list-copy: circular list");
    // Deep copy the spine of the list
    const copy = (lst: unknown): unknown => {
      // Same clone-aware check at the recursion base: a Nil clone in the cdr
      // would otherwise be preserved as an improper-list tail.
      if (lst instanceof Nil) return nil;
      if (!(lst instanceof Pair)) return lst; // improper list tail
      return new Pair(lst.car, copy(lst.cdr));
    };
    // Copy is a fresh allocation but semantically the same lineage as `list`.
    return withInputProvenance([list], copy(list));
  },

  // R7RS 6.4 List searching functions
  memq(obj: unknown, list: unknown): unknown {
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "memq: circular list");
    while (current instanceof Pair) {
      // eq? comparison (object identity)
      if (current.car === obj) return current;
      current = current.cdr;
    }
    return false;
  },

  memv(obj: unknown, list: unknown): unknown {
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "memv: circular list");
    while (current instanceof Pair) {
      if (eqv(current.car, obj)) return current;
      current = current.cdr;
    }
    return false;
  },

  assq(obj: unknown, alist: unknown): unknown {
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assq: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && pair.car === obj) return pair;
      current = current.cdr;
    }
    return false;
  },

  assv(obj: unknown, alist: unknown): unknown {
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assv: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && eqv(pair.car, obj)) return pair;
      current = current.cdr;
    }
    return false;
  },

  // member uses equal? (deep structural equality)
  member(obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
    let current = list;
    if (isCircularList(list)) TypeError.invariant(false, "member: circular list");
    while (current instanceof Pair) {
      // `cmp` may be a user-supplied Scheme predicate whose result is a boxed
      // SchemeBool post-L1 (a truthy JS object); route through is_false.
      if (!is_false(cmp(obj, current.car))) return current;
      current = current.cdr;
    }
    return false;
  },

  // assoc uses equal? (deep structural equality)
  assoc(obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
    let current = alist;
    if (isCircularList(alist)) TypeError.invariant(false, "assoc: circular list");
    while (current instanceof Pair) {
      const pair = current.car;
      // `cmp` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
      if (pair instanceof Pair && !is_false(cmp(obj, pair.car))) return pair;
      current = current.cdr;
    }
    return false;
  },

  // ============================================================================
  // R7RS Equivalence predicates (Section 6.1)
  // ============================================================================

  "procedure?"(obj: unknown): boolean {
    return typeof obj === "function";
  },

  "equal?"(a: unknown, b: unknown): boolean {
    return structuralEqual(a, b);
  },

  // ============================================================================
  // R7RS Vector functions (Section 6.8)
  // ============================================================================

  "make-vector"(k: unknown, fill?: unknown): SchemeVector {
    const len = Number(typeof k === "number" ? k : (k as SchemeExact).valueOf());
    // O(1) cap check BEFORE Array.from materializes `len` slots — see
    // assertAllocatable. `Array.from({length})` on an oversized count is the
    // >10s hang the audit caught.
    assertAllocatable(len, "make-vector");
    const arr = Array.from({ length: len }) as SchemeValue[];
    if (fill !== undefined) {
      arr.fill(fill);
    }
    // Boxed into SchemeVector so the container carries provenance and hosts
    // algebra instances. Elements (if AValues) still carry their own provenance.
    return withInputProvenance([fill], new SchemeVector(arr));
  },

  vector(...objs: unknown[]): SchemeVector {
    return withInputProvenance(objs, new SchemeVector([...objs] as SchemeValue[]));
  },

  "vector-append"(...vectors: unknown[]): SchemeVector {
    const arrays = vectors.map((v) => asVector(v, "vector-append"));
    return withInputProvenance(vectors, new SchemeVector(([] as SchemeValue[]).concat(...arrays)));
  },

  "vector?"(obj: unknown): boolean {
    // instanceof-only (S10): a vector is exactly a boxed SchemeVector. Unlike a
    // raw Uint8Array (which genuinely IS bytevector-like, so bytevector? stays
    // polymorphic), a raw JS array is an R7RS *list* / FFI array at the membrane,
    // NOT a vector — so it correctly answers #f here. asVector still coerces a
    // raw array defensively for any value that bypasses producers.
    return obj instanceof SchemeVector;
  },

  "vector-length"(vec: unknown): number {
    return asVector(vec, "vector-length").length;
  },

  "vector-ref"(vec: unknown, k: unknown): unknown {
    const arr = asVector(vec, "vector-ref");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    return arr[idx as number];
  },

  // vector-set! / vector-fill! / vector-copy! — OMITTED by the purity invariant
  // (frozen entities); doored in bootstrap.ts. Non-mutating vector-copy stays.

  "vector->list"(vec: unknown, start?: unknown, end?: unknown): unknown {
    const arr = asVector(vec, "vector->list");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return Pair.fromArray(arr.slice(s, e));
  },

  "list->vector"(list: unknown): SchemeVector {
    const result: SchemeValue[] = [];
    let current = list;
    while (current instanceof Pair) {
      result.push(current.car);
      current = current.cdr;
    }
    return withInputProvenance([list], new SchemeVector(result));
  },


  "vector->string"(vec: unknown, start?: unknown, end?: unknown): SchemeString {
    const arr = asVector(vec, "vector->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    let result = "";
    for (let i = s; i < e; i++) {
      const ch = arr[i];
      result += ch instanceof SchemeCharacter ? charValue(ch) : String(ch);
    }
    return withInputProvenance([vec], new SchemeString(result));
  },

  "string->vector"(str: unknown, start?: unknown, end?: unknown): SchemeVector {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    const result: SchemeValue[] = [];
    for (let i = s; i < e; i++) {
      result.push(new SchemeCharacter(s_str[i]));
    }
    return withInputProvenance([str], new SchemeVector(result));
  },

  "vector-copy"(vec: unknown, start?: unknown, end?: unknown): SchemeVector {
    const arr = asVector(vec, "vector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return withInputProvenance([vec], new SchemeVector(arr.slice(s, e)));
  },

  // vector-copy! — OMITTED by the purity invariant (mutates its destination);
  // doored in bootstrap.ts. The non-mutating `vector-copy` (above) stays.

  "vector-map"(proc: Function, ...vectors: unknown[]): SchemeVector | Promise<SchemeVector> {
    invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
    const arrays = vectors.map((v) => asVector(v, "vector-map"));
    const minLen = Math.min(...arrays.map((a) => a.length));
    const result: SchemeValue[] = [];
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      result.push(proc(...elements));
    }
    // proc may be an async membrane callback → its results are JS Promises. Mirror
    // the list `map` (stdlib.ts): if any slot is a promise, await them all so the
    // returned vector holds SETTLED values (not "[object Promise]") and provenance
    // is preserved. (errors-as-doors note: silent leak defeats boxing goal-b.)
    if (result.some(is_promise)) {
      return (promise_all(result) as Promise<SchemeValue[]>).then(
        (resolved) => withInputProvenance(vectors, new SchemeVector(resolved)),
      );
    }
    return withInputProvenance(vectors, new SchemeVector(result));
  },

  "vector-for-each"(proc: Function, ...vectors: unknown[]): void | Promise<void> {
    invariant(vectors.length > 0, "vector-for-each: expected at least one vector argument");
    const arrays = vectors.map((v) => asVector(v, "vector-for-each"));
    const minLen = Math.min(...arrays.map((a) => a.length));
    const pending: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      const ret = proc(...elements);
      if (is_promise(ret)) pending.push(ret);
    }
    // Await any async side effects before returning, so for-each does not complete
    // while promises are still outstanding.
    if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
  },

  // ============================================================================
  // R7RS Bytevector functions (Section 6.9)
  // Polymorphic: works with Uint8Array, ArrayBuffer, DataView, Node Buffer
  // ============================================================================

  "bytevector?"(obj: unknown): boolean {
    // Polymorphic by design (NOT a transition shim): scheme producers mint
    // SchemeBytevector, but raw binary legitimately flows from FFI through the
    // membrane unboxed (membrane preserves Uint8Array identity), and a raw
    // Uint8Array/ArrayBuffer/DataView/Buffer genuinely IS bytevector-like. So the
    // predicate accepts boxed OR raw — mirroring asBytevector's coercion. (Vectors
    // differ: a raw JS array is an R7RS list, not a vector, so vector? is
    // instanceof-only — see the boxing plan's (a)/(b) disambiguation.)
    return (
      obj instanceof SchemeBytevector ||
      obj instanceof Uint8Array ||
      obj instanceof ArrayBuffer ||
      obj instanceof DataView ||
      (typeof Buffer !== "undefined" && obj instanceof Buffer)
    );
  },

  "make-bytevector"(k: unknown, byte?: unknown): SchemeBytevector {
    const arr = new Uint8Array(toIndex(k));
    if (byte !== undefined) {
      arr.fill(toIndex(byte));
    }
    return withInputProvenance([byte], new SchemeBytevector(arr));
  },

  bytevector(...bytes: unknown[]): SchemeBytevector {
    const result = new Uint8Array(bytes.length);
    for (const [i, b] of bytes.entries()) {
      result[i] = toIndex(b);
    }
    return withInputProvenance(bytes, new SchemeBytevector(result));
  },

  "bytevector-length"(bv: unknown): number {
    const view = asBytevector(bv, "bytevector-length");
    return view.byteLength;
  },

  "bytevector-u8-ref"(bv: unknown, k: unknown): number {
    const view = asBytevector(bv, "bytevector-u8-ref");
    return view[toIndex(k)];
  },

  // bytevector-u8-set! / bytevector-copy! — OMITTED by the purity invariant
  // (frozen entities); doored in bootstrap.ts. Non-mutating bytevector-copy stays.

  "bytevector-copy"(bv: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const view = asBytevector(bv, "bytevector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return withInputProvenance([bv], new SchemeBytevector(view.slice(s, e)));
  },

  "bytevector-append"(...bvs: unknown[]): SchemeBytevector {
    const views = bvs.map((bv) => asBytevector(bv, "bytevector-append"));
    const totalLen = views.reduce((sum, v) => sum + v.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const view of views) {
      result.set(view, offset);
      offset += view.byteLength;
    }
    return withInputProvenance(bvs, new SchemeBytevector(result));
  },

  "utf8->string"(bv: unknown, start?: unknown, end?: unknown): SchemeString {
    const view = asBytevector(bv, "utf8->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return withInputProvenance([bv], new SchemeString(new TextDecoder("utf-8").decode(view.subarray(s, e))));
  },

  "string->utf8"(str: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    return withInputProvenance([str], new SchemeBytevector(new TextEncoder().encode(s_str.slice(s, e))));
  },

  // ============================================================================
  // R7RS String functions (Section 6.7)
  // ============================================================================

  "string-map"(proc: Function, ...strings: unknown[]): string | Promise<string> {
    invariant(strings.length > 0, "string-map: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    const results: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      results.push(proc(...strs.map((s) => new SchemeCharacter(s[i]))));
    }
    const join = (chars: unknown[]) =>
      chars
        .map((c) => (c instanceof SchemeCharacter ? charValue(c) : typeof c === "string" ? c : String(c)))
        .join("");
    // proc may be an async membrane callback → await before joining, so the result
    // is a real string, not "[object Promise][object Promise]…" (see vector-map).
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<unknown[]>).then(join);
    }
    return join(results);
  },

  "string-for-each"(proc: Function, ...strings: unknown[]): void | Promise<void> {
    invariant(strings.length > 0, "string-for-each: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    const pending: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      const ret = proc(...strs.map((s) => new SchemeCharacter(s[i])));
      if (is_promise(ret)) pending.push(ret);
    }
    if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
  },

  // ============================================================================
  // List Utilities (moved from bootstrap.ts)
  // ============================================================================

  single(list: unknown): boolean {
    // Provenance-stamped Nil clones (Nil instances that are NOT the canonical
    // singleton) would make `single(Pair(x, nil-clone))` falsely report false,
    // sending callers down the multi-element slow path. Use the structural
    // `instanceof Nil` guard.
    return list instanceof Pair && list.cdr instanceof Nil;
  },

  take(lst: unknown, n: unknown): Pair | typeof nil {
    const count = toIndex(n);
    let result: Pair | typeof nil = nil;
    let tail: Pair | null = null;
    let current = lst;
    let i = 0;

    while (current instanceof Pair && i < count) {
      const newPair = new Pair(current.car, nil);
      if (tail === null) {
        result = newPair;
      } else {
        tail.cdr = newPair;
      }
      tail = newPair;
      current = current.cdr;
      i++;
    }
    return result;
  },

  drop(lst: unknown, n: unknown): unknown {
    const count = toIndex(n);
    let current = lst;
    let i = 0;

    while (current instanceof Pair && i < count) {
      current = current.cdr;
      i++;
    }
    return current;
  },

  range(stopOrStart: unknown, ...rest: unknown[]): Pair | typeof nil {
    let start: number, stop: number, step: number;

    if (rest.length === 0) {
      start = 0;
      stop = toIndex(stopOrStart);
      step = 1;
    } else if (rest.length === 1) {
      start = toIndex(stopOrStart);
      stop = toIndex(rest[0]);
      step = 1;
    } else {
      start = toIndex(stopOrStart);
      stop = toIndex(rest[0]);
      step = toIndex(rest[1]);
    }

    const result: number[] = [];

    if (start < stop && step > 0) {
      for (let i = start; i < stop; i += step) {
        result.push(i);
      }
    } else if (start > stop && step < 0) {
      for (let i = start; i > stop; i += step) {
        result.push(i);
      }
    }

    // Convert array to list
    if (result.length === 0) return nil;
    let list: Pair | typeof nil = nil;
    for (let i = result.length - 1; i >= 0; i--) {
      list = new Pair(new SchemeExact(BigInt(result[i])), list);
    }
    return list;
  },

  // ============================================================================
  // Higher-Order Utilities (moved from bootstrap.ts)
  // ============================================================================

  complement(fn: Function): Function {
    // `fn` may be a scheme lambda, which returns a Promise to JS callers
    // (generator-lambda async return) — so unpromise before testing. And its
    // result may be a boxed SchemeBool (a truthy JS object), so negate via
    // is_false, not `!` (always false on an object). Both were latent: plain
    // `!fn(...)` failed for async predicates AND for boxed-bool ones.
    const result = (...args: unknown[]) => unpromise(fn(...args), is_false);
    Object.defineProperty(result, "name", { value: "complement" });
    return result;
  },

  always(constant: unknown): Function {
    const result = () => constant;
    Object.defineProperty(result, "name", { value: "always" });
    return result;
  },

  once(fn: Function): Function {
    let called = false;
    let result: unknown;
    const wrapped = (...args: unknown[]) => {
      if (!called) {
        called = true;
        result = fn(...args);
      }
      return result;
    };
    Object.defineProperty(wrapped, "name", { value: "once" });
    return wrapped;
  },

  flip(fn: Function): Function {
    const result = (a: unknown, b: unknown, ...rest: unknown[]) => fn(b, a, ...rest);
    Object.defineProperty(result, "name", { value: "flip" });
    return result;
  },

  "n-ary"(n: unknown, fn: Function): Function {
    const count = toIndex(n);
    const result = (...args: unknown[]) => fn(...args.slice(0, count));
    Object.defineProperty(result, "name", { value: "n-ary" });
    return result;
  },
};

// ============================================================================
// Environment Integration
// ============================================================================

/**
 * Apply numeric bindings to a LIPS environment
 */
export function applyToEnvironment(lipsEnv: { set: (k: string, v: unknown) => void }): void {
  for (const [name, fn] of Object.entries(wrappedOps)) {
    lipsEnv.set(name, fn);
  }
}

/**
 * Initialize bridge by applying all wrapped operators to the global LIPS environment
 * and evaluating the bootstrap Scheme code.
 */
let bootstrapPromise: Promise<void> | null = null;

export function initBridge(): Promise<void> {
  if (isBridgeInitialized() && bootstrapPromise) return bootstrapPromise;
  // Set the realm-level flag at the TOP, before the bootstrap exec below — so the
  // re-entrant inner exec(BOOTSTRAP_SCHEME) sees `initialized === true` and skips
  // its own self-init (no recursion). See boot.ts.
  markBridgeInitialized();

  // Apply TypeScript bindings synchronously
  applyToEnvironment(global_env);

  // Evaluate bootstrap Scheme code asynchronously, then expose a curated set of
  // bootstrap-defined bindings in the sandbox. They live in user_env; copy the
  // values into sandboxedEnv so sandboxed/showcase code can reach them:
  //   • threading macros ->/->>/~>/~>>  — pure code-rewrites.
  //   • SRFI-26 cut/cute               — partial application; expand to a lambda.
  //   • gensym                          — cut/cute call it at expansion time for
  //                                       capture-safe slot names, so it has to be
  //                                       reachable from a sandboxed (cut …) site.
  // All pure: a macro's expansion still evaluates under the sandbox allowlist, so
  // none adds a capability. (Dynamic import avoids a static bridge<->sandbox-env
  // import cycle.)
  //
  // NOT copied: the hygienic syntax family (define-syntax / let-syntax /
  // letrec-syntax + syntax-rules). They evaluate fine in the FULL env (the chibi
  // R7RS suite drives them), but the LIPS pattern matcher misbehaves under the
  // sandbox env — a `(double 50)` use of a sandbox-defined syntax-rules macro
  // fails "no matching syntax in macro (50)". Env-specific matcher issue, tracked
  // separately; define-macro (an evaluator special form) is the working path for
  // user macros in the sandbox today.
  //   • SRFI-1 (the missing third) + safe head accessor first?/first-or — pure list
  //     procedures. first?/first-or make (car (filter …)) on an empty match — the
  //     dominant avoidable crash in generated Scheme — unnecessary. `remove` is now
  //     the SOLE source of `remove` in the sandbox (it used to shadow a broken Ramda
  //     `remove`; Ramda has since been evicted, so this copy is what supplies it).
  //   • Composition + quantifiers compose/comp/pipe/flow (polyglot) and some/every
  //     (SRFI-1). The inference plane (sandboxedEnv) is the totalic env where models
  //     author Scheme; this composition/quantifier vocabulary used to reach it via the
  //     Ramda spread. Ramda is now evicted into @here.build/arrival-scheme-env-ramda
  //     (opt-in), so copying the bootstrap definitions over is what keeps the plane's
  //     compose/pipe/some/every — sourced from pure Scheme. Pure, capability-free.
  bootstrapPromise = exec(BOOTSTRAP_SCHEME).then(async () => {
    const { sandboxedEnv } = await import("./sandbox-env.js");
    for (const name of [
      "->", "->>", "~>", "~>>", "cut", "cute", "gensym",
      "first?", "first-or", "iota", "delete-duplicates", "filter-map", "count", "list-index", "append-map", "remove",
      "compose", "comp", "pipe", "flow", "some", "every",
    ]) {
      const value = userEnv.get(name, { throwError: false });
      if (value) sandboxedEnv.set(name, value);
    }
  });
  return bootstrapPromise;
}
