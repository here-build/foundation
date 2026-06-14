/**
 * Numeric Operators
 *
 * R7RS-compatible numeric operations implemented via the membrane pattern.
 * Each operator declares its type boundary via profunctors.
 */

import type { Codec } from "../membrane.js";
import { AnyNum, Bool, Environment, Int, Num, Operator, SafeInt } from "../membrane.js";
import type { SchemeNumeric } from "../numbers.js";
import { bigintISqrt, SchemeExact, SchemeInexact } from "../numbers.js";
import invariant from "tiny-invariant";

// ============================================================================
// Special Profunctor for Type Predicates
// ============================================================================

/**
 * Passthrough profunctor - keeps SchemeNumeric without JS conversion
 * Used for type predicates that need to inspect the Scheme type directly
 */
const SchemeNum: Codec<SchemeNumeric, SchemeNumeric> = {
  match(v): v is SchemeNumeric {
    return v instanceof SchemeExact || v instanceof SchemeInexact;
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

/**
 * Any value profunctor - accepts anything for number? predicate
 */
const Any: Codec<unknown, unknown> = {
  match(_v): _v is unknown {
    return true;
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ============================================================================
// Arithmetic Operators
// ============================================================================

/**
 * Helper to add two SchemeNumbers preserving exactness
 */
function schemeAdd(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
  // If either is inexact, result is inexact
  if (a instanceof SchemeInexact || b instanceof SchemeInexact) {
    const aVal = a instanceof SchemeExact ? a.valueOf() : a.real;
    const bVal = b instanceof SchemeExact ? b.valueOf() : b.real;
    const aImag = a instanceof SchemeInexact ? a.imag : 0;
    const bImag = b instanceof SchemeInexact ? b.imag : 0;
    return new SchemeInexact(aVal + bVal, aImag + bImag);
  }
  // Both exact
  return (a as SchemeExact).add(b as SchemeExact);
}

/** (+ . numbers) - Sums all numbers. Returns 0 if no arguments. */
export const add = Operator.create("+", {
  in: [],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (...args) => {
    if (args.length === 0) return new SchemeExact(0n);
    return args.reduce(schemeAdd);
  },
});

/**
 * Helper to subtract two SchemeNumbers preserving exactness
 */
function schemeSub(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
  if (a instanceof SchemeInexact || b instanceof SchemeInexact) {
    const aVal = a instanceof SchemeExact ? a.valueOf() : a.real;
    const bVal = b instanceof SchemeExact ? b.valueOf() : b.real;
    const aImag = a instanceof SchemeInexact ? a.imag : 0;
    const bImag = b instanceof SchemeInexact ? b.imag : 0;
    return new SchemeInexact(aVal - bVal, aImag - bImag);
  }
  return (a as SchemeExact).sub(b as SchemeExact);
}

/**
 * Helper to negate a SchemeNumeric preserving exactness
 */
function schemeNegate(a: SchemeNumeric): SchemeNumeric {
  if (a instanceof SchemeInexact) {
    return new SchemeInexact(-a.real, -a.imag);
  }
  return new SchemeExact(-a.num, a.denom);
}

/**
 * Helper to multiply two SchemeNumbers preserving exactness
 */
function schemeMul(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
  if (a instanceof SchemeInexact || b instanceof SchemeInexact) {
    const aVal = a instanceof SchemeExact ? a.valueOf() : a.real;
    const bVal = b instanceof SchemeExact ? b.valueOf() : b.real;
    const aImag = a instanceof SchemeInexact ? a.imag : 0;
    const bImag = b instanceof SchemeInexact ? b.imag : 0;
    // (a + bi)(c + di) = (ac - bd) + (ad + bc)i
    return new SchemeInexact(aVal * bVal - aImag * bImag, aVal * bImag + aImag * bVal);
  }
  return (a as SchemeExact).mul(b as SchemeExact);
}

/**
 * Helper to divide two SchemeNumbers preserving exactness
 */
function schemeDiv(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
  if (a instanceof SchemeInexact || b instanceof SchemeInexact) {
    const aVal = a instanceof SchemeExact ? a.valueOf() : a.real;
    const bVal = b instanceof SchemeExact ? b.valueOf() : b.real;
    const aImag = a instanceof SchemeInexact ? a.imag : 0;
    const bImag = b instanceof SchemeInexact ? b.imag : 0;
    // (a + bi)/(c + di) = ((ac + bd) + (bc - ad)i) / (c² + d²)
    const denom = bVal * bVal + bImag * bImag;
    return new SchemeInexact((aVal * bVal + aImag * bImag) / denom, (aImag * bVal - aVal * bImag) / denom);
  }
  // Both exact - returns inexact if not evenly divisible
  // If result is a non-integer rational, keep exact. Otherwise convert to inexact for consistency
  return (a as SchemeExact).div(b as SchemeExact);
}

/** (- n1 n2 ...) - Subtracts numbers from n1. (- n) negates n. */
export const sub = new Operator("-", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    if (rest.length === 0) return schemeNegate(first);
    return rest.reduce(schemeSub, first);
  },
});

/** (* . numbers) - Multiplies all numbers. Returns 1 if no arguments. */
export const mul = Operator.create("*", {
  in: [],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (...args) => {
    if (args.length === 0) return new SchemeExact(1n);
    return args.reduce(schemeMul);
  },
});

/** (/ n1 n2 ...) - Divides n1 by subsequent numbers. (/ n) returns 1/n. */
export const div = new Operator("/", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    if (rest.length === 0) {
      // (/ n) = 1/n
      return schemeDiv(new SchemeExact(1n), first);
    }
    return rest.reduce(schemeDiv, first);
  },
});

