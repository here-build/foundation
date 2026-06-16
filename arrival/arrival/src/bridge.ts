/**
 * Bridge - connects the Operator/Profunctor system with the Scheme runtime.
 *
 * This module provides:
 * 1. Strict numeric coercion into the SchemeExact/SchemeInexact tower (`coerceNumeric`)
 * 2. Wrapped operators that work with boxed Scheme values
 * 3. Drop-in replacements for global_env numeric operations
 */

import { AValue, unionProvenance } from "./values/AValue.js";
import { isBridgeInitialized, markBridgeInitialized, setBootstrapComplete } from "./boot.js";
import { EnvCapability } from "./env/capability.js";
import { assembleEnv } from "./env/kernel.js";
import { BASE_PACKS } from "./env/base-packs.js";
import type { EvalSchemeInto, SchemeEnv } from "./env/scheme-env.js";
import { HalfBaked, type Interval, is_half_baked } from "./values/HalfBaked.js";
import type { Environment } from "./Environment.js";
import { schemeFalse, schemeTrue } from "./values/SchemeBool.js";
import { coerceNumeric, getAllocationLimit, isOrd, isSchemeNumber, ORD_REL, setAllocationLimit } from "./values/op-helpers.js";
// Value-domain primitive clusters — each is the carved-out source of truth for one
// R7RS domain (chars/strings/lists/vectors/bytevectors + combinators + equality).
// They are no longer spread into `wrappedOps`: `initBridge` ASSEMBLES them onto
// `global_env` as live capability packs (see `NATIVE_PACKS`). `wrappedOps` keeps only
// the numeric core + exception machinery bridge.ts is named for (the
// Operator/Profunctor↔Scheme bridge).
import { NATIVE_PACKS } from "./env/native-packs.js";
import { env as userEnv, exec, global_env } from "./stdlib.js";
import { SchemeString } from "./values/SchemeString.js";
import type { Codec, Operator } from "./membrane.js";
import type { SchemeNumeric } from "./values/numbers.js";
import { SchemeExact, SchemeInexact } from "./values/numbers.js";
import * as ops from "./operators/index.js";
// Import directly from source files to avoid circular dependency during init
import { Pair } from "./values/Pair.js";
import { nil } from "./values/types.js";
import { type } from "./utils/typecheck.js";
import { Values } from "./values/Values.js";
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
      const detail = badIndex >= 0 ? `argument ${badIndex} is ${type(callArgs[badIndex])}` : "argument type mismatch";
      throw new TypeError(`Cannot apply ${op.name} to (${typeNames}): ${detail}`, { cause });
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
      return Promise.all(args.map((a) => (is_half_baked(a) ? a.force() : a))).then(applyNumeric);
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
  return hb
    .decide(verdict)
    .then((bool) => (provenance.size > 0 ? (bool ? schemeTrue : schemeFalse).withProvenance(provenance) : bool));
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

// The FL-Ord derivation (`isOrd` / `ORD_REL` / `deriveOrd`) lives in op-helpers —
// shared with the chars + strings clusters, whose `char<?` / `string<?` families
// ARE `deriveOrd` chains. `wrapOrd` stays here: it wraps a NUMERIC operator with
// the FL-Ord fallback, so it belongs with the numeric bridge core.
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
};

// ============================================================================
// Environment Integration
// ============================================================================

// The R7RS exception verbs in `wrappedOps`. Everything else in `wrappedOps` is the
// numeric core (the Operator/Profunctor↔Scheme bridge). The two are split into two
// capability packs below so they assemble like every other domain — no more imperative
// `applyToEnvironment` monolith. (Defined HERE, not in env/native-packs.ts, because the
// numeric machinery — wrapOperator / wrapOrd / speculativeCompare — lives in this module;
// importing it from a native-packs sibling would close the bridge↔native-packs cycle.)
const EXCEPTION_VERBS = new Set([
  "error-object?",
  "error-object-message",
  "error-object-irritants",
  "read-error?",
  "file-error?",
  "make-error-object",
  "raise-exception",
  "raise-continuable-exception",
  "raised-exception?",
  "raised-exception-value",
  "raised-exception-continuable?",
  "%raise",
]);

const symbolsFrom = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([k, v]) => [k, { value: v }]));

/** The numeric core (arithmetic, comparison, numeric predicates, conversions) as a pack. */
export const numbersCapability = new EnvCapability("scheme/numbers", {
  symbols: symbolsFrom(Object.entries(wrappedOps).filter(([k]) => !EXCEPTION_VERBS.has(k))),
});

/** The R7RS § 6.11 exception verbs as a pack. */
export const exceptionsCapability = new EnvCapability("scheme/exceptions", {
  symbols: symbolsFrom(Object.entries(wrappedOps).filter(([k]) => EXCEPTION_VERBS.has(k))),
});

/** The full native foundation assembled onto global_env: value-domain clusters + the
 *  bridge's own numbers + exceptions packs. */
const GLOBAL_NATIVE_PACKS = [...NATIVE_PACKS, numbersCapability, exceptionsCapability];

