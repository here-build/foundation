/**
 * Bridge - Connects the new Operator/Profunctor system with LIPS runtime
 *
 * This module provides:
 * 1. Converters between LIPS types (LNumber) and new types (ExactNumber/InexactNumber)
 * 2. Wrapped operators that work with LIPS values
 * 3. Drop-in replacements for global_env numeric operations
 */

import foldCase from "fold-case";
import unicodeProperties from "unicode-properties";

import { AValue, unionProvenance } from "./AValue.js";
import { BOOTSTRAP_SCHEME } from "./bootstrap.js";
import type { Environment } from "./Environment.js";
import { SchemeBool, schemeFalse, schemeTrue } from "./LBool.js";
import { global_env as lipsGlobalEnv, evaluate, exec } from "./lips.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import type { Operator, Codec } from "./membrane.js";
import type { SchemeNumeric } from "./numbers.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import * as ops from "./operators/index.js";
// Import directly from source files to avoid circular dependency during init
import { Pair } from "./Pair.js";
import { SchemeCharacter, nil } from "./types.js";
import { Values } from "./Values.js";
import invariant from "tiny-invariant";
import "./errors.js";
// Import global environment for initBridge - this is safe because bridge.ts
// doesn't get imported during lips.ts initialization

// ============================================================================
// Internal Helpers (extracted to avoid duplication)
// ============================================================================

/**
 * Extract character value from SchemeCharacter
 */
function charValue(char: unknown): string {
  return (char as SchemeCharacter).__char__;
}

/**
 * Extract string value from SchemeString or convert to string
 */
function stringValue(str: unknown): string {
  return str instanceof SchemeString ? str.valueOf() : String(str);
}

/**
 * Convert unknown to index number (for vector/string operations)
 */
function toIndex(v: unknown): number {
  return typeof v === "number" ? v : Number((v as SchemeExact).valueOf());
}

/**
 * Convert bytevector-like value to Uint8Array view.
 * Accepts Uint8Array, ArrayBuffer, DataView, Node Buffer.
 * Preserves identity for Uint8Array, creates view for others.
 */
function asBytevector(obj: unknown, fnName: string): Uint8Array {
  switch (true) {
    case obj instanceof Uint8Array:
      return obj;
    case obj instanceof ArrayBuffer:
      return new Uint8Array(obj);
    case obj instanceof DataView:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    case typeof Buffer !== "undefined" && obj instanceof Buffer:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    default:
      TypeError.invariant(false, `${fnName}: expected bytevector, got ${typeof obj}`);
  }
}

/**
 * eqv? comparison - identity plus numeric value equality
 */
function eqv(a: unknown, b: unknown): boolean {
  switch (true) {
    case a === b:
      return true;
    case typeof a === "number" && typeof b === "number":
      return a === b;
    case a instanceof SchemeExact && b instanceof SchemeExact:
      return a.cmp(b) === 0;
    case a instanceof SchemeInexact && b instanceof SchemeInexact:
      return a.cmp(b) === 0;
    case a instanceof SchemeBool && b instanceof SchemeBool:
      return a.value === b.value;
    default:
      return false;
  }
}

/**
 * Deep structural equality for Scheme values (equal?)
 */