/**
 * Convert SchemeNumeric to integer value (bigint for exact, number for inexact).
 * Throws if not an integer.
 */
function toInteger(n: SchemeNumeric, opName: string): { value: bigint | number; exact: boolean } {
  if (n instanceof SchemeExact) {
    TypeError.invariant(n.denom === 1n, `${opName}: not an integer`);
    return { value: n.num, exact: true };
  } else {
    TypeError.invariant(n.imag === 0 && Number.isInteger(n.real), `${opName}: not an integer`);
    return { value: n.real, exact: false };
  }
}

/**
 * Extract an integer pair preserving exactness, WITHOUT collapsing exact
 * bigints through Number(). Exact integers stay bigint, so the integer
 * division family (remainder, modulo, floor-/truncate- quotient and
 * remainder) is precise beyond 2^53 — matching `quotient` which already
 * computes on bigint. When either
 * operand is inexact, both are coerced to JS number (precision already gone).
 */
function toIntegerPair(
  a: SchemeNumeric,
  b: SchemeNumeric,
  opName: string,
): { bothExact: true; av: bigint; bv: bigint } | { bothExact: false; av: number; bv: number } {
  const ai = toInteger(a, opName);
  const bi = toInteger(b, opName);
  if (ai.exact && bi.exact) {
    return { bothExact: true, av: ai.value as bigint, bv: bi.value as bigint };
  }
  // At least one inexact: both become JS numbers (the inexact value already is).
  const av = ai.exact ? Number(ai.value) : (ai.value as number);
  const bv = bi.exact ? Number(bi.value) : (bi.value as number);
  return { bothExact: false, av, bv };
}

/**
 * Floor division on bigints (round toward negative infinity). JS `/` on bigint
 * truncates toward zero; adjust by −1 when the operands have opposite signs and
 * the division is inexact.
 */
function bigintFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b !== 0n && (a < 0n) !== (b < 0n)) {
    return q - 1n;
  }
  return q;
}

/** (quotient n1 n2) - Integer quotient, truncated toward zero. */
export const quotient = new Operator("quotient", {
  in: [Int, Int],
  out: Int,
  fn: (a: bigint, b: bigint): bigint => {
    invariant(b != 0n, "quotient: division by zero");
    // Truncate toward zero: use JS bigint division which already truncates toward zero
    return a / b;
  },
});

/** (remainder n1 n2) - Remainder of truncating division. */
export const remainder = new Operator("remainder", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "remainder");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "remainder: division by zero");
      // JS bigint % truncates toward zero → matches R7RS truncating remainder.
      return new SchemeExact(p.av % p.bv);
    }
    return new SchemeInexact(p.av % p.bv);
  },
});

/** (modulo n1 n2) - Modulo (always same sign as divisor). */
export const modulo = new Operator("modulo", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "modulo");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "modulo: division by zero");
      return new SchemeExact(((p.av % p.bv) + p.bv) % p.bv);
    }
    return new SchemeInexact(((p.av % p.bv) + p.bv) % p.bv);
  },
});

/** (floor-quotient n1 n2) - Quotient rounded toward negative infinity. */
export const floorQuotient = new Operator("floor-quotient", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "floor-quotient");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "floor-quotient: division by zero");
      return new SchemeExact(bigintFloorDiv(p.av, p.bv));
    }
    return new SchemeInexact(Math.floor(p.av / p.bv));
  },
});

