/**
 * Scheme Numeric Tower Implementation
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ExactNumber class always exists - minimum capability is integers (denom=1)
 * 2. InexactNumber class always exists - minimum capability is reals (imag=0)
 * 3. Classes are constants, behaviors are variables
 * 4. Tower predicates check values, not types: integer ⊂ rational ⊂ real ⊂ complex
 *
 * Two fundamental classes based on exactness:
 * - ExactNumber: arbitrary precision (bigint num/denom), represents integers AND rationals
 * - InexactNumber: floating point (number real/imag), represents reals AND complex
 *
 * Behaviors control what OPERATIONS produce, not what values can exist:
 * - IntegerExact: 1/3 → InexactNumber (demotes non-integer results)
 * - RationalExact: 1/3 → ExactNumber(1n,3n) (keeps exact fractions)
 * - RealInexact: sqrt(-4) → error (rejects complex results)
 * - ComplexInexact: sqrt(-4) → InexactNumber(0,2) (allows complex)
 */
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markAsSandboxBoundary } from "./sandbox-boundary.js";

// ============================================================================
// Type Definitions
// ============================================================================

export type SchemeNumeric = SchemeExact | SchemeInexact;

// ============================================================================
// ExactNumber - Arbitrary Precision (integers and rationals)
// ============================================================================

export class SchemeExact extends AValue {
  static __class__ = "number";
  readonly kind = "number" as const;

  readonly num: bigint;
  readonly denom: bigint;

  constructor(num: bigint, denom: bigint = 1n, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    // Normalize: keep denom positive, reduce to lowest terms
    invariant(denom != 0n, "Division by zero");
    if (denom < 0n) {
      num = -num;
      denom = -denom;
    }
    const g = SchemeExact.gcd(num < 0n ? -num : num, denom);
    this.num = num / g;
    this.denom = denom / g;
  }

  // Tower predicates - check mathematical properties
  get isInteger(): boolean {
    return this.denom === 1n;
  }

  get isRational(): boolean {
    return true; // all exact numbers are rational
  }

  get isReal(): boolean {
    return true; // all rationals are real
  }

  get isComplex(): boolean {
    return true; // all reals are complex
  }

  // Exactness
  get isExact(): boolean {
    return true;
  }

  // Value checks
  get isZero(): boolean {
    return this.num === 0n;
  }

  get isPositive(): boolean {
    return this.num > 0n;
  }

  get isNegative(): boolean {
    return this.num < 0n;
  }

  get isNaN(): boolean {
    return false; // exact numbers are never NaN
  }

  get isFinite(): boolean {
    return true; // exact numbers are always finite
  }

  private static gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  // Conversion to JS
  valueOf(): number {
    return Number(this.num) / Number(this.denom);
  }

  toJS(): number | bigint {
    if (this.denom === 1n) {
      // Return bigint for integers if safe, otherwise number
      if (this.num >= BigInt(Number.MIN_SAFE_INTEGER) && this.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(this.num);
      }
      return this.num;
    }
    return this.valueOf();
  }

  /** AValue contract; aliases existing `toJS` (lowercase). */
  toJs(): number | bigint {
    return this.toJS();
  }

  withProvenance(p: ReadonlySet<number>): SchemeExact {
    return new SchemeExact(this.num, this.denom, p);
  }

  // String representation
  toString(): string {
    if (this.denom === 1n) {
      return this.num.toString();
    }
    return `${this.num}/${this.denom}`;
  }

  // Comparison (same-type)
  cmp(other: SchemeExact): -1 | 0 | 1 {
    const diff = this.num * other.denom - other.num * this.denom;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  equals(other: SchemeExact): boolean {
    return this.num === other.num && this.denom === other.denom;
  }

  // Same-type arithmetic
  add(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom + other.num * this.denom, this.denom * other.denom);
  }

