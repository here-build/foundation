// -------------------------------------------------------------------------
import { EOF } from "../EOF.js";
import { is_function, is_instance, is_iterator, is_pair } from "../guards.js";
import { SchemeString } from "../LString.js";
import { SchemeSymbol } from "../LSymbol.js";
import { Macro } from "../Macro.js";
import { SchemeExact, SchemeInexact } from "../numbers.js";
import { Pair } from "../Pair.js";
import { type_constants } from "../primitives.js";
import { Syntax } from "../Syntax.js";
import { SchemeCharacter, Nil } from "../types.js";
import { Values } from "../Values.js";

export function typeErrorMessage(fn: unknown, got: string, expected: unknown, position: number | null = null) {
  let postfix = fn ? ` in expression \`${fn}\`` : "";
  if (position !== null) {
    postfix += ` (argument ${position})`;
  }
  if (is_function(expected)) {
    return `Invalid type: got ${got}${postfix}`;
  }
  if (Array.isArray(expected)) {
    if (expected.length === 1) {
      const first = expected[0].toLowerCase();
      expected = `a${"aeiou".includes(first) ? "n " : " "}${expected[0]}`;
    } else {
      expected = new Intl.ListFormat("en", {
        style: "long",
        type: "disjunction",
      }).format(expected);
    }
  }
  return `Expecting ${expected} got ${got}${postfix}`;
}

// -------------------------------------------------------------------------
// Type for values that have valueOf method (most Scheme values)
type Valuable = { valueOf(): unknown };

export function typecheck(fn: Valuable, arg: unknown, expected: Valuable | Function, position: number | null = null) {
  const fnStr = fn.valueOf();
  const arg_type = type(arg).toLowerCase();
  if (is_function(expected)) {
    if (!expected(arg)) {
      throw new Error(typeErrorMessage(fnStr, arg_type, expected, position));
    }
    return;
  }
  let match = false;
  let exp: unknown = expected;
  if (is_pair(exp)) {
    exp = exp.to_array();
  }
  if (Array.isArray(exp)) {
    exp = exp.map((x: Valuable) => x.valueOf());
  }
  if (Array.isArray(exp)) {
    const expArr = exp.map((x: Valuable) => String(x.valueOf()).toLowerCase());
    if (expArr.includes(arg_type)) {
      match = true;
    }
  } else {
    exp = String((exp as Valuable).valueOf()).toLowerCase();
  }
  if (!match && arg_type !== exp) {
    throw new Error(typeErrorMessage(fnStr, arg_type, exp, position));
  }
}

export function type(obj): string {
  const t = type_constants.get(obj);
  if (t) {
    return t;
  }
  if (typeof obj === "object") {
    // Check for number types first (no common base class)
    if (obj instanceof SchemeExact || obj instanceof SchemeInexact) {
      return "number";
    }
    const typeMapping = {
      pair: Pair,
      symbol: SchemeSymbol,
      array: Array,
      nil: Nil,
      character: SchemeCharacter,
      values: Values,
      regex: RegExp,
      syntax: Syntax,
      eof: EOF,
      macro: Macro,
      string: SchemeString,
      "native-symbol": Symbol,
    };
    for (const [key, value] of Object.entries(typeMapping)) {
      if (obj instanceof value) {
        return key;
      }
    }
    if (is_instance(obj)) {
      if (is_function(obj.typeOf)) {
        return obj.typeOf();
      }
      return "instance";
    }
    if (obj.constructor) {
      if (obj.constructor.__class__) {
        // Treat js-function as function for type checking (membrane wrapper)
        const cls = obj.constructor.__class__;
        return cls === "js-function" ? "function" : cls;
      }
      if (obj.constructor === Object) {
        if (is_iterator(obj, Symbol.iterator)) {
          return "iterator";
        }
        if (is_iterator(obj, Symbol.asyncIterator)) {
          return "async-iterator";
        }
      }
      if (obj.constructor.name === "") {
        return "object";
      }
      return obj.constructor.name.toLowerCase();
    }
  }
  if (obj === undefined) {
    return "void";
  }
  if (typeof obj === "bigint") {
    return "number";
  }
  return typeof obj;
}
// -------------------------------------------------------------------------
export function typecheck_args(fn, args, expected) {
  for (const [i, arg] of args.entries()) {
    typecheck(fn, arg, expected, i + 1);
  }
} // -------------------------------------------------------------------------
// Type for Scheme numbers that have __type__ property
type SchemeNumeric = { __type__: string; valueOf(): unknown };

export function typecheck_number(fn: Valuable, arg: SchemeNumeric, expected: Valuable, position: number | null = null) {
  typecheck(fn, arg, "number", position);
  const arg_type = arg.__type__;
  let match = false;
  let exp: unknown = expected;
  if (is_pair(exp)) {
    exp = exp.to_array();
  }
  if (Array.isArray(exp)) {
    exp = exp.map((x: Valuable) => x.valueOf());
  }
  if (Array.isArray(exp)) {
    const expArr = exp.map((x: Valuable) => String(x.valueOf()).toLowerCase());
    if (expArr.includes(arg_type)) {
      match = true;
    }
  } else {
    exp = String((exp as Valuable).valueOf()).toLowerCase();
  }
  if (!match && arg_type !== exp) {
    throw new Error(typeErrorMessage(fn.valueOf(), arg_type, exp, position));
  }
}