/** (floor-remainder n1 n2) - Remainder of floor division. */
export const floorRemainder = new Operator("floor-remainder", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "floor-remainder");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "floor-remainder: division by zero");
      // a - floor(a/b)*b ≡ ((a % b) + b) % b (always same sign as divisor).
      return new SchemeExact(((p.av % p.bv) + p.bv) % p.bv);
    }
    const q = Math.floor(p.av / p.bv);
    return new SchemeInexact(p.av - q * p.bv);
  },
});

/** (truncate-quotient n1 n2) - Quotient truncated toward zero. */
export const truncateQuotient = new Operator("truncate-quotient", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "truncate-quotient");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "truncate-quotient: division by zero");
      // JS bigint / truncates toward zero.
      return new SchemeExact(p.av / p.bv);
    }
    return new SchemeInexact(Math.trunc(p.av / p.bv));
  },
});

/** (truncate-remainder n1 n2) - Remainder of truncating division. */
export const truncateRemainder = new Operator("truncate-remainder", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: (a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric => {
    const p = toIntegerPair(a, b, "truncate-remainder");
    if (p.bothExact) {
      invariant(p.bv !== 0n, "truncate-remainder: division by zero");
      return new SchemeExact(p.av % p.bv);
    }
    return new SchemeInexact(p.av % p.bv);
  },
});

/** (abs x) - Absolute value. */
export const abs = new Operator("abs", {
  in: [AnyNum],
  out: AnyNum,
  fn: (x) => (typeof x === "bigint" ? (x < 0n ? -x : x) : Math.abs(x)),
});

/**
 * Binary GCD (Euclidean algorithm) with absolute value handling
 */
function gcd2(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** (gcd . integers) - Greatest common divisor (always non-negative). */
export const gcd = Operator.create("gcd", {
  in: [],
  inRest: Int,
  out: Int,
  fn: (...args) => {
    if (args.length === 0) return 0n;
    // R7RS § 6.2.6: gcd always returns a non-negative result. gcd2 abs's both
    // operands, but a single-arg reduce would return the raw (possibly
    // negative) element — seed with 0n so even `(gcd -4)` is normalized.
    return args.reduce(gcd2, 0n);
  },
});

/** (lcm . integers) - Least common multiple (always non-negative). */
export const lcm = Operator.create("lcm", {
  in: [],
  inRest: Int,
  out: Int,
  fn: (...args) => {
    if (args.length === 0) return 1n;
    const lcm2 = (a: bigint, b: bigint): bigint => {
      const g = gcd2(a, b);
      return g === 0n ? 0n : (a / g) * b;
    };
    // Seed with 1n and abs each operand so the result is non-negative even for
    // a single negative argument, e.g. `(lcm -6)` ⇒ 6.
    return args.reduce((a, b) => lcm2(a, b < 0n ? -b : b), 1n);
  },
});

/**
 * (expt base power) - Exponentiation.
 *
 * R7RS § 6.2.6: when both arguments are exact and the result is exactly
 * representable, the result is exact. The old `fn: Math.pow` round-tripped
 * everything through a JS double, so `(expt 2 1000)` returned a lossy
 * ~1.07e+301 inexact and `(expt 2 -1)` returned 0.5 instead of the exact 1/2.
 * We now special-case an exact base raised to an exact INTEGER power and
 * compute it with BigInt `**` (exact rational for negative powers), falling
 * back to `Math.pow` only when an operand is inexact or the exponent is a
 * non-integer rational (where the result genuinely isn't exact-representable).
 */
function schemeExpt(base: SchemeNumeric, power: SchemeNumeric): SchemeNumeric {
  if (
    base instanceof SchemeExact &&
    power instanceof SchemeExact &&
    power.denom === 1n // integer exponent only — rational exponents go inexact
  ) {
    const n = power.num;
    if (n >= 0n) {
      // (p/q)^n = p^n / q^n. SchemeExact normalizes/reduces.
      return new SchemeExact(base.num ** n, base.denom ** n);
    }
    // Negative exponent → reciprocal: (p/q)^(-m) = q^m / p^m. Guard 0 base.
    invariant(base.num !== 0n, "expt: division by zero (0 raised to a negative power)");
    const m = -n;
    return new SchemeExact(base.denom ** m, base.num ** m);
  }
  // Inexact (or non-integer exponent): float exponentiation is correct here.
  return new SchemeInexact(Math.pow(toReal(base, "expt"), toReal(power, "expt")));
}

export const expt = new Operator("expt", {
  in: [SchemeNum, SchemeNum],
  out: SchemeNum,
  fn: schemeExpt,
});

// ============================================================================
// Comparison Operators
// ============================================================================

/**
 * Compare two SchemeNumeric values for equality.
 * Handles exact/inexact and complex numbers properly.
 */
function schemeNumEq(a: SchemeNumeric, b: SchemeNumeric): boolean {
  // Both exact
  if (a instanceof SchemeExact && b instanceof SchemeExact) {
    return a.cmp(b) === 0;
  }
  // Both inexact
  if (a instanceof SchemeInexact && b instanceof SchemeInexact) {
    return a.real === b.real && a.imag === b.imag;
  }
  // Mixed: compare as inexact (convert exact to float)
  const aReal = a instanceof SchemeExact ? Number(a.num) / Number(a.denom) : a.real;
  const bReal = b instanceof SchemeExact ? Number(b.num) / Number(b.denom) : b.real;
  const aImag = a instanceof SchemeInexact ? a.imag : 0;
  const bImag = b instanceof SchemeInexact ? b.imag : 0;
  return aReal === bReal && aImag === bImag;
}

/** (= n1 n2 ...) - Returns #t if all numbers are equal. */
export const numEq = new Operator("=", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: Bool,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    return rest.every((x) => schemeNumEq(first, x));
  },
});

