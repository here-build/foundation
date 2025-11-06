/**
 * Rosetta Environment Extension
 *
 * Extends LIPS Environment with automatic LIPS ↔ JS conversion for seamless interop.
 * Provides Environment.defineRosetta() for declarative function wrapping.
 */

import { nil, Pair } from "./lips";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
}

const isLipsPair = (x: any): boolean => x && typeof x === "object" && "car" in x && "cdr" in x;

export function lipsToJs(value: any, options: RosettaOptions = {}): any {
  // Handle null/undefined
  if (value == null || value === nil) return value;

  // Handle JS arrays (convert elements recursively)
  if (Array.isArray(value)) {
    return value.map((record) => lipsToJs(record, options));
  }

  // Handle LIPS numbers (LBigInteger, LFloat, etc.)
  if (value && typeof value === "object") {
    if (value.__value__ !== undefined) {
      const val = value.__value__;
      if (options.forceBigInt) {
        return BigInt(val);
      }
      return typeof val === "bigint" && val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(val)
        : val;
    }
    if (value.__string__ !== undefined) {
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
    return value.map((record) => jsToLips(record, options)).reduceRight((acc, record) => Pair(record, acc), nil);
  }
  if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
    // todo ideally we should return proxies to support reflecting live objects and also get performance wins, but
    // this is good enough for current sandbox needs
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, jsToLips(value, options)]));
  }
  return value;
}

export const createRosettaWrapper = ({ fn, options = {} }: RosettaFunction) =>
  async function rosettaWrapper(...args: any[]) {
    // Convert LIPS arguments to JS
    const jsArgs = args.map((arg) => lipsToJs(arg, options));

    try {
      const result = jsToLips(await fn(...jsArgs), options);
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

declare module "@here.build/arrival-scheme" {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}