  sub(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom - other.num * this.denom, this.denom * other.denom);
  }

  mul(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.num, this.denom * other.denom);
  }

  div(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom, this.denom * other.num);
  }

  neg(): SchemeExact {
    return new SchemeExact(-this.num, this.denom);
  }

  abs(): SchemeExact {
    return new SchemeExact(this.num < 0n ? -this.num : this.num, this.denom);
  }

  inverse(): SchemeExact {
    return new SchemeExact(this.denom, this.num);
  }

  // Floor, ceiling, truncate, round - return exact integers
  floor(): SchemeExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Floor: round toward negative infinity
    if (this.num < 0n && this.num % this.denom !== 0n) {
      return new SchemeExact(q - 1n);
    }
    return new SchemeExact(q);
  }

  ceiling(): SchemeExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Ceiling: round toward positive infinity
    if (this.num > 0n && this.num % this.denom !== 0n) {
      return new SchemeExact(q + 1n);
    }
    return new SchemeExact(q);
  }

  truncate(): SchemeExact {
    if (this.denom === 1n) return this;
    // Truncate: round toward zero
    return new SchemeExact(this.num / this.denom);
  }

  round(): SchemeExact {
    if (this.denom === 1n) return this;
    // Round to nearest, ties to even
    const q = this.num / this.denom;
    const r = this.num % this.denom;
    const absR = r < 0n ? -r : r;
    const halfDenom = this.denom / 2n;

    if (absR < halfDenom) {
      return new SchemeExact(q);
    } else if (absR > halfDenom) {
      return new SchemeExact(this.num < 0n ? q - 1n : q + 1n);
    } else {
      // Tie: round to even
      if (q % 2n === 0n) {
        return new SchemeExact(q);
      }
      return new SchemeExact(this.num < 0n ? q - 1n : q + 1n);
    }
  }

  // Integer operations (only valid when isInteger)
  mod(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return new SchemeExact(this.num % other.num);
  }

  quotient(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    return new SchemeExact(this.num / other.num);
  }

  gcd(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return new SchemeExact(
      SchemeExact.gcd(this.num < 0n ? -this.num : this.num, other.num < 0n ? -other.num : other.num),
    );
  }

  // Convert to inexact
  toInexact(): SchemeInexact {
    return new SchemeInexact(this.valueOf());
  }
}

// ============================================================================
// InexactNumber - Floating Point (reals and complex)
// ============================================================================

export class SchemeInexact extends AValue {
  static __class__ = "number";
  readonly kind = "number" as const;

  readonly real: number;
  readonly imag: number;

  constructor(real: number, imag: number = 0, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.real = real;
    this.imag = imag;
  }

  // Tower predicates - check mathematical properties
  get isInteger(): boolean {
    return this.imag === 0 && Number.isInteger(this.real);
  }

  get isRational(): boolean {
    // R7RS: All finite real numbers are rational (representable as ratio of integers)
    // IEEE 754 floats are by definition dyadic fractions
    return this.imag === 0 && Number.isFinite(this.real);
  }

  // DEVIATION from R7RS: We treat zero imaginary as real, regardless of whether
  // it was exact (0i) or inexact (0.0i). R7RS says -2.5+0.0i should NOT be real
  // because the imaginary part is inexact. We consider this complexity not worth
  // the implementation cost. Zero is zero.
  get isReal(): boolean {
    return this.imag === 0;
  }

  get isComplex(): boolean {
    return true; // all numbers are complex
  }

  // Exactness
  get isExact(): boolean {
    return false;
  }

  // Value checks
  get isZero(): boolean {
    return this.real === 0 && this.imag === 0;
  }

  get isPositive(): boolean {
    return this.imag === 0 && this.real > 0;
  }

  get isNegative(): boolean {
    return this.imag === 0 && this.real < 0;
  }

  get isNaN(): boolean {
    return Number.isNaN(this.real) || Number.isNaN(this.imag);
  }

  get isFinite(): boolean {
    return Number.isFinite(this.real) && Number.isFinite(this.imag);
  }

  // Magnitude and angle for complex
  get magnitude(): number {
    return Math.hypot(this.real, this.imag);
  }

  get angle(): number {
    return Math.atan2(this.imag, this.real);
  }

  private static floatToRational(x: number, tolerance: number = 1e-10): SchemeExact {
    if (Number.isInteger(x)) {
      return new SchemeExact(BigInt(x));
    }

    // Simple approach: use decimal representation
    const str = x.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1) {
      return new SchemeExact(BigInt(x));
    }