/**
 * Get real value from SchemeNumeric. Throws if complex with non-zero imaginary.
 */
function toReal(n: SchemeNumeric, opName: string): number {
  if (n instanceof SchemeExact) {
    return Number(n.num) / Number(n.denom);
  }
  TypeError.invariant(n.imag === 0, `${opName}: not a real number`);
  return n.real;
}

/**
 * Three-way comparison of two reals: -1 / 0 / 1, or NaN if incomparable
 * (either operand is a NaN inexact). The exact/exact case routes through
 * `SchemeExact.cmp` (bigint cross-multiplication) instead of coercing to a
 * JS double — that float coercion was the source of the R7RS bug where
 * `(< 999999999999999998 999999999999999999)` returned #f: both 18-digit
 * integers collapse to the same double (1e18), so `prev < curr` was false.
 * Only when at least one side is inexact do we fall back to `toReal`, where
 * the precision is already gone and float comparison is the correct semantics
 * (and NaN naturally propagates → every comparison against it is #f).
 */
function schemeCompare(a: SchemeNumeric, b: SchemeNumeric, opName: string): number {
  if (a instanceof SchemeExact && b instanceof SchemeExact) {
    return a.cmp(b);
  }
  const ar = toReal(a, opName);
  const br = toReal(b, opName);
  if (ar < br) return -1;
  if (ar > br) return 1;
  if (ar === br) return 0;
  return Number.NaN; // a NaN operand → incomparable; all chained tests fail
}

/** (< n1 n2 ...) - Returns #t if arguments are in strictly increasing order. */
export const lt = new Operator("<", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: Bool,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    let prev = first;
    for (const x of rest) {
      if (!(schemeCompare(prev, x, "<") < 0)) return false;
      prev = x;
    }
    return true;
  },
});

/** (> n1 n2 ...) - Returns #t if arguments are in strictly decreasing order. */
export const gt = new Operator(">", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: Bool,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    let prev = first;
    for (const x of rest) {
      if (!(schemeCompare(prev, x, ">") > 0)) return false;
      prev = x;
    }
    return true;
  },
});

/** (<= n1 n2 ...) - Returns #t if arguments are in non-decreasing order. */
export const lte = new Operator("<=", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: Bool,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    let prev = first;
    for (const x of rest) {
      // NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is false ⇒ short-circuit.
      if (!(schemeCompare(prev, x, "<=") <= 0)) return false;
      prev = x;
    }
    return true;
  },
});

/** (>= n1 n2 ...) - Returns #t if arguments are in non-increasing order. */
export const gte = new Operator(">=", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: Bool,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]) => {
    let prev = first;
    for (const x of rest) {
      if (!(schemeCompare(prev, x, ">=") >= 0)) return false;
      prev = x;
    }
    return true;
  },
});

/** (max n1 n2 ...) - Returns the maximum of the arguments. */
export const max = new Operator("max", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]): SchemeNumeric => {
    // R7RS § 6.2.6: if any argument is inexact, the result is inexact —
    // exactness is contagious even when the chosen value was exact.
    // (max 3 3.0) ⇒ 3.0. Compare via schemeCompare so huge exacts don't
    // collapse through a float.
    let extreme = first;
    let hasInexact = first instanceof SchemeInexact;
    for (const x of rest) {
      if (x instanceof SchemeInexact) hasInexact = true;
      if (schemeCompare(x, extreme, "max") > 0) extreme = x;
    }
    return hasInexact && extreme instanceof SchemeExact ? extreme.toInexact() : extreme;
  },
});