function deepEqual(a: unknown, b: unknown): boolean {
  switch (true) {
    case a === b:
      return true;
    case a instanceof Pair && b instanceof Pair:
      return deepEqual(a.car, b.car) && deepEqual(a.cdr, b.cdr);
    case a instanceof SchemeExact && b instanceof SchemeExact:
      return a.cmp(b) === 0;
    case a instanceof SchemeInexact && b instanceof SchemeInexact:
      return a.cmp(b) === 0;
    // SchemeBool cross-instance: schemeTrue/schemeFalse singletons would short-circuit
    // at the `a === b` line above, but provenance-stamped copies wouldn't.
    case a instanceof SchemeBool && b instanceof SchemeBool:
      return a.value === b.value;
    case (typeof a === "string" || a instanceof SchemeString) && (typeof b === "string" || b instanceof SchemeString):
      return String(a) === String(b);
    case a instanceof SchemeSymbol && b instanceof SchemeSymbol:
      return a.__name__ === b.__name__;
    case Array.isArray(a) && Array.isArray(b): {
      if (a.length !== b.length) return false;
      for (const [i, element] of a.entries()) {
        if (!deepEqual(element, b[i])) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

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
 * Convert a LIPS number to our ExactNumber/InexactNumber
 */
export function fromLIPS(value: unknown): SchemeNumeric {
  switch (true) {
    case value instanceof SchemeExact:
    case value instanceof SchemeInexact:
      return value;
    case typeof value === "bigint":
      return new SchemeExact(value);
    // Safe integers become exact (likely from Scheme integer literals)
    // Non-safe integers and floats become inexact
    case typeof value === "number":
      return Number.isSafeInteger(value) ? new SchemeExact(BigInt(value)) : new SchemeInexact(value);
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
          return new SchemeExact(val);
        case typeof val === "number":
          return Number.isSafeInteger(val) ? new SchemeExact(BigInt(val)) : new SchemeInexact(val);
        default:
          TypeError.invariant(false, `Cannot convert to SchemeNumeric: ${val}`);
      }
      break;
    }
    default:
      TypeError.invariant(false, `Cannot convert to SchemeNumeric: ${value}`);
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
  // Use Object.defineProperty to set the name from operator
  const fn = function (...args: unknown[]): unknown {
    const provenance = unionProvenance(args.filter((a): a is AValue => a instanceof AValue));
    const converted = args.map(fromLIPS);
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
  Object.defineProperty(fn, "name", { value: op.name });
  return fn;
}

/**
 * Stamp `result` with the union of `args`' provenances. Parallel to lips.ts's
 * `withInputProvenance` (same algebra, separate file because these builtins
 * live in bridge.ts — `string-append`, `string-copy`, `list-copy`, `vector`,
 * etc. all produce fresh AValue / array / Uint8Array results whose provenance
 * must inherit from their inputs).
 *
 * Like the lips.ts twin, we deliberately don't box raw JS bool/number/bigint —
 * boxing bool here would break the same `!== false` callers that withInputProvenance
 * keeps sealed. Raw JS strings get boxed via `AValue.fromJs` so provenance has
 * somewhere to live (mirrors lips.ts:2052).
 */
function withInputProvenance<T>(args: readonly unknown[], result: T): T {
  const inputs = args.filter((a): a is AValue => a instanceof AValue);
  if (inputs.length === 0) return result;
  const prov = unionProvenance(inputs);
  if (prov.size === 0) return result;
  if (result instanceof AValue) return result.withProvenance(prov) as T;
  if (typeof result === "string") return AValue.fromJs(result, prov) as T;
  return result;
}

/**
 * Check if a value can be converted to SchemeNumeric (without throwing)
 */
export function isSchemeNumber(value: unknown): boolean {
  switch (true) {
    case value instanceof SchemeExact:
    case value instanceof SchemeInexact:
      return true;
    case typeof value === "bigint":
    case typeof value === "number":
      return true;
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
        case typeof val === "number":
          return true;
        default:
          return false;
      }
      break;
    }
    default:
      return false;
  }
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
      const converted = fromLIPS(value);
      return predicate(converted);
    } catch {
      return false;
    }
  };
  Object.defineProperty(fn, "name", { value: name });
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
    const a = fromLIPS(n1);
    const b = fromLIPS(n2);
    const aExact = a instanceof SchemeExact ? a : new SchemeExact(BigInt(Math.trunc(a.real)));
    const bExact = b instanceof SchemeExact ? b : new SchemeExact(BigInt(Math.trunc(b.real)));
    const q = ops.floorQuotient.call([aExact, bExact]);
    const r = ops.floorRemainder.call([aExact, bExact]);
    const qNum = q instanceof SchemeExact ? q : new SchemeExact(q as unknown as bigint);
    const rNum = r instanceof SchemeExact ? r : new SchemeExact(r as unknown as bigint);
    return Values.from([qNum, rNum]);
  },

  "truncate/"(n1: unknown, n2: unknown): unknown {
    const a = fromLIPS(n1);
    const b = fromLIPS(n2);
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
      const n = fromLIPS(arg);
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
  "<": wrapOperator(ops.lt),
  ">": wrapOperator(ops.gt),
  "<=": wrapOperator(ops.lte),
  ">=": wrapOperator(ops.gte),
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
    const converted = fromLIPS(n);
    const one = new SchemeExact(1n);
    return ops.add.call([converted, one]);
  },

  "1-"(n: unknown): SchemeNumeric {
    const converted = fromLIPS(n);
    const one = new SchemeExact(1n);
    return ops.sub.call([converted, one]);
  },

  "%": wrapOperator(ops.remainder),
  "==": wrapOperator(ops.numEq),
  "|": wrapOperator(ops.bitwiseIor),
  "&": wrapOperator(ops.bitwiseAnd),
  "~": wrapOperator(ops.bitwiseNot),

  ">>"(a: unknown, b: unknown): SchemeNumeric {
    const aNum = fromLIPS(a);
    const bNum = fromLIPS(b);
    return ops.arithmeticShift.call([aNum, bNum]);
  },

  "<<"(a: unknown, b: unknown): SchemeNumeric {
    const aNum = fromLIPS(a);
    const bNum = fromLIPS(b);
    const negB = ops.sub.call([bNum]);
    return ops.arithmeticShift.call([aNum, negB]);
  },

  // R7RS exactness conversion
  inexact(z: unknown): SchemeInexact {
    const n = fromLIPS(z);
    if (n instanceof SchemeInexact) return n;
    const exact = n as SchemeExact;
    if (exact.denom === 1n) return new SchemeInexact(Number(exact.num));
    return new SchemeInexact(Number(exact.num) / Number(exact.denom));
  },

  exact(z: unknown): SchemeExact {
    const n = fromLIPS(z);
    if (n instanceof SchemeExact) return n;
    const inexact = n as SchemeInexact;
    invariant(inexact.imag === 0, "Cannot convert complex number with non-zero imaginary part to exact");
    const real = inexact.real;
    TypeError.invariant(Number.isFinite(real), "Cannot convert infinity or NaN to exact");
    if (Number.isInteger(real)) return new SchemeExact(BigInt(real));
    const str = real.toString();
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
    const n = fromLIPS(z);
    const base = radix === undefined ? 10 : Number(fromLIPS(radix).valueOf());
    if (n instanceof SchemeExact) {
      if (n.denom === 1n) return n.num.toString(base);
      return `${n.num.toString(base)}/${n.denom.toString(base)}`;
    }
    const inexact = n as SchemeInexact;
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

  "char<?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]) >= charValue(chars[i + 1])) return false;
    }
    return true;
  },

  "char>?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]) <= charValue(chars[i + 1])) return false;
    }
    return true;
  },

  "char<=?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]) > charValue(chars[i + 1])) return false;
    }
    return true;
  },

  "char>=?"(...chars: unknown[]): boolean {
    for (let i = 0; i < chars.length - 1; i++) {
      if (charValue(chars[i]) < charValue(chars[i + 1])) return false;
    }
    return true;
  },

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
  "char-alphabetic?"(char: unknown): boolean {
    const c = charValue(char);
    return /^[a-z]$/i.test(c) || c.toLowerCase() !== c.toUpperCase();
  },

  "char-numeric?"(char: unknown): boolean {
    const c = charValue(char);
    return unicodeProperties.isDigit(c.codePointAt(0)!);
  },

  "char-whitespace?"(char: unknown): boolean {
    return /^\s$/.test(charValue(char));
  },

  "char-upper-case?"(char: unknown): boolean {
    const c = charValue(char);
    return c === c.toUpperCase() && c !== c.toLowerCase();
  },

  "char-lower-case?"(char: unknown): boolean {
    const c = charValue(char);
    return c === c.toLowerCase() && c !== c.toUpperCase();
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
    const folded = foldCase(charValue(char));
    // char-foldcase returns a single character; if folding expands (e.g. ß→ss), return first char
    return new SchemeCharacter(folded[0] || charValue(char));
  },

  // Character/integer conversion
  "char->integer"(char: unknown): SchemeExact {
    return new SchemeExact(BigInt(charValue(char).charCodeAt(0)));
  },

  "integer->char"(n: unknown): SchemeCharacter {
    const num = fromLIPS(n);
    const code = num instanceof SchemeExact ? Number(num.num) : Math.floor((num as SchemeInexact).real);
    return new SchemeCharacter(String.fromCharCode(code));
  },

  // ============================================================================
  // R7RS String Operations (Section 6.7)
  // ============================================================================

  "make-string"(k: unknown, char?: unknown): SchemeString {
    const len = Number(fromLIPS(k).valueOf());
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
    const idx = Number(fromLIPS(k).valueOf());
    return new SchemeCharacter([...stringValue(str)][idx]);
  },

  "string-set!"(str: unknown, k: unknown, char: unknown): void {
    if (str instanceof SchemeString) {
      str.set(fromLIPS(k), char as SchemeCharacter);
    }
  },

  // String comparison
  "string=?"(...strs: unknown[]): boolean {
    if (strs.length < 2) return true;
    const first = stringValue(strs[0]);
    return strs.slice(1).every((s) => stringValue(s) === first);
  },

  "string<?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]) >= stringValue(strs[i + 1])) return false;
    }
    return true;
  },

  "string>?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]) <= stringValue(strs[i + 1])) return false;
    }
    return true;
  },

  "string<=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]) > stringValue(strs[i + 1])) return false;
    }
    return true;
  },

  "string>=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]) < stringValue(strs[i + 1])) return false;
    }
    return true;
  },

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

  "string-append"(...strs: unknown[]): SchemeString {
    // Result strings inherit lineage from every concatenated input — without
    // this, `(string-append prefix user-name suffix)` would forget where the
    // user-name came from at the next `define` binding.
    return withInputProvenance(strs, new SchemeString(strs.map(stringValue).join("")));
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

  "string-copy!"(to: unknown, at: unknown, from: unknown, start?: unknown, end?: unknown): void {
    const fromChars = [...stringValue(from)];
    const startIdx = start === undefined ? 0 : toIndex(start);
    const endIdx = end === undefined ? fromChars.length : toIndex(end);
    const atIdx = toIndex(at);
    if (to instanceof SchemeString) {
      const toChars = [...to.valueOf()];
      for (let i = startIdx; i < endIdx; i++) toChars[atIdx + (i - startIdx)] = fromChars[i];
      to.__string__ = toChars.join("");
    }
  },

  "string-fill!"(str: unknown, fill: unknown, start?: unknown, end?: unknown): void {
    const c = charValue(fill);
    if (str instanceof SchemeString) {
      const chars = [...str.valueOf()];
      const startIdx = start === undefined ? 0 : toIndex(start);
      const endIdx = end === undefined ? chars.length : toIndex(end);
      for (let i = startIdx; i < endIdx; i++) chars[i] = c;
      str.__string__ = chars.join("");
    }
  },

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
    if (err instanceof R7RSError) {
      return err.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
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
    if (list === nil) return nil;
    if (!(list instanceof Pair)) return list;
    // Deep copy the spine of the list
    const copy = (lst: unknown): unknown => {
      if (lst === nil) return nil;
      if (!(lst instanceof Pair)) return lst; // improper list tail
      return new Pair(lst.car, copy(lst.cdr));
    };
    // Copy is a fresh allocation but semantically the same lineage as `list`.
    return withInputProvenance([list], copy(list));
  },

  // R7RS 6.4 List searching functions
  memq(obj: unknown, list: unknown): unknown {
    let current = list;
    while (current instanceof Pair) {
      // eq? comparison (object identity)
      if (current.car === obj) return current;
      current = current.cdr;
    }
    return false;
  },

  memv(obj: unknown, list: unknown): unknown {
    let current = list;
    while (current instanceof Pair) {
      if (eqv(current.car, obj)) return current;
      current = current.cdr;
    }
    return false;
  },

  assq(obj: unknown, alist: unknown): unknown {
    let current = alist;
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && pair.car === obj) return pair;
      current = current.cdr;
    }
    return false;
  },

  assv(obj: unknown, alist: unknown): unknown {
    let current = alist;
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && eqv(pair.car, obj)) return pair;
      current = current.cdr;
    }
    return false;
  },

  // member uses equal? (deep structural equality)
  member(obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || deepEqual;
    let current = list;
    while (current instanceof Pair) {
      if (cmp(obj, current.car)) return current;
      current = current.cdr;
    }
    return false;
  },

  // assoc uses equal? (deep structural equality)
  assoc(obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || deepEqual;
    let current = alist;
    while (current instanceof Pair) {
      const pair = current.car;
      if (pair instanceof Pair && cmp(obj, pair.car)) return pair;
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
    return deepEqual(a, b);
  },

  // ============================================================================
  // R7RS Vector functions (Section 6.8)
  // ============================================================================

  "make-vector"(k: unknown, fill?: unknown): unknown[] {
    const len = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    const arr = Array.from({ length: len });
    if (fill !== undefined) {
      arr.fill(fill);
    }
    // Vectors are raw JS arrays — no AValue surface to stamp provenance on.
    // Elements (if AValues) carry their own provenance individually; the
    // container is provenance-transparent. Same for `vector`, `vector-copy`,
    // and bytevector ops below.
    return arr;
  },

  vector(...objs: unknown[]): unknown[] {
    return [...objs];
  },

  "vector?"(obj: unknown): boolean {
    return Array.isArray(obj);
  },

  "vector-length"(vec: unknown): number {
    TypeError.invariant(Array.isArray(vec), "vector-length: expected vector");
    return vec.length;
  },

  "vector-ref"(vec: unknown, k: unknown): unknown {
    TypeError.invariant(Array.isArray(vec), "vector-ref: expected vector");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    return vec[idx as number];
  },

  "vector-set!"(vec: unknown, k: unknown, obj: unknown): void {
    TypeError.invariant(Array.isArray(vec), "vector-set!: expected vector");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    vec[idx as number] = obj;
  },

  "vector->list"(vec: unknown, start?: unknown, end?: unknown): unknown {
    TypeError.invariant(Array.isArray(vec), "vector->list: expected vector");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? vec.length : toIndex(end);
    return Pair.fromArray(vec.slice(s, e));
  },

  "list->vector"(list: unknown): unknown[] {
    const result: unknown[] = [];
    let current = list;
    while (current instanceof Pair) {
      result.push(current.car);
      current = current.cdr;
    }
    return result;
  },

  "vector-fill!"(vec: unknown, fill: unknown, start?: unknown, end?: unknown): void {
    TypeError.invariant(Array.isArray(vec), "vector-fill!: expected vector");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? vec.length : toIndex(end);
    for (let i = s; i < e; i++) {
      vec[i] = fill;
    }
  },

  "vector->string"(vec: unknown, start?: unknown, end?: unknown): string {
    TypeError.invariant(Array.isArray(vec), "vector->string: expected vector");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? vec.length : toIndex(end);
    let result = "";
    for (let i = s; i < e; i++) {
      const ch = vec[i];
      result += ch instanceof SchemeCharacter ? charValue(ch) : String(ch);
    }
    return result;
  },

  "string->vector"(str: unknown, start?: unknown, end?: unknown): unknown[] {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    const result: unknown[] = [];
    for (let i = s; i < e; i++) {
      result.push(new SchemeCharacter(s_str[i]));
    }
    return result;
  },

  "vector-copy"(vec: unknown, start?: unknown, end?: unknown): unknown[] {
    TypeError.invariant(Array.isArray(vec), "vector-copy: expected vector");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? vec.length : toIndex(end);
    return vec.slice(s, e);
  },

  "vector-copy!"(to: unknown, at: unknown, from: unknown, start?: unknown, end?: unknown): void {
    TypeError.invariant(Array.isArray(to), "vector-copy: expected vector");
    TypeError.invariant(Array.isArray(from), "vector-copy: expected vector");
    const atIdx = toIndex(at);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? from.length : toIndex(end);
    // Handle overlapping copies correctly by copying to temp array first
    // R7RS requires behavior as if source was copied to temp storage first
    if (to === from && atIdx > s && atIdx < e) {
      // Overlapping copy where destination is ahead of source - use temp
      const temp = from.slice(s, e);
      for (let i = 0, j = atIdx; i < temp.length; i++, j++) {
        to[j] = temp[i];
      }
    } else {
      for (let i = s, j = atIdx; i < e; i++, j++) {
        to[j] = from[i];
      }
    }
  },

  "vector-map"(proc: Function, ...vectors: unknown[]): unknown[] {
    invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
    const arrays = vectors.map((v) => {
      TypeError.invariant(Array.isArray(v), `vector-map: expected vector, got ${typeof v}`);
      return v;
    });
    const minLen = Math.min(...arrays.map((a) => a.length));
    const result: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      result.push(proc(...elements));
    }
    return result;
  },

  "vector-for-each"(proc: Function, ...vectors: unknown[]): void {
    invariant(vectors.length > 0, "vector-for-each: expected at least one vector argument");
    const arrays = vectors.map((v) => {
      TypeError.invariant(Array.isArray(v), `vector-for-each: expected vector, got ${typeof v}`);
      return v;
    });
    const minLen = Math.min(...arrays.map((a) => a.length));
    for (let i = 0; i < minLen; i++) {
      const elements = arrays.map((a) => a[i]);
      proc(...elements);
    }
  },

  // ============================================================================
  // R7RS Bytevector functions (Section 6.9)
  // Polymorphic: works with Uint8Array, ArrayBuffer, DataView, Node Buffer
  // ============================================================================

  "bytevector?"(obj: unknown): boolean {
    return (
      obj instanceof Uint8Array ||
      obj instanceof ArrayBuffer ||
      obj instanceof DataView ||
      (typeof Buffer !== "undefined" && obj instanceof Buffer)
    );
  },

  "make-bytevector"(k: unknown, byte?: unknown): Uint8Array {
    const arr = new Uint8Array(toIndex(k));
    if (byte !== undefined) {
      arr.fill(toIndex(byte));
    }
    return arr;
  },

  bytevector(...bytes: unknown[]): Uint8Array {
    const result = new Uint8Array(bytes.length);
    for (const [i, b] of bytes.entries()) {
      result[i] = toIndex(b);
    }
    return result;
  },

  "bytevector-length"(bv: unknown): number {
    const view = asBytevector(bv, "bytevector-length");
    return view.byteLength;
  },

  "bytevector-u8-ref"(bv: unknown, k: unknown): number {
    const view = asBytevector(bv, "bytevector-u8-ref");
    return view[toIndex(k)];
  },

  "bytevector-u8-set!"(bv: unknown, k: unknown, byte: unknown): void {
    const view = asBytevector(bv, "bytevector-u8-set!");
    view[toIndex(k)] = toIndex(byte);
  },

  "bytevector-copy"(bv: unknown, start?: unknown, end?: unknown): Uint8Array {
    const view = asBytevector(bv, "bytevector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return view.slice(s, e);
  },

  "bytevector-copy!"(to: unknown, at: unknown, from: unknown, start?: unknown, end?: unknown): void {
    const target = asBytevector(to, "bytevector-copy!");
    const source = asBytevector(from, "bytevector-copy!");
    const atIdx = toIndex(at);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? source.byteLength : toIndex(end);
    target.set(source.subarray(s, e), atIdx);
  },

  "bytevector-append"(...bvs: unknown[]): Uint8Array {
    const views = bvs.map((bv) => asBytevector(bv, "bytevector-append"));
    const totalLen = views.reduce((sum, v) => sum + v.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const view of views) {
      result.set(view, offset);
      offset += view.byteLength;
    }
    return result;
  },

  "utf8->string"(bv: unknown, start?: unknown, end?: unknown): string {
    const view = asBytevector(bv, "utf8->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return new TextDecoder("utf-8").decode(view.subarray(s, e));
  },

  "string->utf8"(str: unknown, start?: unknown, end?: unknown): Uint8Array {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    return new TextEncoder().encode(s_str.slice(s, e));
  },

  // ============================================================================
  // R7RS String functions (Section 6.7)
  // ============================================================================

  "string-map"(proc: Function, ...strings: unknown[]): string {
    invariant(strings.length > 0, "string-map: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    let result = "";
    for (let i = 0; i < minLen; i++) {
      const chars = strs.map((s) => new SchemeCharacter(s[i]));
      const newChar = proc(...chars);
      if (newChar instanceof SchemeCharacter) {
        result += charValue(newChar);
      } else if (typeof newChar === "string") {
        result += newChar;
      } else {
        result += String(newChar);
      }
    }
    return result;
  },

  "string-for-each"(proc: Function, ...strings: unknown[]): void {
    invariant(strings.length > 0, "string-for-each: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    for (let i = 0; i < minLen; i++) {
      proc(...strs.map((s) => new SchemeCharacter(s[i])));
    }
  },

  // ============================================================================
  // R7RS eval (Section 6.12)
  // ============================================================================

  eval(expr: unknown, env?: Environment): unknown {
    return evaluate(expr, { env: env || lipsGlobalEnv });
  },

  // ============================================================================
  // List Utilities (moved from bootstrap.scm)
  // ============================================================================

  single(list: unknown): boolean {
    return list instanceof Pair && list.cdr === nil;
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
  // Higher-Order Utilities (moved from bootstrap.scm)
  // ============================================================================

  complement(fn: Function): Function {
    const result = (...args: unknown[]) => !fn(...args);
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
 * Get all wrapped operators as an object suitable for spreading into global_env
 */
export function getNumericBindings(): Record<string, unknown> {
  return { ...wrappedOps };
}

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
let bridgeInitialized = false;
let bootstrapPromise: Promise<void> | null = null;

export function initBridge(): Promise<void> {
  if (bridgeInitialized && bootstrapPromise) return bootstrapPromise;
  bridgeInitialized = true;

  // Apply TypeScript bindings synchronously
  applyToEnvironment(lipsGlobalEnv);

  // Evaluate bootstrap Scheme code asynchronously
  bootstrapPromise = exec(BOOTSTRAP_SCHEME).then(() => {});
  return bootstrapPromise;
}
