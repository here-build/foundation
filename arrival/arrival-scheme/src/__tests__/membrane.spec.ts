/**
 * Membrane and Operator Tests
 */

import { describe, expect, it } from "vitest";
import { SchemeExact, SchemeInexact } from "../numbers";
import {
  AnyNum,
  Environment,
  Int,
  Operator,
  Real,
  // Wrapper layer
  TO_JS,
  SchemeJSObject,
  SchemeJSFunction,
  fromJS,
  toJS,
  isSchemeValue,
  isBytevectorLike,
} from "../membrane";
import { nil } from "../types";
import { SchemeString } from "../LString";
import { SchemeSymbol } from "../LSymbol";
import { Pair } from "../Pair";
import {
  abs,
  add,
  bitwiseAnd,
  bitwiseXor,
  ceiling,
  div,
  floor,
  fullNumericEnv,
  gcd,
  gt,
  isEven,
  isOdd,
  isZero,
  lcm,
  lt,
  mul,
  numEq,
  quotient,
  remainder,
  rosettaNumericEnv,
  round,
  sin,
  sqrt,
  sub,
} from "../operators";

describe("Codecs", () => {
  describe("AnyNum", () => {
    it("matches ExactNumber", () => {
      expect(AnyNum.match(new SchemeExact(42n))).toBe(true);
      expect(AnyNum.match(new SchemeExact(1n, 3n))).toBe(true);
    });

    it("matches InexactNumber", () => {
      expect(AnyNum.match(new SchemeInexact(3.14))).toBe(true);
    });

    it("converts exact integer to JS number", () => {
      expect(AnyNum.toJS(new SchemeExact(42n))).toBe(42);
    });

    it("converts large exact integer to JS bigint", () => {
      const big = new SchemeExact(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
      expect(AnyNum.toJS(big)).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    });

    it("converts exact rational to JS number", () => {
      expect(AnyNum.toJS(new SchemeExact(1n, 2n))).toBe(0.5);
    });

    it("converts inexact to JS number", () => {
      expect(AnyNum.toJS(new SchemeInexact(3.14))).toBe(3.14);
    });

    it("converts JS safe integer to ExactNumber", () => {
      const result = AnyNum.fromJS(42);
      expect(result).toBeInstanceOf(SchemeExact);
      expect((result as SchemeExact).num).toBe(42n);
    });

    it("converts JS bigint to ExactNumber", () => {
      const result = AnyNum.fromJS(42n);
      expect(result).toBeInstanceOf(SchemeExact);
    });

    it("converts JS float to InexactNumber", () => {
      const result = AnyNum.fromJS(3.14);
      expect(result).toBeInstanceOf(SchemeInexact);
    });
  });

  describe("Int", () => {
    it("matches only integers", () => {
      expect(Int.match(new SchemeExact(42n))).toBe(true);
      expect(Int.match(new SchemeExact(1n, 2n))).toBe(false);
      expect(Int.match(new SchemeInexact(42))).toBe(false);
    });
  });

  describe("Real", () => {
    it("matches only real inexact numbers", () => {
      expect(Real.match(new SchemeInexact(3.14))).toBe(true);
      expect(Real.match(new SchemeInexact(0, 1))).toBe(false); // complex
      expect(Real.match(new SchemeExact(42n))).toBe(false);
    });
  });
});

describe("Operator", () => {
  it("has correct arity info", () => {
    expect(add.arity).toEqual({ min: 0, max: null }); // variadic
    expect(quotient.arity).toEqual({ min: 2, max: 2 }); // fixed
    expect(sub.arity).toEqual({ min: 1, max: null }); // at least 1
  });

  it("throws on wrong arity", () => {
    expect(() => quotient.call([])).toThrow("expected at least 2 args");
    expect(() => quotient.call([new SchemeExact(1n)])).toThrow("expected at least 2 args");
    expect(() => quotient.call([new SchemeExact(1n), new SchemeExact(2n), new SchemeExact(3n)])).toThrow(
      "expected 2 args",
    );
  });

  it("throws on type mismatch", () => {
    expect(() => quotient.call([new SchemeInexact(1), new SchemeExact(2n)])).toThrow("type mismatch");
  });
});

describe("Arithmetic Operators", () => {
  it("add - variadic", () => {
    expect(add.call([])).toEqual(new SchemeExact(0n));
    expect(add.call([new SchemeExact(1n)])).toEqual(new SchemeExact(1n));
    expect(add.call([new SchemeExact(1n), new SchemeExact(2n)])).toEqual(new SchemeExact(3n));
    expect(add.call([new SchemeExact(1n), new SchemeExact(2n), new SchemeExact(3n)])).toEqual(new SchemeExact(6n));
  });

  it("add - promotes to inexact", () => {
    const result = add.call([new SchemeExact(1n), new SchemeInexact(2.5)]);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(3.5);
  });

  it("sub - unary negation", () => {
    expect(sub.call([new SchemeExact(5n)])).toEqual(new SchemeExact(-5n));
  });

  it("sub - variadic", () => {
    expect(sub.call([new SchemeExact(10n), new SchemeExact(3n)])).toEqual(new SchemeExact(7n));
    expect(sub.call([new SchemeExact(10n), new SchemeExact(3n), new SchemeExact(2n)])).toEqual(new SchemeExact(5n));
  });

  it("mul - variadic", () => {
    expect(mul.call([])).toEqual(new SchemeExact(1n));
    expect(mul.call([new SchemeExact(2n), new SchemeExact(3n)])).toEqual(new SchemeExact(6n));
  });

  it("div - unary reciprocal", () => {
    // R7RS: exact / exact = exact (rational 1/2)
    const result = div.call([new SchemeExact(2n)]);
    expect(result).toBeInstanceOf(SchemeExact);
    expect((result as SchemeExact).num).toBe(1n);
    expect((result as SchemeExact).denom).toBe(2n);
  });

  it("quotient - integer division", () => {
    expect(quotient.call([new SchemeExact(7n), new SchemeExact(3n)])).toEqual(new SchemeExact(2n));
  });

  it("remainder", () => {
    expect(remainder.call([new SchemeExact(7n), new SchemeExact(3n)])).toEqual(new SchemeExact(1n));
  });

  it("gcd", () => {
    expect(gcd.call([])).toEqual(new SchemeExact(0n));
    expect(gcd.call([new SchemeExact(12n), new SchemeExact(18n)])).toEqual(new SchemeExact(6n));
  });

  it("lcm", () => {
    expect(lcm.call([])).toEqual(new SchemeExact(1n));
    expect(lcm.call([new SchemeExact(4n), new SchemeExact(6n)])).toEqual(new SchemeExact(12n));
  });

  it("abs", () => {
    expect(abs.call([new SchemeExact(-5n)])).toEqual(new SchemeExact(5n));
    expect(abs.call([new SchemeInexact(-3.14)])).toEqual(new SchemeInexact(3.14));
  });
});

describe("Comparison Operators", () => {
  it("numEq", () => {
    expect(numEq.call([new SchemeExact(1n), new SchemeExact(1n)])).toBe(true);
    expect(numEq.call([new SchemeExact(1n), new SchemeExact(2n)])).toBe(false);
    expect(numEq.call([new SchemeExact(1n), new SchemeExact(1n), new SchemeExact(1n)])).toBe(true);
  });

  it("lt - chain comparison", () => {
    expect(lt.call([new SchemeExact(1n), new SchemeExact(2n)])).toBe(true);
    expect(lt.call([new SchemeExact(1n), new SchemeExact(2n), new SchemeExact(3n)])).toBe(true);
    expect(lt.call([new SchemeExact(1n), new SchemeExact(3n), new SchemeExact(2n)])).toBe(false);
  });

  it("gt - chain comparison", () => {
    expect(gt.call([new SchemeExact(3n), new SchemeExact(2n)])).toBe(true);
    expect(gt.call([new SchemeExact(3n), new SchemeExact(2n), new SchemeExact(1n)])).toBe(true);
  });
});

describe("Predicates", () => {
  it("isZero", () => {
    expect(isZero.call([new SchemeExact(0n)])).toBe(true);
    expect(isZero.call([new SchemeInexact(0)])).toBe(true);
    expect(isZero.call([new SchemeExact(1n)])).toBe(false);
  });

  it("isOdd", () => {
    expect(isOdd.call([new SchemeExact(3n)])).toBe(true);
    expect(isOdd.call([new SchemeExact(4n)])).toBe(false);
  });

  it("isEven", () => {
    expect(isEven.call([new SchemeExact(4n)])).toBe(true);
    expect(isEven.call([new SchemeExact(3n)])).toBe(false);
  });
});

describe("Rounding", () => {
  it("floor", () => {
    expect(floor.call([new SchemeInexact(3.7)])).toEqual(new SchemeExact(3n));
    expect(floor.call([new SchemeInexact(-3.7)])).toEqual(new SchemeExact(-4n));
  });

  it("ceiling", () => {
    expect(ceiling.call([new SchemeInexact(3.2)])).toEqual(new SchemeExact(4n));
  });

  it("round - ties to even", () => {
    expect(round.call([new SchemeInexact(2.5)])).toEqual(new SchemeExact(2n));
    expect(round.call([new SchemeInexact(3.5)])).toEqual(new SchemeExact(4n));
  });
});

describe("Transcendentals", () => {
  it("sqrt", () => {
    const result = sqrt.call([new SchemeInexact(4)]);
    // Num profunctor returns ExactNumber for safe integers
    expect(result.valueOf()).toBeCloseTo(2);
  });

  it("sqrt - non-integer result", () => {
    const result = sqrt.call([new SchemeInexact(2)]);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBeCloseTo(Math.SQRT2);
  });

  it("sin", () => {
    const result = sin.call([new SchemeInexact(0)]);
    // sin(0) = 0, which is a safe integer
    expect(result.valueOf()).toBeCloseTo(0);
  });

  it("sin - non-integer result", () => {
    // sin(1) ≈ 0.841, definitely not an integer
    const result = sin.call([new SchemeInexact(1)]);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBeCloseTo(Math.sin(1));
  });
});

describe("Bitwise", () => {
  it("bitwiseAnd", () => {
    expect(bitwiseAnd.call([new SchemeExact(0b1100n), new SchemeExact(0b1010n)])).toEqual(new SchemeExact(0b1000n));
  });

  it("bitwiseXor", () => {
    expect(bitwiseXor.call([new SchemeExact(0b1100n), new SchemeExact(0b1010n)])).toEqual(new SchemeExact(0b0110n));
  });
});

describe("Environment", () => {
  it("registers and retrieves operators", () => {
    const env = new Environment("test");
    env.register(add);

    expect(env.has("+")).toBe(true);
    expect(env.get("+")).toBe(add);
  });

  it("calls operators by name", () => {
    const env = new Environment("test").registerAll(add, mul);

    expect(env.call("+", [new SchemeExact(1n), new SchemeExact(2n)])).toEqual(new SchemeExact(3n));
  });

  it("throws on unknown operator", () => {
    const env = new Environment("test");
    expect(() => env.call("unknown", [])).toThrow("unknown operator");
  });

  it("extends environment", () => {
    const parent = new Environment("parent").register(add);
    const child = parent.extend("child").register(mul);

    expect(child.has("+")).toBe(true);
    expect(child.has("*")).toBe(true);
    expect(parent.has("*")).toBe(false);
  });

  it("restricts environment", () => {
    const full = new Environment("full").registerAll(add, mul, div);
    const restricted = full.restrict("restricted", ["+", "*"]);

    expect(restricted.has("+")).toBe(true);
    expect(restricted.has("*")).toBe(true);
    expect(restricted.has("/")).toBe(false);
  });
});

describe("Pre-built Environments", () => {
  it("fullNumericEnv has all operators", () => {
    expect(fullNumericEnv.has("+")).toBe(true);
    expect(fullNumericEnv.has("bitwise-and")).toBe(true);
  });

  it("rosettaNumericEnv has no bitwise ops", () => {
    expect(rosettaNumericEnv.has("+")).toBe(true);
    expect(rosettaNumericEnv.has("bitwise-and")).toBe(false);
  });
});

// ============================================================================
// WRAPPER LAYER TESTS
// ============================================================================

describe("Wrapper Layer", () => {
  describe("isSchemeValue", () => {
    it("recognizes nil", () => {
      expect(isSchemeValue(nil)).toBe(true);
    });

    it("recognizes native Scheme types", () => {
      expect(isSchemeValue(new SchemeExact(42n))).toBe(true);
      expect(isSchemeValue(new SchemeInexact(3.14))).toBe(true);
      expect(isSchemeValue(new SchemeString("hello"))).toBe(true);
      expect(isSchemeValue(new SchemeSymbol("foo"))).toBe(true);
      expect(isSchemeValue(new Pair(1, 2))).toBe(true);
    });

    it("recognizes wrappers as Scheme values", () => {
      expect(isSchemeValue(new SchemeJSObject({}))).toBe(true);
      expect(isSchemeValue(new SchemeJSFunction(() => {}))).toBe(true);
    });

    it("rejects JS primitives and objects", () => {
      expect(isSchemeValue(42)).toBe(false);
      expect(isSchemeValue("hello")).toBe(false);
      expect(isSchemeValue({})).toBe(false);
      expect(isSchemeValue([])).toBe(false);
      expect(isSchemeValue(null)).toBe(false);
      expect(isSchemeValue(undefined)).toBe(false);
    });
  });

  describe("isBytevectorLike", () => {
    it("recognizes Uint8Array", () => {
      expect(isBytevectorLike(new Uint8Array(10))).toBe(true);
    });

    it("recognizes ArrayBuffer", () => {
      expect(isBytevectorLike(new ArrayBuffer(10))).toBe(true);
    });

    it("recognizes DataView", () => {
      expect(isBytevectorLike(new DataView(new ArrayBuffer(10)))).toBe(true);
    });

    it("rejects non-binary types", () => {
      expect(isBytevectorLike([])).toBe(false);
      expect(isBytevectorLike({})).toBe(false);
      expect(isBytevectorLike("hello")).toBe(false);
    });
  });

  describe("fromJS", () => {
    it("converts null/undefined to nil", () => {
      expect(fromJS(null)).toBe(nil);
      expect(fromJS(undefined)).toBe(nil);
    });

    it("passes through primitives", () => {
      expect(fromJS(true)).toBe(true);
      expect(fromJS(42)).toBe(42);
      expect(fromJS("hello")).toBe("hello");
      expect(fromJS(42n)).toBe(42n);
      const sym = Symbol("test");
      expect(fromJS(sym)).toBe(sym);
    });

    it("passes through Scheme values", () => {
      const exact = new SchemeExact(42n);
      expect(fromJS(exact)).toBe(exact);

      const pair = new Pair(1, 2);
      expect(fromJS(pair)).toBe(pair);
    });

    it("passes through arrays", () => {
      const arr = [1, 2, 3];
      expect(fromJS(arr)).toBe(arr);
    });

    it("passes through bytevector-like types", () => {
      const u8 = new Uint8Array(10);
      expect(fromJS(u8)).toBe(u8);

      const ab = new ArrayBuffer(10);
      expect(fromJS(ab)).toBe(ab);
    });

    it("passes through Promises", () => {
      const p = Promise.resolve(42);
      expect(fromJS(p)).toBe(p);
    });

    it("wraps functions in SchemeJSFunction", () => {
      const fn = () => 42;
      const wrapped = fromJS(fn);
      expect(wrapped).toBeInstanceOf(SchemeJSFunction);
      expect((wrapped as SchemeJSFunction).source).toBe(fn);
    });

    it("wraps objects in SchemeJSObject", () => {
      const obj = { a: 1 };
      const wrapped = fromJS(obj);
      expect(wrapped).toBeInstanceOf(SchemeJSObject);
      expect((wrapped as SchemeJSObject).source).toBe(obj);
    });

    it("returns same wrapper for same object (identity cache)", () => {
      const obj = { a: 1 };
      const wrapped1 = fromJS(obj);
      const wrapped2 = fromJS(obj);
      expect(wrapped1).toBe(wrapped2);
    });

    it("prevents double-wrapping", () => {
      const obj = { a: 1 };
      const wrapped = fromJS(obj);
      const doubleWrapped = fromJS(wrapped);
      expect(doubleWrapped).toBe(wrapped);
    });
  });

  describe("toJS", () => {
    it("converts nil to null", () => {
      expect(toJS(nil)).toBe(null);
    });

    it("unwraps SchemeJSObject", () => {
      const obj = { a: 1 };
      const wrapped = new SchemeJSObject(obj);
      expect(toJS(wrapped)).toBe(obj);
    });

    it("unwraps SchemeJSFunction", () => {
      const fn = () => 42;
      const wrapped = new SchemeJSFunction(fn);
      expect(toJS(wrapped)).toBe(fn);
    });

    it("converts SchemeString to string", () => {
      expect(toJS(new SchemeString("hello"))).toBe("hello");
    });

    it("converts SchemeExact to number (safe integers)", () => {
      // SchemeExact.valueOf() returns number for safe integers
      expect(toJS(new SchemeExact(42n))).toBe(42);
    });

    it("converts SchemeInexact to number", () => {
      expect(toJS(new SchemeInexact(3.14))).toBe(3.14);
    });

    it("passes through primitives", () => {
      expect(toJS(42)).toBe(42);
      expect(toJS("hello")).toBe("hello");
      expect(toJS(true)).toBe(true);
    });

    it("keeps SchemeSymbol as-is", () => {
      const sym = new SchemeSymbol("foo");
      expect(toJS(sym)).toBe(sym);
    });

    it("keeps Pair as-is", () => {
      const pair = new Pair(1, 2);
      expect(toJS(pair)).toBe(pair);
    });
  });

  describe("SchemeJSObject", () => {
    it("has TO_JS symbol", () => {
      const obj = new SchemeJSObject({});
      expect(TO_JS in obj).toBe(true);
      expect(obj[TO_JS]()).toEqual({});
    });

    it("gets properties with lazy wrapping", () => {
      const inner = { b: 2 };
      const obj = new SchemeJSObject({ a: 1, inner });

      // Option C (2026-05-28): `.get(key)` now boxes entries through
      // jsToLips so they inherit the wrapper's provenance — a primitive
      // surfaces as the corresponding AValue subtype, not raw JS. `valueOf`
      // unwraps to the underlying JS value for callers that need it.
      const a = obj.get("a");
      expect(a).toBeInstanceOf(SchemeExact);
      expect((a as SchemeExact).valueOf()).toBe(1);
      const wrappedInner = obj.get("inner");
      expect(wrappedInner).toBeInstanceOf(SchemeJSObject);
      expect((wrappedInner as SchemeJSObject).source).toBe(inner);
    });

    it("sets properties with unwrapping", () => {
      const source: any = {};
      const obj = new SchemeJSObject(source);

      obj.set("a", 42);
      expect(source.a).toBe(42);

      const inner = new SchemeJSObject({ x: 1 });
      obj.set("b", inner);
      expect(source.b).toEqual({ x: 1 });
    });

    it("checks property existence (own properties only)", () => {
      const obj = new SchemeJSObject({ a: 1 });
      expect(obj.has("a")).toBe(true);
      expect(obj.has("b")).toBe(false);
    });

    it("blocks inherited properties from Object.prototype", () => {
      const obj = new SchemeJSObject({ a: 1 });
      // These are inherited from Object.prototype - blocked by sandbox
      expect(obj.has("toString")).toBe(false);
      expect(obj.has("hasOwnProperty")).toBe(false);
      expect(obj.has("constructor")).toBe(false);
    });

    it("gets keys", () => {
      const obj = new SchemeJSObject({ a: 1, b: 2 });
      expect(obj.keys()).toEqual(["a", "b"]);
    });

    it("has toString", () => {
      const obj = new SchemeJSObject({});
      expect(obj.toString()).toBe("#<js-object>");
    });
  });

  describe("SchemeJSFunction", () => {
    it("has TO_JS symbol", () => {
      const fn = () => 42;
      const wrapped = new SchemeJSFunction(fn);
      expect(TO_JS in wrapped).toBe(true);
      expect(wrapped[TO_JS]()).toBe(fn);
    });

    it("calls function with unwrapped args", () => {
      const fn = (a: number, b: number) => a + b;
      const wrapped = new SchemeJSFunction(fn);

      const result = wrapped.call(1, 2);
      expect(result).toBe(3);
    });

    it("wraps return value", () => {
      const fn = () => ({ a: 1 });
      const wrapped = new SchemeJSFunction(fn);

      const result = wrapped.call();
      expect(result).toBeInstanceOf(SchemeJSObject);
    });

    it("unwraps SchemeJSObject args", () => {
      const fn = (obj: any) => obj.a;
      const wrapped = new SchemeJSFunction(fn);

      const arg = new SchemeJSObject({ a: 42 });
      const result = wrapped.call(arg);
      expect(result).toBe(42);
    });

    it("has toString with function name", () => {
      function namedFn() {}
      const wrapped = new SchemeJSFunction(namedFn);
      expect(wrapped.toString()).toBe("#<js-function namedFn>");
    });

    it("has toString for anonymous functions", () => {
      const wrapped = new SchemeJSFunction(() => {});
      expect(wrapped.toString()).toBe("#<js-function anonymous>");
    });
  });

  describe("Identity Preservation (roundtrip)", () => {
    it("preserves object identity through roundtrip", () => {
      const original = { a: 1 };
      const wrapped = fromJS(original);
      const unwrapped = toJS(wrapped);
      expect(unwrapped).toBe(original);
    });

    it("preserves function identity through roundtrip", () => {
      const original = () => 42;
      const wrapped = fromJS(original);
      const unwrapped = toJS(wrapped);
      expect(unwrapped).toBe(original);
    });

    it("preserves array identity (pass-through)", () => {
      const original = [1, 2, 3];
      const wrapped = fromJS(original);
      expect(wrapped).toBe(original);
    });

    it("preserves Uint8Array identity (pass-through)", () => {
      const original = new Uint8Array([1, 2, 3]);
      const wrapped = fromJS(original);
      expect(wrapped).toBe(original);
    });
  });
});
