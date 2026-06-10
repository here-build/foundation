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
import { HalfBaked, is_half_baked, type Interval } from "./HalfBaked.js";
import type { Environment } from "./Environment.js";
import { SchemeBool, schemeFalse, schemeTrue } from "./LBool.js";
import { SchemeBytevector } from "./LBytevector.js";
import { SchemeVector } from "./LVector.js";
import { global_env as lipsGlobalEnv, env as userEnv, exec } from "./stdlib.js";
import { exec as generatorExec } from "./evaluator.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import type { Operator, Codec } from "./membrane.js";
import type { SchemeNumeric } from "./numbers.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import * as ops from "./operators/index.js";
// Import directly from source files to avoid circular dependency during init
import { Pair } from "./Pair.js";
import { structuralEqual } from "./structural-equal.js";
import { Nil, SchemeCharacter, nil, type SchemeValue } from "./types.js";
import { type } from "./utils/typecheck.js";
import { Values } from "./Values.js";
import invariant from "tiny-invariant";
import "./errors.js";
// Import global environment for initBridge - this is safe because bridge.ts
// doesn't get imported during lips.ts initialization

// ============================================================================
// Allocation cap — DoS defense for size-parameterized constructors
// ============================================================================
// War story (2026-05-30 sandbox-escape audit): `make-string` / `make-vector`
// take an unbounded length `k`. V8 has its own ceiling (~2^29 chars, ~2^32
// array slots) and throws RangeError above it — but that's the ENGINE's limit,
// not OUR policy, and the attack window is exactly BELOW it: `(make-string 1e8)`
// allocates 200MB of UTF-16 in ~1ms and succeeds, `(make-vector 1e8)` spins for
// >10s materializing 100M slots. A single sandbox call drives host memory
// pressure. The fix is an O(1) length check BEFORE allocation.
//
// Default: 2^24 (16,777,216). Large enough that no legitimate Scheme program
// hits it (a 16M-char string / 16M-slot vector is already pathological for an
// in-memory AST language), small enough that the worst case is ~32MB UTF-16 /
// one 16M-slot array — recoverable, not a host-killer. Host-overridable via
// `setAllocationLimit` so a tighter sandbox (or a looser trusted batch job)
// can retune without forking.
let allocationLimit = 1 << 24; // 16,777,216

/** Current per-call allocation cap for size-parameterized constructors. */
export function getAllocationLimit(): number {
  return allocationLimit;
}

/**
 * Override the per-call allocation cap (`make-string` / `make-vector` length).
 * Pass `Infinity` to disable (trusted contexts only). Negative / NaN is
 * rejected — the cap must be a meaningful upper bound.
 */
export function setAllocationLimit(limit: number): void {
  invariant(
    typeof limit === "number" && !Number.isNaN(limit) && limit >= 0,
    `setAllocationLimit: expected a non-negative number, got ${limit}`,
  );
  allocationLimit = limit;
}

/**
 * Throw a Scheme-surfaceable error (O(1), pre-allocation) when a requested
 * length exceeds the cap or is otherwise not a usable count. `len` is read
 * once by the caller; we validate it here so both constructors share one
 * message shape and one policy.
 */
function assertAllocatable(len: number, fnName: string): void {
  invariant(
    Number.isFinite(len) && len >= 0,
    `${fnName}: length must be a non-negative integer, got ${len}`,
  );
  invariant(
    len <= allocationLimit,
    `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`,
  );
}

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
 * Resolve a vector argument to its raw element array (read/mutate view).
 * Accepts a boxed SchemeVector (returns __vector__ by reference, so in-place
 * mutators write through) or a raw JS array (transition: raw vectors still flow
 * until S7 producers + S10 tighten). Throws on anything else.
 */
function asVector(obj: unknown, fnName: string): SchemeValue[] {
  if (obj instanceof SchemeVector) return obj.__vector__;
  if (Array.isArray(obj)) return obj;
  TypeError.invariant(false, `${fnName}: expected vector`);
}

/**
 * Convert bytevector-like value to Uint8Array view.
 * Accepts Uint8Array, ArrayBuffer, DataView, Node Buffer.
 * Preserves identity for Uint8Array, creates view for others.
 */