/**
 * @deprecated Imperative monolith application — superseded by assembling
 * `GLOBAL_NATIVE_PACKS`. Retained only because a debug script imports it.
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
  // Set the realm-level flag at the TOP, before the prelude eval below — so the
  // re-entrant inner exec (a pack prelude) sees `initialized === true` and skips
  // its own self-init (no recursion). See boot.ts.
  markBridgeInitialized();

  // The whole native foundation — value-domain clusters + numbers + exceptions — is
  // now assembled onto global_env as capability packs in the async chain below; the
  // imperative `applyToEnvironment(global_env)` monolith is gone. Async native
  // application is fine: every public `exec` awaits bootstrap COMPLETION (boot.ts
  // whenBootstrapComplete), not just the started-flag, so a racing exec never observes
  // a half-assembled env. (Bootstrap's own prelude evals use stdlib's gate-free `exec`,
  // so the completion await is never re-entrant.)

  // The scheme stdlib loads by ASSEMBLING the base packs onto user_env — not by
  // exec-ing one hand-concatenated `BOOTSTRAP_SCHEME` string. `assembleEnv` runs
  // each pack's full contribution (prelude + symbols + resolvers) in C3 order, so
  // the packs are the SOLE source of the scheme surface: e.g. polyglot's `@`/`:key`
  // and arrival's `symbol->string` now land here via their owning capability rather
  // than via separate hand-wiring. `evalScheme` injects the evaluator (exec into the
  // assembling env). The base preludes are verified mutually order-independent (none
  // expands another's macro), so the C3 application order is immaterial to them.
  // skipBootstrapWait: this exec IS the bootstrap (a base-pack prelude eval), so it
  // must NOT await bootstrap completion — that would deadlock on the very promise it
  // is part of.
  const evalScheme: EvalSchemeInto = (env, src) =>
    exec(src as string, { env: env as Environment, skipBootstrapWait: true });

  // Evaluate bootstrap Scheme code asynchronously, then expose a curated set of
  // bootstrap-defined bindings in the inference plane. They live in user_env; copy the
  // values into inferenceEnv so inference-plane/showcase code can reach them:
  //   • threading macros ->/->>/~>/~>>  — pure code-rewrites.
  //   • SRFI-26 cut/cute               — partial application; expand to a lambda.
  //   • gensym                          — cut/cute call it at expansion time for
  //                                       capture-safe slot names, so it has to be
  //                                       reachable from an inference-plane (cut …) site.
  // All pure: a macro's expansion still evaluates under the inference env, so
  // none adds a capability. (Dynamic import avoids a static bridge<->inference-env
  // import cycle.)
  //
  // NOT copied: the hygienic syntax family (define-syntax / let-syntax /
  // letrec-syntax + syntax-rules). They evaluate fine in the FULL env (the chibi
  // R7RS suite drives them), but the LIPS pattern matcher misbehaves under the
  // inference env — a `(double 50)` use of a inference-plane-defined syntax-rules macro
  // fails "no matching syntax in macro (50)". Env-specific matcher issue, tracked
  // separately; define-macro (an evaluator special form) is the working path for
  // user macros in the inference plane today.
  //   • SRFI-1 (the missing third) + safe head accessor first?/first-or — pure list
  //     procedures. first?/first-or make (car (filter …)) on an empty match — the
  //     dominant avoidable crash in generated Scheme — unnecessary. `remove` is now
  //     the SOLE source of `remove` in the inference plane (it used to shadow a broken Ramda
  //     `remove`; Ramda has since been evicted, so this copy is what supplies it).
  //   • Composition + quantifiers compose/comp/pipe/flow (polyglot) and some/every
  //     (SRFI-1). The inference plane (inferenceEnv) is the totalic env where models
  //     author Scheme; this composition/quantifier vocabulary used to reach it via the
  //     Ramda spread. Ramda is now evicted into @here.build/arrival-scheme-env-ramda
  //     (opt-in), so copying the bootstrap definitions over is what keeps the plane's
  //     compose/pipe/some/every — sourced from pure Scheme. Pure, capability-free.
  // Assemble the native foundation (value-domain clusters + numbers + exceptions) onto
  // global_env FIRST (symbol-only, no prelude — `lower()` needs no evalScheme), THEN the
  // .scm base packs onto user_env. Order matters: a base-pack prelude may call a native
  // primitive (e.g. `string-length`, `+`), which resolves through user_env → global_env,
  // so the natives must already be live there.
  bootstrapPromise = assembleEnv(
    global_env as unknown as SchemeEnv,
    GLOBAL_NATIVE_PACKS.map((pack) => pack.lower()),
  )
    .then(() =>
      assembleEnv(
        userEnv as unknown as SchemeEnv,
        BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
      ),
    )
    .then(async () => {
      const { inferenceEnv } = await import("./inference-env.js");
      // The FL/array-interop overlay (car/cdr/filter/map/reduce) is its own capability
      // pack. Assemble it onto the inference-plane base env HERE — after global_env's
      // native assembly and the base packs — so its lazily-captured `builtin*` refs
      // (read at first call from global_env) are guaranteed live. Doing it inside
      // whenBootstrapComplete's chain means a public exec never sees a half-assembled
      // inferenceEnv. (Dynamic import mirrors the inference-env one — avoids an init cycle.)
      const flInterop = (await import("./env/fl-interop.js")).default;
      await assembleEnv(inferenceEnv as unknown as SchemeEnv, [flInterop.lower()]);
      for (const name of [
        "->",
        "->>",
        "~>",
        "~>>",
        "cut",
        "cute",
        "gensym",
        "first?",
        "first-or",
        "iota",
        "delete-duplicates",
        "filter-map",
        "count",
        "list-index",
        "append-map",
        "remove",
        "compose",
        "comp",
        "pipe",
        "flow",
        "some",
        "every",
      ]) {
        const value = userEnv.get(name, { throwError: false });
        if (value) inferenceEnv.set(name, value);
      }
    });
  // Publish the COMPLETION promise so a public `exec` racing a fire-and-forget
  // `void initBridge()` (index.ts) awaits the full async assembly, not just the flag.
  setBootstrapComplete(bootstrapPromise);
  return bootstrapPromise;
}
