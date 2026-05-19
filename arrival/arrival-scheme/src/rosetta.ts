/**
 * Rosetta Environment Extension
 *
 * Extends LIPS Environment with automatic LIPS ↔ JS conversion for seamless interop.
 * Provides Environment.defineRosetta() for declarative function wrapping.
 */

import { SchemeJSArray, SchemeJSObject } from "./membrane.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { nil } from "./types.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
  /**
   * When true, the rosetta receives the current EvalContext as its LAST
   * argument (after all scheme args, post-lipsToJs conversion). The
   * evaluator detects this via a `__withCtx` flag on the produced wrapper
   * and appends `ctx` at call time. Off by default — back-compat.
   */
  withContext?: boolean;
}

const isLipsPair = (x: any): boolean => x && typeof x === "object" && "car" in x && "cdr" in x;

export function lipsToJs(value: any, options: RosettaOptions = {}): any {
  // Handle null/undefined
  if (value == null || value === nil) return value;

  // Handle JS arrays (convert elements recursively)
  if (Array.isArray(value)) {
    return value.map((record) => lipsToJs(record, options));
  }

  // Handle ExactNumber and InexactNumber
  if (value instanceof SchemeExact) {
    const val = value.valueOf();
    if (options.forceBigInt) {
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    // For exact integers, return number if safe
    if (value.denom === 1n) {
      if (value.num >= BigInt(Number.MIN_SAFE_INTEGER) && value.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value.num);
      }
      return value.num; // Return bigint for large numbers
    }
    // For rationals, return the float value
    return val;
  }

  if (value instanceof SchemeInexact) {
    // InexactNumber is always a JS float, just return real part (or complex handling if needed)
    if (value.imag !== 0) {
      // For complex numbers, return as object or just real part depending on use case
      return { real: value.real, imag: value.imag };
    }
    return value.real;
  }

  // Unwrap SchemeJSObject to source object
  if (value instanceof SchemeJSObject) {
    return lipsToJs(value.source, options);
  }

  // Unwrap SchemeJSArray to JS array
  if (value instanceof SchemeJSArray) {
    return value.source.map((el: any) => lipsToJs(el, options));
  }

  // Handle SchemeString and Pair
  if (value && typeof value === "object") {
    if ("__string__" in value && typeof value.__string__ === "string") {
      return value.__string__;
    }
    // since for lisp empty list and nil is same entity, we specifically handle this scenario as
    // "if eventually cdr is nil, and we're materializing the array, it's array tail"
    if (isLipsPair(value)) {
      const head = lipsToJs(value.car, options);
      const tail = lipsToJs(value.cdr, options) ?? [];
      if (Array.isArray(tail)) {
        return [head, ...tail];
      } else if (tail === nil) {
        return [head];
      } else {
        return [head, tail];
      }
    }
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, lipsToJs(value, options)]));
    }
    // Check for Fantasy Land entities BEFORE converting to plain objects
    if (
      value["fantasy-land/map"] !== undefined ||
      value["fantasy-land/filter"] !== undefined ||
      value["fantasy-land/reduce"] !== undefined
    ) {
      // Preserve Fantasy Land entities as-is
      return value;
    }

    // todo traverse enumerable fields?
  }

  if (typeof value === "number" && options.forceBigInt) {
    return BigInt(value);
  }

  return value;
}

export function jsToLips(value: any, options: RosettaOptions = {}): any {
  if (value == null) {
    return nil;
  }
  if (Array.isArray(value)) {
    return value.map((record) => jsToLips(record, options)).reduceRight((acc, record) => new Pair(record, acc), nil);
  }
  if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
    // todo ideally we should return proxies to support reflecting live objects and also get performance wins, but
    // this is good enough for current sandbox needs
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, jsToLips(value, options)]));
  }
  return value;
}

export const createRosettaWrapper = ({ fn, options = {}, withContext = false }: RosettaFunction) => {
  const rosettaWrapper = async function rosettaWrapper(...args: any[]) {
    // When withContext, the evaluator appends EvalContext as the final arg.
    // We strip it off, then pass it to the user fn FIRST (so variadic scheme
    // args don't shift ctx around when called with fewer than max arity).
    let ctx: unknown = undefined;
    let schemeArgs = args;
    if (withContext) {
      ctx = args[args.length - 1];
      schemeArgs = args.slice(0, -1);
    }
    const jsArgs = schemeArgs.map((arg) => lipsToJs(arg, options));
    const callArgs = withContext ? [ctx, ...jsArgs] : jsArgs;

    try {
      const result = jsToLips(await fn(...callArgs), options);
      return options.returnEither ? [result, nil] : result;
    } catch (error) {
      console.error("Rosetta function error:", error);
      if (options.returnEither) {
        return [nil, error];
      } else {
        throw error;
      }
    }
  };
  if (withContext) {
    (rosettaWrapper as { __withCtx?: boolean }).__withCtx = true;
  }
  return rosettaWrapper;
};

declare module "@here.build/arrival-scheme" {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}