/** (min n1 n2 ...) - Returns the minimum of the arguments. */
export const min = new Operator("min", {
  in: [SchemeNum],
  inRest: SchemeNum,
  out: SchemeNum,
  fn: (first: SchemeNumeric, ...rest: SchemeNumeric[]): SchemeNumeric => {
    let extreme = first;
    let hasInexact = first instanceof SchemeInexact;
    for (const x of rest) {
      if (x instanceof SchemeInexact) hasInexact = true;
      if (schemeCompare(x, extreme, "min") < 0) extreme = x;
    }
    return hasInexact && extreme instanceof SchemeExact ? extreme.toInexact() : extreme;
  },
});

// ============================================================================
// Predicates
// ============================================================================

/** (zero? n) - Returns #t if n is zero. */
export const isZero = new Operator("zero?", {
  in: [AnyNum],
  out: Bool,
  fn: (x) => x === 0 || x === 0n,
});

/** (positive? n) - Returns #t if n is positive. */
export const isPositive = new Operator("positive?", {
  in: [AnyNum],
  out: Bool,
  fn: (x) => (typeof x === "bigint" ? x > 0n : x > 0),
});

/** (negative? n) - Returns #t if n is negative. */
export const isNegative = new Operator("negative?", {
  in: [AnyNum],
  out: Bool,
  fn: (x) => (typeof x === "bigint" ? x < 0n : x < 0),
});

/** (odd? n) - Returns #t if n is odd. */
export const isOdd = new Operator("odd?", {
  in: [Int],
  out: Bool,
  fn: (x) => x % 2n !== 0n,
});

/** (even? n) - Returns #t if n is even. */
export const isEven = new Operator("even?", {
  in: [Int],
  out: Bool,
  fn: (x) => x % 2n === 0n,
});

/** (nan? n) - Returns #t if n is NaN. */
export const isNan = new Operator("nan?", {
  in: [Num],
  out: Bool,
  fn: Number.isNaN,
});

/** (finite? n) - Returns #t if n is finite. */
export const isFinite = new Operator("finite?", {
  in: [Num],
  out: Bool,
  fn: Number.isFinite,
});

/** (infinite? n) - Returns #t if n is infinite. */
export const isInfinite = new Operator("infinite?", {
  in: [Num],
  out: Bool,
  fn: (x) => x === Infinity || x === -Infinity,
});

// ============================================================================
// R7RS Type Predicates (Tower Predicates)
// ============================================================================

/** number? - true for any number */
export const isNumber = new Operator("number?", {
  in: [Any],
  out: Bool,
  fn: (x) => x instanceof SchemeExact || x instanceof SchemeInexact,
});

/**
 * R7RS § 6.2.6: the tower-type predicates (complex?/real?/rational?/integer?)
 * are total over the whole value domain — applied to a non-number they return
 * #f, NOT an error. They take `Any` (not `SchemeNum`) so the codec doesn't
 * reject non-numerics before the predicate runs.
 */
const isNum = (x: unknown): x is SchemeNumeric => x instanceof SchemeExact || x instanceof SchemeInexact;

/** complex? - true for all numbers (all numbers are complex in Scheme), #f otherwise. */
export const isComplex = new Operator("complex?", {
  in: [Any],
  out: Bool,
  fn: (x) => isNum(x) && x.isComplex,
});

/** real? - true for numbers with zero imaginary part, #f for non-numbers. */
export const isReal = new Operator("real?", {
  in: [Any],
  out: Bool,
  fn: (x) => isNum(x) && x.isReal,
});

/** rational? - true for rational numbers, #f for non-numbers. */
export const isRational = new Operator("rational?", {
  in: [Any],
  out: Bool,
  fn: (x) => isNum(x) && x.isRational,
});

/** integer? - true for integer values (exact or inexact), #f for non-numbers. */
export const isInteger = new Operator("integer?", {
  in: [Any],
  out: Bool,
  fn: (x) => isNum(x) && x.isInteger,
});

/** exact? - true for exact numbers. (R7RS: requires a number — keep strict.) */
export const isExact = new Operator("exact?", {
  in: [SchemeNum],
  out: Bool,
  fn: (x) => x.isExact,
});

/** inexact? - true for inexact numbers. (R7RS: requires a number — keep strict.) */
export const isInexact = new Operator("inexact?", {
  in: [SchemeNum],
  out: Bool,
  fn: (x) => !x.isExact,
});

/** exact-integer? - true for exact integers, #f for non-numbers. */
export const isExactInteger = new Operator("exact-integer?", {
  in: [Any],
  out: Bool,
  fn: (x) => isNum(x) && x.isExact && x.isInteger,
});

// ============================================================================
// Rounding
// ============================================================================

/** (floor n) - Returns the largest integer not greater than n. */
export const floor = new Operator("floor", {
  in: [Num],
  out: Num,
  fn: Math.floor,
});