function asBytevector(obj: unknown, fnName: string): Uint8Array {
  switch (true) {
    case obj instanceof SchemeBytevector:
      // Unwrap by reference so in-place mutators (bytevector-u8-set!,
      // bytevector-copy!) write through to the boxed payload.
      return obj.__bytevector__;
    case obj instanceof Uint8Array:
      // FFI coercion: a raw Uint8Array handed to a bytevector op (e.g. from a
      // JS function) is coerced in place. Stays permanently — it's the FFI
      // adapter. (bytevector? tightens to instanceof-only in S4; asBytevector
      // keeps coercing raw forms.)
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
 *
 * R7RS § 6.1: eqv? is #t for two characters with the same `char=?` value
 * (`(eqv? #\a #\a)` → #t) even across distinct heap instances — so `(memv #\a
 * (list #\a))` must succeed. SchemeCharacter heap-distinct copies would fail the
 * `a === b` line, so compare `__char__` explicitly.
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
    case a instanceof SchemeCharacter && b instanceof SchemeCharacter:
      return a.__char__ === b.__char__;
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
  // ════════════════════════════════════════════════════════════════════════════
  // War story (fuzz audit #42): `(- (* 0 "") (- (- 0 0) 0))` surfaced as
  // "Unbound variable `-'" — pointing at a downstream env lookup, not the
  // real cause (string was passed to `*`). Trace: fromLIPS throws on `""`,
  // the TypeError travels up through `Array.map` (line below) → `op.call`
  // → `call_function` (lips.ts:4057) → `apply` (lips.ts:4067) → into
  // `evaluate` (lips.ts:4180). The masking happens because every catch path
  // on the way up either swallows or rewraps the original, and only the
  // OUTER form's name remained on a downstream `env.get(first)` retry, so
  // the *symptom* presented as a name-lookup failure on an unrelated symbol.
  //
  // The fix tags fromLIPS conversion failures with operator name + arg type
  // names at THIS boundary — the only frame that has both pieces (op.name
  // here, type() applied to args). Original TypeError carried via `cause`
  // so the membrane/sandbox stack still traces the converter's invariant.
  // No catch on op.call itself — operator-internal failures (arity, codec
  // mismatch on already-numeric args, etc.) already include `op.name` in
  // their messages via membrane.ts:671-679.
  // ════════════════════════════════════════════════════════════════════════════
  // The synchronous numeric core: convert args, apply the operator, stamp
  // provenance. Factored out so the speculative path can run it either eagerly
  // or after forcing a HalfBaked carrier.
  const applyNumeric = (callArgs: unknown[]): unknown => {
    const provenance = unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue));
    let converted: SchemeNumeric[];
    try {
      converted = callArgs.map(fromLIPS);
    } catch (cause) {
      // Find the first non-numeric arg so the error names what actually failed,
      // not just "some arg." Mirror isSchemeNumber's contract — anything it
      // rejects is what fromLIPS would have thrown on.
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
        args.map((a) => (is_half_baked(a) ? (a as HalfBaked).force() : a)),
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

// Fantasy Land Ord: the comparison operators consult `fantasy-land/lte` when their operands
// are ordered ENTITIES (a DateTime, a Version, …), exactly as equal? consults a Setoid's
// `fantasy-land/equals`. All four relations derive from the single `lte`; a chain (< a b c)
// holds iff each adjacent pair does. Numeric operands take the original numeric/speculative
// path unchanged — the FL check is one cheap property read, false for every number.
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
        if (!isOrd(args[i]) || !isOrd(args[i + 1])) return numeric(...args); // mixed → numeric path's clear error
        if (!rel(args[i], args[i + 1])) return schemeFalse;
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
    const n = fromLIPS(z);
    const base = radix === undefined ? 10 : Number(fromLIPS(radix).valueOf());
    if (n instanceof SchemeExact) {
      if (n.denom === 1n) return n.num.toString(base);
      return `${n.num.toString(base)}/${n.denom.toString(base)}`;
    }
    const inexact = n as SchemeInexact;
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
    const num = fromLIPS(n);
    const code = num instanceof SchemeExact ? Number(num.num) : Math.floor((num as SchemeInexact).real);
    invariant(code >= 0 && code <= 0x10ffff, `integer->char: code point ${code} out of Unicode range`);
    invariant(code < 0xd800 || code > 0xdfff, `integer->char: surrogate code point ${code.toString(16)} is not a Unicode scalar`);
    return new SchemeCharacter(String.fromCodePoint(code));
  },

  // ============================================================================
  // R7RS String Operations (Section 6.7)
  // ============================================================================

  "make-string"(k: unknown, char?: unknown): SchemeString {
    const len = Number(fromLIPS(k).valueOf());
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
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
    let current = list;
    while (current instanceof Pair) {
      if (cmp(obj, current.car)) return current;
      current = current.cdr;
    }
    return false;
  },

  // assoc uses equal? (deep structural equality)
  assoc(obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown {
    const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
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
    return structuralEqual(a, b);
  },

  // ============================================================================
  // R7RS Vector functions (Section 6.8)
  // ============================================================================

  "make-vector"(k: unknown, fill?: unknown): unknown[] {
    const len = Number(typeof k === "number" ? k : (k as SchemeExact).valueOf());
    // O(1) cap check BEFORE Array.from materializes `len` slots — see
    // assertAllocatable. `Array.from({length})` on an oversized count is the
    // >10s hang the audit caught.
    assertAllocatable(len, "make-vector");
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
    // Transition shim (S6): accept boxed OR raw arrays so raw vectors (pre-S7)
    // still answer #t. S10 settles the final form — likely instanceof-only, since
    // a raw JS array is an R7RS list at the membrane, NOT a vector (unlike a raw
    // Uint8Array, which genuinely IS bytevector-like; that asymmetry is why
    // bytevector? stays polymorphic but vector? need not).
    return obj instanceof SchemeVector || Array.isArray(obj);
  },

  "vector-length"(vec: unknown): number {
    return asVector(vec, "vector-length").length;
  },

  "vector-ref"(vec: unknown, k: unknown): unknown {
    const arr = asVector(vec, "vector-ref");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    return arr[idx as number];
  },

  "vector-set!"(vec: unknown, k: unknown, obj: unknown): void {
    const arr = asVector(vec, "vector-set!");
    const idx = typeof k === "number" ? k : (k as SchemeExact).valueOf();
    arr[idx as number] = obj;
  },

  "vector->list"(vec: unknown, start?: unknown, end?: unknown): unknown {
    const arr = asVector(vec, "vector->list");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return Pair.fromArray(arr.slice(s, e));
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
    const arr = asVector(vec, "vector-fill!");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    for (let i = s; i < e; i++) {
      arr[i] = fill;
    }
  },

  "vector->string"(vec: unknown, start?: unknown, end?: unknown): string {
    const arr = asVector(vec, "vector->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    let result = "";
    for (let i = s; i < e; i++) {
      const ch = arr[i];
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
    const arr = asVector(vec, "vector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? arr.length : toIndex(end);
    return arr.slice(s, e);
  },

  "vector-copy!"(to: unknown, at: unknown, from: unknown, start?: unknown, end?: unknown): void {
    const target = asVector(to, "vector-copy!");
    const source = asVector(from, "vector-copy!");
    const atIdx = toIndex(at);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? source.length : toIndex(end);
    // Handle overlapping copies correctly by copying to temp array first
    // R7RS requires behavior as if source was copied to temp storage first
    if (target === source && atIdx > s && atIdx < e) {
      // Overlapping copy where destination is ahead of source - use temp
      const temp = source.slice(s, e);
      for (let i = 0, j = atIdx; i < temp.length; i++, j++) {
        target[j] = temp[i];
      }
    } else {
      for (let i = s, j = atIdx; i < e; i++, j++) {
        target[j] = source[i];
      }
    }
  },

  "vector-map"(proc: Function, ...vectors: unknown[]): unknown[] {
    invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
    const arrays = vectors.map((v) => asVector(v, "vector-map"));
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
    const arrays = vectors.map((v) => asVector(v, "vector-for-each"));
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
    return new SchemeBytevector(arr);
  },

  bytevector(...bytes: unknown[]): SchemeBytevector {
    const result = new Uint8Array(bytes.length);
    for (const [i, b] of bytes.entries()) {
      result[i] = toIndex(b);
    }
    return new SchemeBytevector(result);
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

  "bytevector-copy"(bv: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const view = asBytevector(bv, "bytevector-copy");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return new SchemeBytevector(view.slice(s, e));
  },

  "bytevector-copy!"(to: unknown, at: unknown, from: unknown, start?: unknown, end?: unknown): void {
    const target = asBytevector(to, "bytevector-copy!");
    const source = asBytevector(from, "bytevector-copy!");
    const atIdx = toIndex(at);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? source.byteLength : toIndex(end);
    target.set(source.subarray(s, e), atIdx);
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
    return new SchemeBytevector(result);
  },

  "utf8->string"(bv: unknown, start?: unknown, end?: unknown): string {
    const view = asBytevector(bv, "utf8->string");
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? view.byteLength : toIndex(end);
    return new TextDecoder("utf-8").decode(view.subarray(s, e));
  },

  "string->utf8"(str: unknown, start?: unknown, end?: unknown): SchemeBytevector {
    const s_str = stringValue(str);
    const s = start === undefined ? 0 : toIndex(start);
    const e = end === undefined ? s_str.length : toIndex(end);
    return new SchemeBytevector(new TextEncoder().encode(s_str.slice(s, e)));
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
    // Generator evaluator (evaluator.ts). `exec` returns a Promise<SchemeValue>;
    // unlike the legacy `evaluate` (which could return a settled value for pure
    // synchronous code), this builtin now ALWAYS returns a thenable. Both
    // evaluator paths unpromise a builtin's return — the legacy path via
    // `resolve_promises`/`unpromise` in `call_function`/`apply`, the generator
    // path via the `is_promise(value)` yield in `evaluatePair`/`evaluateArgs`,
    // and even the operator-position case `((eval (quote +)) 2 3)` awaits the
    // promise before applying — so the Scheme-level result is unchanged.
    return generatorExec(expr as SchemeValue, { env: env || lipsGlobalEnv });
  },

  // ============================================================================
  // List Utilities (moved from bootstrap.scm)
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
  //     dominant avoidable crash in generated Scheme — unnecessary. `remove` also
  //     OVERRIDES the broken Ramda `remove` spread into the sandbox env (curated copy
  //     runs after construction, so it wins).
  bootstrapPromise = exec(BOOTSTRAP_SCHEME).then(async () => {
    const { sandboxedEnv } = await import("./sandbox-env.js");
    for (const name of [
      "->", "->>", "~>", "~>>", "cut", "cute", "gensym",
      "first?", "first-or", "iota", "delete-duplicates", "filter-map", "count", "list-index", "append-map", "remove",
    ]) {
      const value = userEnv.get(name, { throwError: false });
      if (value) sandboxedEnv.set(name, value);
    }
  });
  return bootstrapPromise;
}