    const decimals = str.length - dotIndex - 1;
    const denom = 10n ** BigInt(decimals);
    const num = BigInt(str.replace(".", ""));
    return new SchemeExact(num, denom);
  }

  // Conversion to JS
  valueOf(): number {
    invariant(this.imag === 0, "Complex number cannot be converted to real");
    return this.real;
  }

  toJS(): number {
    return this.valueOf();
  }

  /**
   * Can't reuse `valueOf` here — it throws on complex. AValue.toJs must always
   * serialize; mirrors `lipsToJs` rosetta path.
   */
  toJs(): number | { real: number; imag: number } {
    return this.imag === 0 ? this.real : { real: this.real, imag: this.imag };
  }

  withProvenance(p: ReadonlySet<number>): SchemeInexact {
    return new SchemeInexact(this.real, this.imag, p);
  }

  // String representation
  toString(): string {
    if (this.imag === 0) {
      // Format as Scheme inexact: include decimal point
      if (Number.isInteger(this.real)) {
        return `${this.real}.0`;
      }
      if (Number.isNaN(this.real)) return "+nan.0";
      if (this.real === Infinity) return "+inf.0";
      if (this.real === -Infinity) return "-inf.0";
      return this.real.toString();
    }
    // Complex format
    const rStr = this.real === 0 ? "" : this.real.toString();
    const sign = this.imag >= 0 ? "+" : "";
    const iStr = this.imag === 1 ? "i" : this.imag === -1 ? "-i" : `${this.imag}i`;
    if (this.real === 0) {
      return this.imag === 1 ? "+i" : this.imag === -1 ? "-i" : `${this.imag}i`;
    }
    return `${rStr}${sign}${iStr}`;
  }

  // Comparison (only valid for reals)
  cmp(other: SchemeInexact): -1 | 0 | 1 {
    invariant(this.imag === 0 && other.imag === 0, "Cannot compare complex numbers");
    if (this.real < other.real) return -1;
    if (this.real > other.real) return 1;
    return 0;
  }

  equals(other: SchemeInexact): boolean {
    return this.real === other.real && this.imag === other.imag;
  }

  // Same-type arithmetic
  add(other: SchemeInexact): SchemeInexact {
    return new SchemeInexact(this.real + other.real, this.imag + other.imag);
  }

  sub(other: SchemeInexact): SchemeInexact {
    return new SchemeInexact(this.real - other.real, this.imag - other.imag);
  }

  mul(other: SchemeInexact): SchemeInexact {
    // (a + bi)(c + di) = (ac - bd) + (ad + bc)i
    return new SchemeInexact(
      this.real * other.real - this.imag * other.imag,
      this.real * other.imag + this.imag * other.real,
    );
  }

  div(other: SchemeInexact): SchemeInexact {
    // (a + bi)/(c + di) = ((ac + bd) + (bc - ad)i) / (c² + d²)
    const denom = other.real * other.real + other.imag * other.imag;
    return new SchemeInexact(
      (this.real * other.real + this.imag * other.imag) / denom,
      (this.imag * other.real - this.real * other.imag) / denom,
    );
  }

  neg(): SchemeInexact {
    return new SchemeInexact(-this.real, -this.imag);
  }

  abs(): SchemeInexact {
    if (this.imag === 0) {
      return new SchemeInexact(Math.abs(this.real));
    }
    // Magnitude of complex number
    return new SchemeInexact(Math.hypot(this.real, this.imag));
  }

  conjugate(): SchemeInexact {
    return new SchemeInexact(this.real, -this.imag);
  }

  // Floor, ceiling, truncate, round (only for reals)
  floor(): SchemeInexact {
    invariant(this.imag === 0,"floor requires real number");
    return new SchemeInexact(Math.floor(this.real));
  }

  ceiling(): SchemeInexact {
    invariant(this.imag === 0,"ceiling requires real number");
    return new SchemeInexact(Math.ceil(this.real));
  }

  truncate(): SchemeInexact {
    invariant(this.imag === 0,"truncate requires real number");
    return new SchemeInexact(Math.trunc(this.real));
  }

  round(): SchemeInexact {
    invariant(this.imag === 0,"round requires real number");
    // Scheme rounds to even on ties
    const floored = Math.floor(this.real);
    const diff = this.real - floored;
    if (diff < 0.5) return new SchemeInexact(floored);
    if (diff > 0.5) return new SchemeInexact(floored + 1);
    // Tie: round to even
    if (floored % 2 === 0) return new SchemeInexact(floored);
    return new SchemeInexact(floored + 1);
  }

  // Transcendental functions
  sqrt(): SchemeInexact {
    if (this.imag === 0 && this.real >= 0) {
      return new SchemeInexact(Math.sqrt(this.real));
    }
    // Complex sqrt
    const r = this.magnitude;
    const theta = this.angle;
    return new SchemeInexact(Math.sqrt(r) * Math.cos(theta / 2), Math.sqrt(r) * Math.sin(theta / 2));
  }

  exp(): SchemeInexact {
    // e^(a+bi) = e^a * (cos(b) + i*sin(b))
    const ea = Math.exp(this.real);
    return new SchemeInexact(ea * Math.cos(this.imag), ea * Math.sin(this.imag));
  }

  log(): SchemeInexact {
    // log(a+bi) = log(|z|) + i*arg(z)
    return new SchemeInexact(Math.log(this.magnitude), this.angle);
  }

  sin(): SchemeInexact {
    if (this.imag === 0) {
      return new SchemeInexact(Math.sin(this.real));
    }
    // sin(a+bi) = sin(a)cosh(b) + i*cos(a)sinh(b)
    return new SchemeInexact(Math.sin(this.real) * Math.cosh(this.imag), Math.cos(this.real) * Math.sinh(this.imag));
  }

  cos(): SchemeInexact {
    if (this.imag === 0) {
      return new SchemeInexact(Math.cos(this.real));
    }
    // cos(a+bi) = cos(a)cosh(b) - i*sin(a)sinh(b)
    return new SchemeInexact(Math.cos(this.real) * Math.cosh(this.imag), -Math.sin(this.real) * Math.sinh(this.imag));
  }

  tan(): SchemeInexact {
    return this.sin().div(this.cos());
  }

  pow(exponent: SchemeInexact): SchemeInexact {
    // z^w = e^(w * log(z))
    if (this.isZero) {
      invariant(exponent.real <= 0, "0 raised to non-positive power");
      return new SchemeInexact(0);
    }
    return exponent.mul(this.log()).exp();
  }

  // Convert to exact (if possible)
  toExact(): SchemeExact {
    invariant(this.imag === 0, "Complex number cannot be converted to exact");
    invariant(Number.isFinite(this.real), "Infinite number cannot be converted to exact");
    // todo double-check - isFinite should guard it already
    invariant(!Number.isNaN(this.real), "NaN cannot be converted to exact");
    // Convert float to rational
    // Use continued fraction approximation for better results
    return SchemeInexact.floatToRational(this.real);
  }
}