/** (ceiling n) - Returns the smallest integer not less than n. */
export const ceiling = new Operator("ceiling", {
  in: [Num],
  out: Num,
  fn: Math.ceil,
});

/** (truncate n) - Returns the integer closest to n toward zero. */
export const truncate = new Operator("truncate", {
  in: [Num],
  out: Num,
  fn: Math.trunc,
});

/** (round n) - Returns the closest integer to n, rounding to even on ties. */
export const round = new Operator("round", {
  in: [Num],
  out: Num,
  fn: (x) => {
    // R7RS: round to even on ties (banker's rounding)
    const floored = Math.floor(x);
    const ceiled = Math.ceil(x);

    // Not exactly halfway - return closest
    const diff = x - floored;
    if (diff < 0.5) return floored;
    if (diff > 0.5) return ceiled;

    // Exactly halfway (diff === 0.5): round to even
    // Check which candidate is even (works for both positive and negative)
    // -4 % 2 === 0 (even), -5 % 2 === -1 (odd)
    if (floored % 2 === 0) return floored;
    return ceiled;
  },
});

// ============================================================================
// Transcendentals
// ============================================================================

// ============================================================================
// Rational Accessors
// ============================================================================

/**
 * Convert a float to an exact rational (num/denom).
 * Uses decimal string representation for simplicity.
 */
function floatToRational(x: number): { num: bigint; denom: bigint } {
  invariant(Number.isFinite(x), "numerator/denominator requires a finite number");
  if (Number.isInteger(x)) {
    return { num: BigInt(x), denom: 1n };
  }
  // Convert via decimal representation
  const str = x.toString();
  const dotIndex = str.indexOf(".");
  if (dotIndex === -1) {
    return { num: BigInt(x), denom: 1n };
  }
  const decimals = str.length - dotIndex - 1;
  const denom = 10n ** BigInt(decimals);
  const num = BigInt(str.replace(".", "").replace(/^-/, ""));
  const sign = x < 0 ? -1n : 1n;
  // Reduce the fraction
  const g = gcd2(num < 0n ? -num : num, denom);
  return { num: (sign * num) / g, denom: denom / g };
}

/** (numerator q) - Returns the numerator of the rational number q. */
export const numerator = new Operator("numerator", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      return new SchemeExact(x.num);
    }
    // For inexact, convert to rational and return inexact numerator
    if (x instanceof SchemeInexact && x.imag === 0) {
      const { num } = floatToRational(x.real);
      return new SchemeInexact(Number(num));
    }
    invariant(false, "numerator requires a rational number");
  },
});

/** (denominator q) - Returns the denominator of the rational number q. */
export const denominator = new Operator("denominator", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      return new SchemeExact(x.denom);
    }
    // For inexact, convert to rational and return inexact denominator
    if (x instanceof SchemeInexact && x.imag === 0) {
      const { denom } = floatToRational(x.real);
      return new SchemeInexact(Number(denom));
    }
    invariant(false, "denominator requires a rational number");
  },
});

// ============================================================================
// Complex Number Operations
// ============================================================================

/** (make-rectangular x y) - Returns a complex number with real part x and imaginary part y. */
export const makeRectangular = new Operator("make-rectangular", {
  in: [Num, Num],
  out: SchemeNum,
  fn: (re, im): SchemeNumeric => new SchemeInexact(re, im),
});

/** (make-polar magnitude angle) - Returns a complex number with the given magnitude and angle. */
export const makePolar = new Operator("make-polar", {
  in: [Num, Num],
  out: SchemeNum,
  fn: (magnitude, angle): SchemeNumeric => {
    const re = magnitude * Math.cos(angle);
    const im = magnitude * Math.sin(angle);
    return new SchemeInexact(re, im);
  },
});

/** (real-part z) - Returns the real part of the complex number z. */
export const realPart = new Operator("real-part", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      return x;
    }
    // For complex numbers, return the real part
    // If it's an integer, return exact
    if (Number.isInteger(x.real) && Number.isSafeInteger(x.real)) {
      return new SchemeExact(BigInt(x.real));
    }
    return new SchemeInexact(x.real);
  },
});

/** (imag-part z) - Returns the imaginary part of the complex number z. */
export const imagPart = new Operator("imag-part", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      return new SchemeExact(0n);
    }
    // Return the imaginary part
    if (Number.isInteger(x.imag) && Number.isSafeInteger(x.imag)) {
      return new SchemeExact(BigInt(x.imag));
    }
    return new SchemeInexact(x.imag);
  },
});

/** (magnitude z) - Returns the magnitude (absolute value) of the complex number z. */
export const magnitude = new Operator("magnitude", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      const val = x.valueOf();
      return new SchemeInexact(Math.abs(val));
    }
    // |a + bi| = sqrt(a^2 + b^2)
    const mag = Math.hypot(x.real, x.imag);
    return new SchemeInexact(mag);
  },
});

/** (angle z) - Returns the angle (argument) of the complex number z. */
export const angle = new Operator("angle", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    if (x instanceof SchemeExact) {
      const val = x.valueOf();
      return new SchemeInexact(val >= 0 ? 0 : Math.PI);
    }
    return new SchemeInexact(Math.atan2(x.imag, x.real));
  },
});

// ============================================================================
// Transcendentals
// ============================================================================

/** (sqrt n) - Returns the square root of n. */
export const sqrt = new Operator("sqrt", {
  in: [SchemeNum],
  out: SchemeNum,
  fn: (x: SchemeNumeric): SchemeNumeric => {
    // Get the real value
    const val = x instanceof SchemeExact ? x.valueOf() : x.real;

    // For negative real numbers, return complex result (0 + sqrt(-x)i)
    if (x instanceof SchemeExact || (x instanceof SchemeInexact && x.imag === 0)) {
      if (val < 0) {
        return new SchemeInexact(0, Math.sqrt(-val));
      }
      // For exact non-negative integers that are perfect squares, return exact.
      // Use a bigint integer sqrt so squares ≥ 2^53 (where Math.sqrt(Number(n))
      // loses precision and misclassifies) are detected exactly.
      if (x instanceof SchemeExact && x.denom === 1n && x.num >= 0n) {
        const r = bigintISqrt(x.num);
        if (r * r === x.num) {
          return new SchemeExact(r);
        }
      }
      return new SchemeInexact(Math.sqrt(val));
    }

    // For complex numbers, use the formula: sqrt(a+bi) = sqrt((r+a)/2) + i*sign(b)*sqrt((r-a)/2)
    // where r = |z| = sqrt(a^2 + b^2)
    const a = x.real;
    const b = x.imag;
    const r = Math.hypot(a, b);
    const re = Math.sqrt((r + a) / 2);
    const im = (b >= 0 ? 1 : -1) * Math.sqrt((r - a) / 2);
    return new SchemeInexact(re, im);
  },
});

/** (exp n) - Returns e raised to the power n. */
export const exp = new Operator("exp", {
  in: [Num],
  out: Num,
  fn: Math.exp,
});

/** (log z) or (log z base) - Returns the natural logarithm of z, or log base 'base'. */
export const log = new Operator("log", {
  in: [Num],
  inRest: Num,
  out: Num,
  fn: (z, base?) => (base === undefined ? Math.log(z) : Math.log(z) / Math.log(base)),
});

/** (sin n) - Returns the sine of n (in radians). */
export const sin = new Operator("sin", {
  in: [Num],
  out: Num,
  fn: Math.sin,
});

/** (cos n) - Returns the cosine of n (in radians). */
export const cos = new Operator("cos", {
  in: [Num],
  out: Num,
  fn: Math.cos,
});

/** (tan n) - Returns the tangent of n (in radians). */
export const tan = new Operator("tan", {
  in: [Num],
  out: Num,
  fn: Math.tan,
});

/** (asin n) - Returns the arc sine of n. */
export const asin = new Operator("asin", {
  in: [Num],
  out: Num,
  fn: Math.asin,
});

/** (acos n) - Returns the arc cosine of n. */
export const acos = new Operator("acos", {
  in: [Num],
  out: Num,
  fn: Math.acos,
});

/** (atan y) or (atan y x) - Returns the arc tangent of y or y/x. */
export const atan = new Operator("atan", {
  in: [Num],
  inRest: Num,
  out: Num,
  fn: (y, x?) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
});

/** (sinh n) - Returns the hyperbolic sine of n. */
export const sinh = new Operator("sinh", {
  in: [Num],
  out: Num,
  fn: Math.sinh,
});

/** (cosh n) - Returns the hyperbolic cosine of n. */
export const cosh = new Operator("cosh", {
  in: [Num],
  out: Num,
  fn: Math.cosh,
});

/** (tanh n) - Returns the hyperbolic tangent of n. */
export const tanh = new Operator("tanh", {
  in: [Num],
  out: Num,
  fn: Math.tanh,
});

/** (asinh n) - Returns the inverse hyperbolic sine of n. */
export const asinh = new Operator("asinh", {
  in: [Num],
  out: Num,
  fn: Math.asinh,
});

/** (acosh n) - Returns the inverse hyperbolic cosine of n. */
export const acosh = new Operator("acosh", {
  in: [Num],
  out: Num,
  fn: Math.acosh,
});