// ============================================================================
// Behaviors - Configurable operation policies
// ============================================================================

export interface ExactBehavior {
  /** What to do when exact division doesn't produce an integer */
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric;

  /** How to handle square root of exact number */
  sqrt(a: SchemeExact): SchemeNumeric;
}

export interface InexactBehavior {
  /** How to handle square root of negative real */
  sqrtNegative(a: SchemeInexact): SchemeNumeric;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rational-enabled exact behavior: keep fractions
// ─────────────────────────────────────────────────────────────────────────────
export const RationalExact: ExactBehavior = {
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric {
    return a.div(b); // keeps as exact rational
  },

  sqrt(a: SchemeExact): SchemeNumeric {
    // Check if perfect square
    if (a.isNegative) {
      // Return inexact complex (will be handled by inexact behavior)
      return a.toInexact().sqrt();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = BigInt(Math.floor(Math.sqrt(Number(n))));
      if (root * root === n) {
        return new SchemeExact(root);
      }
    }
    // Not a perfect square, return inexact
    return a.toInexact().sqrt();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Integer-only exact behavior: demote fractions to inexact
// ─────────────────────────────────────────────────────────────────────────────
export const IntegerExact: ExactBehavior = {
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric {
    const result = a.div(b);
    if (result.isInteger) {
      return result;
    }
    // Can't represent as exact integer, demote to inexact
    return result.toInexact();
  },

  sqrt(a: SchemeExact): SchemeNumeric {
    if (a.isNegative) {
      return a.toInexact().sqrt();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = BigInt(Math.floor(Math.sqrt(Number(n))));
      if (root * root === n) {
        return new SchemeExact(root);
      }
    }
    return a.toInexact().sqrt();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Complex-enabled inexact behavior: allow imaginary results
// ─────────────────────────────────────────────────────────────────────────────
export const ComplexInexact: InexactBehavior = {
  sqrtNegative(a: SchemeInexact): SchemeNumeric {
    // sqrt of negative real returns complex
    return new SchemeInexact(0, Math.sqrt(-a.real));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real-only inexact behavior: error on complex results
// ─────────────────────────────────────────────────────────────────────────────
export const RealInexact: InexactBehavior = {
  sqrtNegative(_a: SchemeInexact): SchemeNumeric {
    throw new Error("sqrt of negative number requires complex support");
  },
};

// ============================================================================
// Number Registry - Coordinates operations across types
// ============================================================================

export interface NumberConfig {
  exact: ExactBehavior;
  inexact: InexactBehavior;
}

export const SchemeConfig: NumberConfig = {
  exact: RationalExact,
  inexact: ComplexInexact,
};

export const RosettaConfig: NumberConfig = {
  exact: IntegerExact,
  inexact: RealInexact,
};

export class NumberRegistry {
  constructor(public config: NumberConfig) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Factory methods
  // ──────────────────────────────────────────────────────────────────────────

  fromInteger(n: bigint | number): SchemeExact {
    return new SchemeExact(BigInt(n));
  }

  fromRational(num: bigint | number, denom: bigint | number): SchemeNumeric {
    const exact = new SchemeExact(BigInt(num), BigInt(denom));
    // If rationals aren't supported, check if we need to demote
    if (this.config.exact === IntegerExact && !exact.isInteger) {
      return exact.toInexact();
    }
    return exact;
  }

  fromFloat(n: number): SchemeInexact {
    return new SchemeInexact(n);
  }

  fromComplex(real: number, imag: number): SchemeNumeric {
    if (imag === 0) {
      return new SchemeInexact(real);
    }
    invariant(this.config.inexact !== RealInexact, "Complex numbers not supported in this environment");
    return new SchemeInexact(real, imag);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Coercion
  // ──────────────────────────────────────────────────────────────────────────

  /** Coerce to common type for binary operations */
  coerce(
    a: SchemeNumeric,
    b: SchemeNumeric,
  ): { kind: "exact"; a: SchemeExact; b: SchemeExact } | { kind: "inexact"; a: SchemeInexact; b: SchemeInexact } {
    if (a instanceof SchemeExact && b instanceof SchemeExact) {
      return { kind: "exact", a, b };
    }
    // One or both inexact: both become inexact
    const ia = a instanceof SchemeInexact ? a : a.toInexact();
    const ib = b instanceof SchemeInexact ? b : b.toInexact();
    return { kind: "inexact", a: ia, b: ib };
  }

  /** Convert inexact to exact */
  toExact(n: SchemeNumeric): SchemeExact {
    if (n instanceof SchemeExact) return n;
    return n.toExact();
  }

  /** Convert exact to inexact */
  toInexact(n: SchemeNumeric): SchemeInexact {
    if (n instanceof SchemeInexact) return n;
    return n.toInexact();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Binary operations with coercion
  // ──────────────────────────────────────────────────────────────────────────

  add(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.add(c.b) : c.a.add(c.b);
  }

  sub(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.sub(c.b) : c.a.sub(c.b);
  }

  mul(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.mul(c.b) : c.a.mul(c.b);
  }

  div(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    if (c.kind === "exact") {
      return this.config.exact.div(c.a, c.b);
    }
    return c.a.div(c.b);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Unary operations
  // ──────────────────────────────────────────────────────────────────────────

  neg(a: SchemeNumeric): SchemeNumeric {
    return a.neg();
  }

  abs(a: SchemeNumeric): SchemeNumeric {
    return a.abs();
  }

  sqrt(a: SchemeNumeric): SchemeNumeric {
    if (a instanceof SchemeExact) {
      return this.config.exact.sqrt(a);
    }
    if (a.real < 0 && a.imag === 0) {
      return this.config.inexact.sqrtNegative(a);
    }
    return a.sqrt();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Comparison
  // ──────────────────────────────────────────────────────────────────────────

  compare(a: SchemeNumeric, b: SchemeNumeric): -1 | 0 | 1 {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.cmp(c.b) : c.a.cmp(c.b);
  }

  equals(a: SchemeNumeric, b: SchemeNumeric): boolean {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.equals(c.b) : c.a.equals(c.b);
  }

  lessThan(a: SchemeNumeric, b: SchemeNumeric): boolean {
    return this.compare(a, b) < 0;
  }

  greaterThan(a: SchemeNumeric, b: SchemeNumeric): boolean {
    return this.compare(a, b) > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tower predicates
  // ──────────────────────────────────────────────────────────────────────────

  isInteger(n: SchemeNumeric): boolean {
    return n.isInteger;
  }

  isRational(n: SchemeNumeric): boolean {
    return n.isRational;
  }

  isReal(n: SchemeNumeric): boolean {
    return n.isReal;
  }

  isComplex(n: SchemeNumeric): boolean {
    return n.isComplex;
  }

  isExact(n: SchemeNumeric): boolean {
    return n.isExact;
  }

  isZero(n: SchemeNumeric): boolean {
    return n.isZero;
  }

  isPositive(n: SchemeNumeric): boolean {
    return n.isPositive;
  }

  isNegative(n: SchemeNumeric): boolean {
    return n.isNegative;
  }

  isNaN(n: SchemeNumeric): boolean {
    return n.isNaN;
  }

  isFinite(n: SchemeNumeric): boolean {
    return n.isFinite;
  }
}

// ============================================================================
// Default registry (Scheme mode)
// ============================================================================

export const schemeNumbers = new NumberRegistry(SchemeConfig);
export const rosettaNumbers = new NumberRegistry(RosettaConfig);

// ============================================================================
// Compatibility layer for LNumber API
// NOTE: These are for gradual migration. The preferred API is the registry.
// ============================================================================

/**
 * Create a number from various inputs (LNumber-compatible factory)
 * Uses the provided registry or defaults to Scheme mode
 */
export function makeNumber(
  value: number | bigint | string | SchemeNumeric,
  registry: NumberRegistry = schemeNumbers,
): SchemeNumeric {
  switch (true) {
    case value instanceof SchemeExact:
    case value instanceof SchemeInexact:
      return value;
    case typeof value === "bigint":
      return registry.fromInteger(value);
    case typeof value === "number":
      return Number.isInteger(value) && Number.isSafeInteger(value)
        ? registry.fromInteger(value)
        : registry.fromFloat(value);
    case typeof value === "string":
      return parseNumber(value, registry);
    default:
      invariant(false, `Cannot create number from ${typeof value}`);
  }
}

/**
 * Parse a number from string representation
 */
export function parseNumber(str: string, registry: NumberRegistry = schemeNumbers): SchemeNumeric {
  str = str.trim();

  // Handle exactness prefixes
  let forceExact = false;
  let forceInexact = false;

  if (str.startsWith("#e") || str.startsWith("#E")) {
    forceExact = true;
    str = str.slice(2);
  } else if (str.startsWith("#i") || str.startsWith("#I")) {
    forceInexact = true;
    str = str.slice(2);
  }

  // Handle radix prefixes
  let radix = 10;
  if (str.startsWith("#b") || str.startsWith("#B")) {
    radix = 2;
    str = str.slice(2);
  } else if (str.startsWith("#o") || str.startsWith("#O")) {
    radix = 8;
    str = str.slice(2);
  } else if (str.startsWith("#d") || str.startsWith("#D")) {
    radix = 10;
    str = str.slice(2);
  } else if (str.startsWith("#x") || str.startsWith("#X")) {
    radix = 16;
    str = str.slice(2);
  }

  // Handle special values
  if (str === "+inf.0") return new SchemeInexact(Infinity);
  if (str === "-inf.0") return new SchemeInexact(-Infinity);
  if (str === "+nan.0" || str === "-nan.0") return new SchemeInexact(Number.NaN);

  // Handle complex (a+bi or a-bi)
  const complexMatch = str.match(/^([+-]?[\d.]+)?([+-][\d.]*)?i$/);
  if (complexMatch) {
    const real = complexMatch[1] ? Number.parseFloat(complexMatch[1]) : 0;
    let imag = complexMatch[2] || "+1";
    if (imag === "+" || imag === "-") imag += "1";
    return registry.fromComplex(real, Number.parseFloat(imag));
  }

  // Handle rational (a/b)
  const rationalMatch = str.match(/^([+-]?\d+)\/(\d+)$/);
  if (rationalMatch) {
    const num = BigInt(rationalMatch[1]);
    const denom = BigInt(rationalMatch[2]);
    const result = registry.fromRational(num, denom);
    if (forceInexact && result instanceof SchemeExact) {
      return result.toInexact();
    }
    return result;
  }

  // Handle decimal
  if (str.includes(".") || str.includes("e") || str.includes("E")) {
    const value = Number.parseFloat(str);
    if (forceExact) {
      return new SchemeInexact(value).toExact();
    }
    return new SchemeInexact(value);
  }

  // Handle integer
  const value = Number.parseInt(str, radix);
  if (forceInexact) {
    return new SchemeInexact(value);
  }
  return new SchemeExact(BigInt(value));
}

/**
 * Type guard to check if a value is a SchemeNumeric (SchemeExact or SchemeInexact)
 */
export function isSchemeNumeric(value: unknown): value is SchemeNumeric {
  return value instanceof SchemeExact || value instanceof SchemeInexact;
}

/**
 * Check if a value is a numeric type (SchemeNumeric or JS primitive)
 */
export function isNumeric(value: unknown): boolean {
  return isSchemeNumeric(value) || typeof value === "number" || typeof value === "bigint";
}

// ============================================================================
// Type Checking Functions (replaces LNumber static methods)
// ============================================================================

/** Check if value is a native JS number or bigint */
export function isNativeNumber(n: unknown): n is number | bigint {
  return typeof n === "number" || typeof n === "bigint";
}

/** Check if value is a float (inexact real) */
export function isFloat(n: unknown): boolean {
  if (n instanceof SchemeInexact) {
    return n.imag === 0;
  }
  if (n instanceof SchemeExact) {
    return false;
  }
  return typeof n === "number" && n % 1 !== 0;
}

/** Check if value is complex (has non-zero imaginary part) */
export function isComplex(n: unknown): boolean {
  if (n instanceof SchemeInexact) {
    return n.imag !== 0;
  }
  // Duck typing for legacy {re, im} objects
  if (n && typeof n === "object" && "re" in n && "im" in n) {
    return true;
  }
  return false;
}

/** Check if value is a rational (exact with denom != 1) */
export function isRational(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom !== 1n;
  }
  // Duck typing for legacy {num, denom} objects
  if (n && typeof n === "object" && "num" in n && "denom" in n) {
    return true;
  }
  return false;
}

/** Check if value is an integer */
export function isInteger(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom === 1n;
  }
  if (n instanceof SchemeInexact) {
    return false;
  }
  if (typeof n === "bigint") {
    return true;
  }
  if (typeof n === "number") {
    return Number.isInteger(n);
  }
  return false;
}

/** Check if value is a big integer (exact integer) */
export function isBigInteger(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom === 1n;
  }
  return typeof n === "bigint";
}

AValue.registerBoxer("bigint", (v, p) => new SchemeExact(v as bigint, 1n, p));

// Safe-integer JS numbers route to exact — preserves precision through scheme
// arithmetic. Anything beyond MAX_SAFE_INTEGER would round on bigint conversion.
AValue.registerBoxer("number", (v, p) => {
  const n = v as number;
  return Number.isSafeInteger(n) ? new SchemeExact(BigInt(n), 1n, p) : new SchemeInexact(n, 0, p);
});

// ============================================================================
// SANDBOX BOUNDARIES
// ============================================================================
// War story (2026-05-28 audit): SchemeExact and SchemeInexact carry the
// numeric-tower behavior surface (isInteger/isRational/isReal getters plus
// the full arithmetic protocol on their prototypes). Numeric values are the
// densest object population in any sandbox computation — every arithmetic
// step creates a fresh instance. Symbol-to-field auto-resolution means each
// number is a potential probe point into the host numeric tower.
// Boundary-marking restricts sandbox access to own properties (num/denom for
// exact, real/imag for inexact) which are the intended data surface; the
// methods (which expose tower internals and host-side bigint helpers) become
// blocked. The arithmetic ops scheme code actually uses (`+`, `*`, `floor`,
// …) live in the env bindings, not on these prototypes.
// ============================================================================
markAsSandboxBoundary(SchemeExact);
markAsSandboxBoundary(SchemeInexact);