/** (atanh n) - Returns the inverse hyperbolic tangent of n. */
export const atanh = new Operator("atanh", {
  in: [Num],
  out: Num,
  fn: Math.atanh,
});

// ============================================================================
// Bitwise (integer only)
// ============================================================================

/** (bitwise-and . integers) - Returns the bitwise AND of the arguments. */
export const bitwiseAnd = Operator.create("bitwise-and", {
  in: [],
  inRest: Int,
  out: Int,
  fn: (...args) => {
    if (args.length === 0) return -1n; // all bits set
    return args.reduce((a, b) => a & b);
  },
});

/** (bitwise-ior . integers) - Returns the bitwise inclusive OR of the arguments. */
export const bitwiseIor = Operator.create("bitwise-ior", {
  in: [],
  inRest: Int,
  out: Int,
  fn: (...args) => {
    if (args.length === 0) return 0n;
    return args.reduce((a, b) => a | b);
  },
});

/** (bitwise-xor . integers) - Returns the bitwise exclusive OR of the arguments. */
export const bitwiseXor = Operator.create("bitwise-xor", {
  in: [],
  inRest: Int,
  out: Int,
  fn: (...args) => {
    if (args.length === 0) return 0n;
    return args.reduce((a, b) => a ^ b);
  },
});

/** (bitwise-not n) - Returns the bitwise NOT of n. */
export const bitwiseNot = new Operator("bitwise-not", {
  in: [Int],
  out: Int,
  fn: (x) => ~x,
});

/** (arithmetic-shift n count) - Shifts n left by count bits (or right if count is negative). */
export const arithmeticShift = Operator.create("arithmetic-shift", {
  in: [Int, SafeInt],
  inRest: undefined,
  out: Int,
  fn: (n, count) => (count >= 0 ? n << BigInt(count) : n >> BigInt(-count)),
});

/** (bit-count n) - Returns the number of set bits in n. */
export const bitCount = new Operator("bit-count", {
  in: [Int],
  out: Int,
  fn: (n) => {
    // Count 1 bits (for positive) or 0 bits (for negative)
    if (n < 0n) n = ~n;
    let count = 0n;
    while (n > 0n) {
      count += n & 1n;
      n >>= 1n;
    }
    return count;
  },
});

/** (integer-length n) - Returns the number of bits needed to represent n. */
export const integerLength = new Operator("integer-length", {
  in: [Int],
  out: Int,
  fn: (n) => {
    if (n < 0n) n = ~n;
    let length = 0n;
    while (n > 0n) {
      length++;
      n >>= 1n;
    }
    return length;
  },
});

// ============================================================================
// Export all as array for easy registration
// ============================================================================

export const numericOperators = [
  // Arithmetic
  add,
  sub,
  mul,
  div,
  quotient,
  remainder,
  modulo,
  floorQuotient,
  floorRemainder,
  truncateQuotient,
  truncateRemainder,
  abs,
  gcd,
  lcm,
  expt,
  // Rational accessors
  numerator,
  denominator,
  // Complex operations
  makeRectangular,
  makePolar,
  realPart,
  imagPart,
  magnitude,
  angle,
  // Comparison
  numEq,
  lt,
  gt,
  lte,
  gte,
  max,
  min,
  // Predicates
  isZero,
  isPositive,
  isNegative,
  isOdd,
  isEven,
  isNan,
  isFinite,
  isInfinite,
  // Tower predicates
  isNumber,
  isComplex,
  isReal,
  isRational,
  isInteger,
  isExact,
  isInexact,
  isExactInteger,
  // Rounding
  floor,
  ceiling,
  truncate,
  round,
  // Transcendentals
  sqrt,
  exp,
  log,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  // Bitwise
  bitwiseAnd,
  bitwiseIor,
  bitwiseXor,
  bitwiseNot,
  arithmeticShift,
  bitCount,
  integerLength,
];

// ============================================================================
// Pre-built environments
// ============================================================================

/** Full numeric environment - all operators */
export const fullNumericEnv = new Environment("numeric:full").registerAll(...numericOperators);

/** Rosetta environment - JS-compatible, no bigint-specific ops */
export const rosettaNumericEnv = new Environment("numeric:rosetta").registerAll(
  add,
  sub,
  mul,
  div,
  abs,
  expt,
  numEq,
  lt,
  gt,
  lte,
  gte,
  max,
  min,
  isZero,
  isPositive,
  isNegative,
  isNan,
  isFinite,
  isInfinite,
  floor,
  ceiling,
  truncate,
  round,
  sqrt,
  exp,
  log,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
);
