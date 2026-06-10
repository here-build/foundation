/**
 * Forked from LIPS.js - Scheme-based Lisp interpreter
 * Copyright (c) 2018-2024 Jakub T. Jankiewicz <https://jcubic.pl/me>
 * Released under the MIT license
 * https://github.com/jcubic/lips
 */
import invariant from "tiny-invariant";
import { AValue, unionProvenance } from "./AValue.js";
import { Environment, KEYWORD_ACCESSOR_FIELD, setLipsRuntime } from "./Environment.js";
import { eof } from "./EOF.js";
import { HalfBaked, is_half_baked } from "./HalfBaked.js";
import { Lexer } from "./Lexer.js";
import { Parameter } from "./Parameter.js";
import { Parser } from "./Parser.js";
import { QuotedPromise } from "./QuotedPromise.js";
import { Formatter } from "./Formatter.js";
import {
  is_directive,
  is_env,
  is_false,
  is_function,
  is_iterator,
  is_lambda,
  is_native,
  is_native_function,
  is_nil,
  is_null,
  is_pair,
  is_plain_object,
  is_promise,
  is_prototype,
  is_raw_lambda,
} from "./guards.js";
import { SchemeSymbol } from "./LSymbol.js";
import { eq, eqv } from "./structural-equal.js";
import { clear_gensyms, extract_patterns, macro_expand, transform_syntax } from "./syntax-rules.js";
import { gensym, hidden_prop, quote } from "./values-repr.js";
import {
  __context__,
  __data__,
  __fn__,
  __lambda__,
  __prototype__,
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  parsable_contants,
  rational_bare_re,
  rational_re,
} from "./primitives.js";
import { nil, SchemeCharacter } from "./types.js";
import * as specials from "./specials.js";
import { call_function } from "./call-function.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { type, typecheck, typecheck_args, typeErrorMessage } from "./utils/typecheck.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "./utils/parsing.js";
import { Values } from "./Values.js";
import { available_class, class_map, unserialize } from "./serialize.js";
import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { isCircularList, Pair } from "./Pair.js";
import { promise_all, unpromise } from "./utils/promises.js";
import { compose, curry, fold, pipe } from "./utils/functional.js";

import { SchemeBool } from "./LBool.js";
import { SchemeBytevector } from "./LBytevector.js";
import { SchemeString } from "./LString.js";
import { SchemeVector } from "./LVector.js";
import { NOT_FOUND, SandboxViolationError, SchemeJSFunction, SchemeJSObject, sandboxedAccess } from "./membrane.js";
import genRun, { type EvalContext, evaluate as genEvaluate, isSpeculating, SchemeError } from "./evaluator.js";

// Declare jQuery for browser environments
declare const jQuery: { fn: { init: new (...args: unknown[]) => object } } | undefined;

const SyntaxParameter = Syntax.Parameter;

// Type definitions for dynamic Scheme values
// Scheme is inherently dynamic - these use `any` intentionally for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeFunction = (...args: any[]) => any;

let env: Environment;
// -------------------------------------------------------------------------

/* c8 ignore next 13 */
function log(x: SchemeValue, ...args: SchemeValue[]): void {
  if (is_plain_object(x) && is_debug(args[0])) {
    console.log(
      map_object(x, function (value) {
        return toString(value, true);
      }),
    );
  } else if (is_debug()) {
    console.log(
      toString(x, true),
      ...args.map((item) => {
        return toString(item, true);
      }),
    );
  }
}

// ----------------------------------------------------------------------
/* c8 ignore next */
function is_debug(n: SchemeValue = null): boolean {
  const debug = user_env?.get("DEBUG", { throwError: false });
  if (n === null) {
    return debug === true;
  }
  return debug?.valueOf() === n.valueOf();
}

// ----------------------------------------------------------------------
function escape_regex(str: SchemeValue): SchemeValue {
  if (typeof str === "string") {
    const special = /([-\\^$[\]()+{}?*.|])/g;
    return str.replaceAll(special, String.raw`\$1`);
  }
  return str;
}

// ----------------------------------------------------------------------
function tokens(str: SchemeValue): SchemeValue[] {
  if (str instanceof SchemeString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: SchemeValue[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    result.push(token);
    lexer.skip();
  }
  return result;
}

// ----------------------------------------------------------------------
export function tokenize(str: string | SchemeString, meta = false) {
  if (str instanceof SchemeString) {
    str = str.toString();
  }
  if (meta) {
    return tokens(str);
  } else {
    const result = tokens(str)
      .map(function (token) {
        // we don't want literal space character to be trimmed
        if (token.token === String.raw`#\ ` || token.token == "#\\\n") {
          return token.token;
        }
        return token.token.trim();
      })
      .filter(function (token) {
        return token && !token.startsWith(";") && !/^#\|[\s\S]*\|#$/.test(token);
      });
    return strip_s_comments(result);
  }
}

// ----------------------------------------------------------------------
function strip_s_comments(tokens: string[]): string[] {
  let s_count = 0;
  let s_start: number | null = null;
  const remove_list: [number, number][] = [];
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token === "#;") {
      if (["(", "["].includes(tokens[i + 1])) {
        s_count = 1;
        s_start = i;
      } else {
        remove_list.push([i, i + 2]);
      }
      i += 1;
      continue;
    }
    if (s_start !== null) {
      if ([")", "]"].includes(token)) {
        s_count--;
      } else if (["(", "["].includes(token)) {
        s_count++;
      }
      if (s_count === 0) {
        remove_list.push([s_start, i + 1]);
        s_start = null;
      }
    }
  }
  tokens = [...tokens];
  remove_list.reverse();
  for (const [begin, end] of remove_list) {
    tokens.splice(begin, end - begin);
  }
  return tokens;
}

// Helper functions used by gensym - imported types have their own copies
function symbol_to_string(obj: SchemeValue): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

// ----------------------------------------------------------------------
// :: helper function that make symbols in names array hygienic
// ----------------------------------------------------------------------
function hygienic_begin(envs, expr) {
  const begin = global_env.get("begin");
  const g_begin = gensym("begin");
  for (const env of envs) {
    env.set(g_begin, begin);
  }
  return new Pair(g_begin, expr);
}

// ----------------------------------------------------------------------
specials.on(["remove", "append"], function () {
  Lexer._cache.valid = false;
  Lexer._cache.rules = null;
});

// ----------------------------------------------------------------------
// :: Tokens are the array of strings from tokenizer
// :: the return value is an array of lips code created out of Pair class.
// :: env is needed for parser extensions that will invoke the function
// :: or macro assigned to symbol, this function is async because
// :: it evaluates the code, from parser extensions, that may return a promise.
// ----------------------------------------------------------------------
async function* _parse(arg: SchemeValue, env?: Environment, source?: string) {
  if (!env) {
    env = global_env
      ? (global_env.get("**interaction-environment**", {
          throwError: false,
        }) as Environment)
      : user_env;
  }
  let parser;
  if (arg instanceof Parser) {
    parser = arg;
  } else {
    parser = new Parser({ env, source });
    parser.parse(arg);
  }
  let prev;
  while (true) {
    const expr = await parser.read_object();
    if (!parser.balanced()) {
      parser.ballancing_error(expr, prev);
    }
    if (expr === eof) {
      break;
    }
    prev = expr;
    yield expr;
  }
}

// Re-export unpromise from utils/promises
export { unpromise as unpromise };

// ----------------------------------------------------------------------
// :: Function that return matcher function that match string against string
// ----------------------------------------------------------------------
function matcher(name, arg) {
  if (arg instanceof RegExp) {
    return (x) => String(x).match(arg);
  } else if (is_function(arg)) {
    // it will always be function
    return arg;
  }
  throw new Error("Invalid matcher");
}

// ----------------------------------------------------------------------
// :: Sets __name__ on functions for Scheme representation
// :: Needed because Scheme names (empty?, set-car!) aren't valid JS identifiers
// ----------------------------------------------------------------------
export function doc(name: string | null, fn: SchemeValue, docstring?: string) {
  if (name) {
    fn.__name__ = name;
  } else if (fn.name && !is_lambda(fn)) {
    fn.__name__ = fn.name;
  }
  if (docstring) {
    fn.__doc__ = docstring;
  }
  return fn;
}

/**
 * Mark a builtin as understanding a `HalfBaked` arg (Tier 2 speculative
 * evaluation). The dispatch choke (evaluator.ts) skips forcing the args of a
 * marked callable, so the builtin reads the lazy carrier itself (its cardinality
 * interval) instead of receiving a settled value. Only `length` and the
 * comparison ops are marked; everything else gets force-on-unknown-boundary.
 */
function speculative<T>(fn: T): T {
  (fn as { __speculate__?: boolean }).__speculate__ = true;
  return fn;
}

// ----------------------------------------------------------------------
function to_array(name: string, deep = false): SchemeFunction {
  return function recur(this: Environment, list: SchemeValue): SchemeValue[] {
    typecheck(name, list, ["pair", "nil"]);
    if (is_nil(list)) {
      return [];
    }
    // have_cycles() below only catches reader #0= cycles; actively detect a
    // runtime set-cdr! cycle so we raise a clean error instead of growing the
    // array until "Invalid array length" (the reverse symptom).
    if (isCircularList(list)) {
      invariant(false, `${name}: can't convert a circular list`);
    }
    const result: SchemeValue[] = [];
    let node = list;
    while (true) {
      if (is_pair(node)) {
        if (node.have_cycles("cdr")) {
          break;
        }
        let car = node.car;
        if (deep && is_pair(car)) {
          car = (this.get(name) as SchemeFunction).call(this, car);
        }
        result.push(car);
        node = node.cdr;
      } else {
        invariant(is_nil(node), `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}

// Old Pair prototype methods are now in the Pair class above

const repr = new Map();

// ----------------------------------------------------------------------
const props = Object.getOwnPropertyNames(Array.prototype);
const array_methods: SchemeValue[] = [];
for (const x of props) {
  array_methods.push((Array as SchemeValue)[x], Array.prototype[x as keyof typeof Array.prototype]);
}

// ----------------------------------------------------------------------
function is_array_method(x) {
  x = unbind(x);
  return array_methods.includes(x);
}

// ----------------------------------------------------------------------
function is_lips_function(x) {
  return is_function(x) && (is_lambda(x) || x.__name__);
}

// ----------------------------------------------------------------------
function user_repr(obj) {
  const constructor = obj.constructor || Object;
  const plain_object = is_plain_object(obj);
  const iterator = is_function(obj[Symbol.asyncIterator]) || is_function(obj[Symbol.iterator]);
  let fn;
  if (repr.has(constructor)) {
    fn = repr.get(constructor);
  } else {
    for (let [key, value] of repr.entries()) {
      key = unbind(key);
      // if key is Object it should only work for plain_object
      // because otherwise it will match every object
      // we don't use instanceof so it don't work for subclasses
      if (constructor === key && ((key === Object && plain_object && !iterator) || key !== Object)) {
        fn = value;
      }
    }
  }
  return fn;
}

// ----------------------------------------------------------------------
const str_mapping = new Map();
for (const [key, value] of [
  [true, "#t"],
  [false, "#f"],
  [null, "#null"],
  [undefined, "#void"],
]) {
  str_mapping.set(key, value);
}
// ----------------------------------------------------------------------
// :: Debug function that can be used with JSON.stringify
// :: that will show symbols
// ----------------------------------------------------------------------
/* c8 ignore next 22 */
function symbolize(obj) {
  if (obj && typeof obj === "object") {
    const result = {};
    const symbols = Object.getOwnPropertySymbols(obj);
    for (const key of symbols) {
      const name = key.toString().replace(/Symbol\(([^)]+)\)/, "$1");
      result[name] = toString(obj[key]);
    }
    const props = Object.getOwnPropertyNames(obj);
    for (const key of props) {
      const o = obj[key];
      result[key] = o && typeof o === "object" && o.constructor === Object ? symbolize(o) : toString(o);
    }
    return result;
  }
  return obj;
}

// ----------------------------------------------------------------------
export function get_props(obj: object): (string | symbol)[] {
  return (Object.keys(obj) as (string | symbol)[]).concat(Object.getOwnPropertySymbols(obj));
}

// ----------------------------------------------------------------------
function has_own_function(obj, name) {
  return obj.hasOwnProperty(name) && is_function(obj.toString);
}

// ----------------------------------------------------------------------
function function_to_string(fn) {
  if (is_native_function(fn)) {
    return "#<procedure(native)>";
  }
  if (fn.hasOwnProperty("__name__")) {
    let name = fn.__name__;
    if (typeof name === "symbol") {
      name = symbol_to_string(name);
    }
    if (typeof name === "string") {
      return `#<procedure:${name}>`;
    }
  }
  if (has_own_function(fn, "toString")) {
    return fn.toString();
  } else if (fn.name && !is_lambda(fn)) {
    return `#<procedure:${fn.name.trim()}>`;
  } else {
    return "#<procedure>";
  }
}

// ----------------------------------------------------------------------
// Instances extracted to make cyclomatic complexity of toString smaller
let _instances: Map<any, Function> | null = null;
function get_instances() {
  if (!_instances) {
    _instances = new Map();
    for (const [cls, fn] of [
      [
        Error,
        function (e: Error) {
          return e.message;
        },
      ],
      [
        Pair,
        function (pair: Pair, { quote, skip_cycles, pair_args }: any) {
          // make sure that repr directly after update set the cycle ref
          if (!skip_cycles) {
            pair.mark_cycles();
          }
          return pair.toString(quote, ...pair_args);
        },
      ],
      [
        SchemeCharacter,
        function (chr: SchemeCharacter, { quote }: any) {
          if (quote) {
            return chr.toString();
          }
          return chr.valueOf();
        },
      ],
      [
        SchemeString,
        function (str: SchemeString, { quote }: any) {
          const strVal = str.toString();
          if (quote) {
            return JSON.stringify(strVal).replaceAll(String.raw`\n`, "\n");
          }
          return strVal;
        },
      ],
      [
        RegExp,
        function (re: RegExp) {
          return `#${re.toString()}`;
        },
      ],
      [
        // Boxed vectors render as their R7RS external representation #(...),
        // recursing through `toString` so nested vectors/strings format correctly
        // and `quote` propagates. (Without this they fell through to the generic
        // #<__class__> / #<JS-class-name> garbage — the only user-facing stringify
        // in the MCP bridge env. Cyclic vectors are not datum-labelled here; repr
        // of a runtime-cyclic vector is a known gap, as for cyclic data generally.)
        SchemeVector,
        function (vec: SchemeVector, { quote }: any) {
          return `#(${vec.__vector__.map((el) => toString(el, quote)).join(" ")})`;
        },
      ],
      [
        SchemeBytevector,
        function (bv: SchemeBytevector) {
          return `#u8(${Array.from(bv.__bytevector__).join(" ")})`;
        },
      ],
    ]) {
      _instances.set(cls, fn);
    }
  }
  return _instances;
}
// ----------------------------------------------------------------------
let _native_types: any[] | null = null;
function get_native_types() {
  if (!_native_types) {
    _native_types = [SchemeSymbol, Macro, Values, Environment, QuotedPromise];
  }
  return _native_types;
}

// ----------------------------------------------------------------------
function toString(obj: unknown, quote = false, skip_cycles = false, ...pair_args: unknown[]): string {
  if (typeof jQuery !== "undefined" && obj instanceof jQuery.fn.init) {
    return `#<jQuery(${(obj as { length: number }).length})>`;
  }
  if (str_mapping.has(obj)) {
    return str_mapping.get(obj);
  }
  if (is_prototype(obj)) {
    return "#<prototype>";
  }
  if (obj) {
    const cls = obj.constructor;
    const instances = get_instances();
    if (instances.has(cls)) {
      return instances.get(cls)!(obj, { quote, skip_cycles, pair_args });
    }
  }
  // standard objects that have toString
  for (const type of get_native_types()) {
    if (obj instanceof type) {
      return (obj as SchemeValue).toString(quote);
    }
  }
  if (obj instanceof SchemeExact || obj instanceof SchemeInexact) {
    return obj.toString();
  }
  // constants
  if ([nil, eof].includes(obj as typeof nil)) {
    return (obj as SchemeValue).toString();
  }
  if (obj === globalThis) {
    return "#<js:global>";
  }
  if (obj === null) {
    return "null";
  }
  if (is_function(obj)) {
    if (is_function(obj.toString) && obj.hasOwnProperty("toString")) {
      // promises
      return obj.toString().valueOf();
    }
    return function_to_string(obj);
  }
  if (typeof obj === "object") {
    let constructor = obj.constructor;
    if (!constructor) {
      // This is case of fs.constants in Node.js that is null constructor object.
      // This object can be handled like normal objects that have properties
      constructor = Object;
    }
    let name;
    if (typeof (constructor as SchemeValue).__class__ === "string") {
      name = (constructor as SchemeValue).__class__;
    } else {
      const fn = user_repr(obj);
      if (fn) {
        invariant(is_function(fn), "toString: Invalid repr value");
        return fn(obj, quote);
      }
      name = constructor.name;
    }
    // user defined representation
    if (is_function(obj.toString) && obj.hasOwnProperty("toString")) {
      return obj.toString().valueOf();
    }
    if (type(obj) === "instance") {
      if (is_lambda(constructor) && (constructor as SchemeValue).__name__) {
        name = (constructor as SchemeValue).__name__.valueOf();
        if (typeof name === "symbol") {
          name = name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1");
        }
      } else if (!is_native_function(constructor)) {
        name = "instance";
      }
    }
    if (is_iterator(obj, Symbol.iterator)) {
      if (name) {
        return `#<iterator(${name})>`;
      }
      return "#<iterator>";
    }
    if (is_iterator(obj, Symbol.asyncIterator)) {
      if (name) {
        return `#<asyncIterator(${name})>`;
      }
      return "#<asyncIterator>";
    }
    if (name !== "") {
      return `#<${name}>`;
    }
    return "#<Object>";
  }
  if (obj != null && typeof obj !== "string") {
    return obj.toString();
  }
  return obj ?? "";
}

// ----------------------------------------------------------------------
// eq/eqv moved to structural-equal.ts; the macro engine (macro_expand /
// extract_patterns / clear_gensyms / transform_syntax / self_evaluated)
// moved to syntax-rules.ts (keystone K3) and is imported above.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// :: Function utilities
// ----------------------------------------------------------------------
function box(object) {
  // We only need to box lips data and arrays. Object don't need
  // to be boxed, but values from objects will be boxed when accessed.
  switch (typeof object) {
    case "string":
      return new SchemeString(object);
    case "bigint":
      return new SchemeExact(object);
    case "number":
      if (Number.isNaN(object)) return nan;
      // Safe integers become exact, floats become inexact
      if (Number.isSafeInteger(object)) {
        return new SchemeExact(BigInt(object));
      }
      return new SchemeInexact(object);
  }
  return object;
}

// ----------------------------------------------------------------------
function map_object(object, fn) {
  const props = Object.getOwnPropertyNames(object);
  const symbols = Object.getOwnPropertySymbols(object);
  const result = {};
  for (const key of [...props, ...symbols]) {
    result[key] = fn(object[key]);
  }
  return result;
}

// ----------------------------------------------------------------------
function unbox(object) {
  const lips_type =
    object instanceof SchemeString ||
    object instanceof SchemeCharacter ||
    object instanceof SchemeExact ||
    object instanceof SchemeInexact;
  if (lips_type) {
    return object.valueOf();
  }
  if (object instanceof SchemeVector) {
    return object.__vector__.map(unbox);
  }
  if (object instanceof SchemeBytevector) {
    return object.__bytevector__;
  }
  if (Array.isArray(object)) {
    return object.map(unbox);
  }
  if (object instanceof QuotedPromise) {
    delete (object as SchemeValue).then;
  }
  if (is_plain_object(object)) {
    return map_object(object, unbox);
  }
  return object;
}

// ----------------------------------------------------------------------
export function patch_value(value, context) {
  if (is_pair(value)) {
    value.mark_cycles();
    return quote(value);
  }
  if (
    is_function(value) && // original function can be restored using unbind function
    // only real JS function require to be bound
    context
  ) {
    return bind(value, context);
  }
  return box(value);
}

// ----------------------------------------------------------------------
// :: Function gets original function that was binded with props
// ----------------------------------------------------------------------
export function unbind(obj) {
  if (is_bound(obj)) {
    return obj[__fn__];
  }
  return obj;
}

// ----------------------------------------------------------------------
// :: Function binds with context that can be optionally unbind
// :: get original function with unbind
// ----------------------------------------------------------------------
function bind(fn, context) {
  if (fn[Symbol.for("__bound__")]) {
    return fn;
  }
  const bound = fn.bind(context);
  const props = Object.getOwnPropertyNames(fn);
  for (const prop of props) {
    if (filter_fn_names(prop)) {
      try {
        bound[prop] = fn[prop];
      } catch {
        // ignore error from express.js while accessing bodyParser
      }
    }
  }
  hidden_prop(bound, "__fn__", fn);
  hidden_prop(bound, "__context__", context);
  hidden_prop(bound, "__bound__", true);
  if (is_native_function(fn)) {
    hidden_prop(bound, "__native__", true);
  }
  if (is_plain_object(context) && is_lambda(fn)) {
    hidden_prop(bound, "__method__", true);
  }
  bound.valueOf = function () {
    return fn;
  };
  return bound;
}

// ----------------------------------------------------------------------
// Function used to check if function should not get unboxed arguments,
// so you can call Object.getPrototypeOf for lips data types
// this is case, see dir function and #73
// ----------------------------------------------------------------------
function is_object_bound(obj) {
  return is_bound(obj) && obj[Symbol.for("__context__")] === Object;
}

// ----------------------------------------------------------------------
function is_bound(obj) {
  return !!(is_function(obj) && obj[__fn__]);
}

// ----------------------------------------------------------------------
function lips_context(obj) {
  if (is_function(obj)) {
    const context = obj[__context__];
    if (context && (context === lips || context.constructor?.__class__)) {
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------
// :: Function bind fn with context but it also move all props
// :: mostly used for Object function
// ----------------------------------------------------------------------
const exluded_names = new Set(["name", "length", "caller", "callee", "arguments", "prototype"]);

function filter_fn_names(name) {
  return !exluded_names.has(name);
}

// ----------------------------------------------------------------------
// :: Stub macros for let/let*/letrec - generator evaluator handles these as special forms
// :: These stubs exist only for LIPS evaluate compatibility during bootstrap
// ----------------------------------------------------------------------
// let_macro removed — let/let*/letrec/letrec* now delegate to generator evaluator via genMacroWrapper

// -------------------------------------------------------------------------
// :: Parallel evaluation helper - used by begin*
// -------------------------------------------------------------------------
function parallel(name: string, fn: SchemeFunction): Macro {
  return new Macro(name, function (this: Environment, code: SchemeValue, { use_dynamic, error }: SchemeValue = {}) {
    const env = this;
    const dynamic_env = this;
    const results: SchemeValue[] = [];
    let node = code;
    while (is_pair(node)) {
      // Drain: route each sub-expr through the generator. genRun always returns a
      // promise, so the promise_all branch below is now always taken — correct for
      // begin*, whose whole point is parallel async evaluation.
      results.push(genRun(genEvaluate(node.car, { env, dynamic_env, use_dynamic, error })));
      node = node.cdr;
    }
    const havePromises = results.filter(is_promise).length;
    return havePromises ? (promise_all(results) as Promise<unknown[]>).then(fn.bind(this)) : fn.call(this, results);
  });
}

// -------------------------------------------------------------------------
// :: Quote function used to pause evaluation from Macro
// -------------------------------------------------------------------------
// quote moved to values-repr.ts; re-exported here to preserve the public barrel.
export { quote };

// -------------------------------------------------------------------------------
const native_lambda = _parse(
  tokenize(`(lambda ()
                                        "[native code]"
                                        (throw "Invalid Invocation"))`),
)[0];
// -------------------------------------------------------------------------------
export const get = doc("get", function get(object, ...args) {
  let value;
  const len = args.length;
  while (args.length > 0) {
    // if arg is symbol someone probably want to get __fn__ from binded function
    if (is_function(object) && typeof args[0] !== "symbol") {
      object = unbind(object);
    }
    const arg = args.shift();
    const name = unbox(arg);
    // the value was set to false to prevent resolving
    // by Real Promises #153
    if (name === "then" && object instanceof QuotedPromise) {
      value = QuotedPromise.prototype.then;
    } else if (name === "__code__" && is_function(object) && object.__code__ === undefined) {
      value = native_lambda;
    } else if (object instanceof SchemeJSObject) {
      // Use SchemeJSObject.get() for sandboxed membrane access
      value = object.get(name);
    } else {
      // Route raw property access through the SAME isolation as `@` /
      // SchemeJSObject.get: blocked names (constructor, __proto__, prototype, …)
      // and inherited props past a sandbox boundary (Function.prototype.*,
      // Array.prototype.*) must not be reachable via dot-notation — otherwise
      // `f.constructor("…")()` is RCE. Absent or blocked → undefined, the
      // chain-terminator the `value === undefined` check below already handles.
      const key = typeof name === "symbol" ? name : String(name);
      try {
        const accessed = sandboxedAccess(object, key);
        value = accessed === NOT_FOUND ? undefined : accessed;
      } catch (e) {
        if (e instanceof SandboxViolationError) {
          value = undefined;
        } else {
          throw e;
        }
      }
    }
    if (value === undefined) {
      invariant(args.length === 0, () => `Try to get ${args[0]} from undefined`);
      return value;
    } else {
      value = patch_value(value, args.length - 1 < len ? object : undefined);
    }
    object = value;
  }
  return value;
});
// -------------------------------------------------------------------------
const internal_env = new Environment(
  "internal",
  {
    // those will be compiled by babel regex plugin
    "letter-unicode-regex": /\p{L}/u,
    "numeral-unicode-regex": /\p{N}/u,
    "space-unicode-regex": /\s/u,
  },
  undefined,
);
// ----------------------------------------------------------------------
const nan = new SchemeInexact(Number.NaN);
const constants = {
  "#t": true,
  "#f": false,
  "#true": true,
  "#false": false,
  "+inf.0": Number.POSITIVE_INFINITY,
  "-inf.0": Number.NEGATIVE_INFINITY,
  "+nan.0": nan,
  "-nan.0": nan,
  ...parsable_contants,
};

const is_node = () => typeof process === "object" && !!process.env;

// -------------------------------------------------------------------------
// :: Thin wrapper: delegates a special form to the generator evaluator.
// :: LIPS evaluate dispatches to these Macros, which hand off to the
// :: generator's evaluate + run. This lets us delete the complex,
// :: poorly-typed LIPS Macro implementations for forms the generator
// :: already handles correctly.
// -------------------------------------------------------------------------
function genMacroWrapper(name: string): Macro {
  return new Macro(name, function (this: Environment, code: SchemeValue, options: SchemeValue = {}) {
    const form = new Pair(new SchemeSymbol(name), code);
    const ctx: EvalContext = {
      env: this,
      dynamic_env: options.dynamic_env ?? this,
      use_dynamic: options.use_dynamic,
    };
    // Quote Pair results so evaluate_macro doesn't re-evaluate them as code.
    // The LIPS evaluator checks __data__ flag — without it, a Pair like
    // (list "a" "b") would be treated as a function call ("a" "b").
    return genRun(genEvaluate(form, ctx)).then((value: SchemeValue) => {
      if (is_pair(value)) {
        (value as Pair).mark_cycles();
        return quote(value);
      }
      return value;
    });
  });
}

/**
 * Stamp `result` with the union of `args`' provenances. Boxes raw JS strings
 * via `AValue.fromJs` so provenance has somewhere to live — bool/number/bigint
 * deliberately excluded (boxing bool broke `find`'s `!== false` checks in the
 * L2 trace.ts kludge; we keep that landmine sealed here for the same reason).
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

// -------------------------------------------------------------------------
export const global_env = new Environment(
  "global",
  {
    eof,
    undefined, // undefined as parser constant breaks most of the unit tests
    // ------------------------------------------------------------------
    cons: doc("cons", function cons(car, cdr) {
      return withInputProvenance([car, cdr], new Pair(car, cdr));
    }),
    // ------------------------------------------------------------------
    // Spec §5.3 car/cdr element-only provenance.
    //
    // War story: previously `withInputProvenance([list], list.car)` unioned
    // the *container*'s provenance into the *element*'s — so `(car xs)`
    // returned a value stamped with every id that contributed to xs, even
    // those carried by sibling cdr elements or the spine itself. That violates
    // the spec §5.3 rule that car/cdr are *projections*: the result inherits
    // ONLY the element's own provenance, not the container's. The audit
    // surfaced this as the algebra gap behind a class of phantom-contributor
    // attributions in downstream consumers.
    //
    // Fix: pass `list.car` (resp. `list.cdr`) as the single provenance input.
    // - If element is an AValue, `withInputProvenance` re-stamps with its own
    //   provenance (effectively a no-op clone — preserves element identity).
    // - If element is raw JS (string/bool/number), `withInputProvenance`
    //   skips work because `inputs.length === 0`; the element is returned
    //   unchanged, which is correct because raw values have no container-
    //   borrowed provenance to incorrectly carry.
    //
    // `cons`, `list`, and `length` are CONSTRUCTORS / aggregations, not
    // projections — they correctly retain `withInputProvenance([car, cdr], …)`
    // unioning over all inputs.
    car: doc("car", function car(list) {
      typecheck("car", list, "pair");
      return withInputProvenance([list.car], list.car);
    }),
    // ------------------------------------------------------------------
    cdr: doc("cdr", function cdr(list) {
      typecheck("cdr", list, "pair");
      return withInputProvenance([list.cdr], list.cdr);
    }),
    // ------------------------------------------------------------------
    // `(dict :k v …)` — the canonical open-key map form, companion to the
    // `(:key d)` accessor. A keyword in argument position evaluates to its
    // property accessor, branded with the bare key via KEYWORD_ACCESSOR_FIELD;
    // read that to build a plain object. The serializer prints `(dict …)`, and
    // arrival-chain-view transpiles it to a JS/Python object literal.
    dict: doc("dict", function dict(...args: SchemeValue[]) {
      const obj: Record<string, SchemeValue> = {};
      for (let i = 0; i + 1 < args.length; i += 2) {
        const k = args[i] as { [KEYWORD_ACCESSOR_FIELD]?: string } | null;
        const key =
          (k != null &&
            (typeof k === "function" || typeof k === "object") &&
            k[KEYWORD_ACCESSOR_FIELD]) ||
          String(args[i]).replace(/^:/, "");
        obj[key] = args[i + 1];
      }
      return obj;
    }),
    // ------------------------------------------------------------------
    // set! delegates to the generator (evalSet via SPECIAL_FORMS); the binding
    // exists for first-class lookup + macroexpand identity, like define/let/if.
    // NOTE: evalSet is plain-symbol only — the legacy macro's dot-accessor
    // `(set! (. o k) v)` and dotted-property `(set! fn.toString v)` JS-interop
    // forms are not carried (already unreachable post-generator-delegation; no
    // test exercises them). Re-add to evalSet WITH a test if a real need appears.
    "set!": genMacroWrapper("set!"),
    // ------------------------------------------------------------------
    "unset!": doc(
      null,
      new Macro("set!", function (this: Environment, code: SchemeValue) {
        TypeError.invariant(
          code.car instanceof SchemeSymbol,
          `unset! first argument need to be a symbol or dot accessor that evaluate to object.`,
        );
        const symbol = code.car;
        const ref = this.ref(symbol);
        if (ref) {
          delete ref.__env__[symbol.__name__];
        }
      }),
    ),
    // ------------------------------------------------------------------
    "set-car!": doc("set-car!", function (slot, value) {
      typecheck("set-car!", slot, "pair");
      slot.car = value;
    }),
    // ------------------------------------------------------------------
    "set-cdr!": doc("set-cdr!", function (slot, value) {
      typecheck("set-cdr!", slot, "pair");
      slot.cdr = value;
    }),
    // ------------------------------------------------------------------
    "empty?": doc("empty?", function (x) {
      return x === undefined || is_nil(x);
    }),
    // ------------------------------------------------------------------
    gensym: doc("gensym", gensym),
    // ------------------------------------------------------------------
    load: doc("load", function load(this: Environment, file: SchemeValue, env: SchemeValue) {
      typecheck("load", file, "string");
      let g_env: Environment = this;
      if (g_env.__name__ === "__frame__") {
        g_env = g_env.__parent__!;
      }
      if (!(env instanceof Environment)) {
        if (g_env === global_env) {
          // this is used for let-env + load
          // this may be obsolete when there is env arg
          env = g_env;
        } else {
          env = this.get("**interaction-environment**");
        }
      }
      const package_name = "@here.build/arrival-scheme";
      const has_package = file.startsWith(package_name);
      // TODO: move **module-path** to internal env
      const PATH = "**module-path**";
      let module_path = global_env.get(PATH, { throwError: false });
      file = file.valueOf() as string;
      if (!/.[^.]+$/.test(file)) {
        file += ".scm";
      }
      const IS_BIN = file.match(/\.xcb$/);
      function run(code: SchemeValue) {
        invariant(!IS_BIN, "Binary serialization (.xcb) is not implemented");
        if (type(code) === "buffer") {
          code = code.toString();
        }
        code = code.replace(/^(#!.*)/, function (_, shebang) {
          if (is_directive(shebang)) {
            return shebang;
          }
          return "";
        });
        if (/^\{/.test(code)) {
          code = unserialize(code);
        }
        return exec(code, { env });
      }
      function fetchFile(file: string): Promise<string | Uint8Array> {
        return globalThis
          .fetch(file)
          .then((res): Promise<ArrayBuffer | string> => (IS_BIN ? res.arrayBuffer() : res.text()))
          .then((code): string | Uint8Array => {
            if (IS_BIN) {
              return new Uint8Array(code as ArrayBuffer);
            }
            return code as string;
          });
      }
      function get_root_dir() {
        const __dirname = global_env.get("__dirname") as string;
        return __dirname.replace(/[^/]+$/, "");
      }
      if (is_node()) {
        return new Promise(async (resolve, reject) => {
          try {
            const path = await import("node:path");
            const fs = await import("node:fs");
            const moduleURL = new URL(import.meta.url);
            // using name __direname and __filename breaks after transpilation
            global_env.set("__dirname", path.dirname(moduleURL.pathname));
            global_env.set("__filename", path.basename(moduleURL.pathname));
            const root_dir = get_root_dir();
            if (has_package) {
              file = file.replace(package_name, root_dir);
            }
            if (module_path) {
              const modulePath = module_path.valueOf() as string;
              if (!(file as string).startsWith("/")) {
                file = path.join(modulePath, file as string);
              }
            }
            global_env.set(PATH, path.dirname(file));
            fs.readFile(file, async function (err, data) {
              if (err) {
                reject(err);
                global_env.set(PATH, module_path);
              } else {
                try {
                  await run(data);
                  resolve(undefined);
                  global_env.set(PATH, module_path);
                } catch (error) {
                  reject(error);
                }
              }
            });
          } catch (error) {
            console.error(error);
          }
        });
      }
      if (has_package) {
        const current_script =
          typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement)?.src : undefined;
        let path = (global_env.get("__dirname", { throwError: false }) ?? current_script) as string;
        path ??= current_script ?? "";
        const root = path.replace(/dist\/?[^/]*$/, "");
        file = file.replace(package_name, root);
      }
      if (module_path) {
        module_path = module_path.valueOf();
        if (!file.startsWith("/")) {
          file = `${module_path}/${file.replace(/^\.?\/?/, "")}`;
        }
      }
      return fetchFile(file)
        .then((code) => {
          global_env.set(PATH, file.replace(/\/[^/]*$/, ""));
          return run(code);
        })
        .then(() => {})
        .finally(() => {
          global_env.set(PATH, module_path);
        });
    }),
    // ------------------------------------------------------------------
    while: doc(
      "while",
      genMacroWrapper("while"),
      `(while cond body...)

        Iterate the body while cond evaluates to a truthy value. Returns
        unspecified. Runs stack-safe through the generator evaluator, so a
        deeply-iterating loop never overflows the host stack.`,
    ),
    // ------------------------------------------------------------------
    do: genMacroWrapper("do"),
    // ------------------------------------------------------------------
    if: genMacroWrapper("if"),
    // ------------------------------------------------------------------
    "let-env": new Macro("let-env", function (
      this: Environment,
      code: SchemeValue,
      { dynamic_env, use_dynamic, error }: SchemeValue = {},
    ) {
      typecheck("let-env", code, "pair");
      return unpromise(
        genRun(genEvaluate(code.car, { env: this, dynamic_env, error, use_dynamic })),
        function (value: SchemeValue) {
          typecheck("let-env", value, "environment");
          return genRun(
            genEvaluate(new Pair(new SchemeSymbol("begin"), code.cdr), {
              env: value,
              dynamic_env,
              error,
            }),
          );
        },
      );
    }),
    // ------------------------------------------------------------------
    letrec: genMacroWrapper("letrec"),
    "letrec*": genMacroWrapper("letrec*"),
    "let*": genMacroWrapper("let*"),
    let: genMacroWrapper("let"),
    // ------------------------------------------------------------------
    "begin*": doc(
      null,
      parallel("begin*", function (values) {
        return values.pop();
      }),
    ),
    // ------------------------------------------------------------------
    begin: genMacroWrapper("begin"),
    // ------------------------------------------------------------------
    ignore: new Macro("ignore", function (this: Environment, code: SchemeValue, options: SchemeValue) {
      // Evaluate (begin . code) for side effects, discard the result. Routed to
      // the generator evaluator (genRun drives it to completion); the discarded
      // promise is why this is the simplest legacy-evaluate caller to migrate.
      const ctx: EvalContext = { env: this, dynamic_env: this, use_dynamic: options.use_dynamic };
      genRun(genEvaluate(new Pair(new SchemeSymbol("begin"), code), ctx));
    }),
    // ------------------------------------------------------------------
    // parameterize delegates to the generator evaluator (evalParameterize) via
    // genMacroWrapper — same dynamic-extent semantics (inherit dynamic_env →
    // look up the Parameter → bind param.inherit(value) → eval body as begin).
    parameterize: genMacroWrapper("parameterize"),
    // ------------------------------------------------------------------
    "make-parameter": doc(
      null,
      new Macro("make-parameter", function (code, eval_args) {
        // Value-returning legacy-evaluate site routed to the generator: the init
        // (and optional converter fn) are unpromised before constructing the
        // Parameter, and the macro invoker unpromises the returned value — so
        // forcing async here is transparent. (`fn` is `unknown` out of unpromise.)
        return unpromise(genRun(genEvaluate(code.car, eval_args)), (init) => {
          if (is_pair(code.cdr.car)) {
            return unpromise(
              genRun(genEvaluate(code.cdr.car, eval_args)),
              (fn) => new Parameter(init, fn as never),
            );
          }
          return new Parameter(init, undefined);
        });
      }),
    ),
    // ------------------------------------------------------------------
    "define-syntax-parameter": doc(
      null,
      new Macro("define-syntax-parameter", function (this: Environment, code: SchemeValue, eval_args: SchemeValue) {
        const name = code.car;
        const env = this;
        TypeError.invariant(
          name instanceof SchemeSymbol,
          `define-syntax-parameter: invalid syntax expecting symbol got ${type(name)}`,
        );
        return unpromise(genRun(genEvaluate(code.cdr.car, { ...eval_args, env })), (syntax: SchemeValue) => {
          typecheck("define-syntax-parameter", syntax, "syntax", 2);
          syntax.__name__ = name.valueOf();
          if (syntax.__name__ instanceof SchemeString) {
            syntax.__name__ = syntax.__name__.valueOf();
          }
          env.set(code.car, new SyntaxParameter(syntax));
        });
      }),
      `(define-syntax-parameter name syntax)

         Binds <keyword> to the transformer obtained by evaluating <transformer spec>.
         The transformer provides the default expansion for the syntax parameter,
         and in the absence of syntax-parameterize, is functionally equivalent to
         define-syntax.`,
    ),
    // ------------------------------------------------------------------
    "syntax-parameterize": doc(
      null,
      new Macro("syntax-parameterize", function (this: Environment, code: SchemeValue, eval_args: SchemeValue) {
        const args = (global_env.get("list->array") as SchemeFunction)(code.car) as Pair[];
        const env = this.inherit("syntax-parameterize");
        // Each binding's transformer evaluates in `this` (NOT the accumulating
        // env), so the bindings are independent and pure (syntax-rules build a
        // Syntax with no side effects). Drain them through the generator together,
        // then bind, then eval the body. genRun always returns a native Promise, so
        // Promise.all is always async and handles the zero-binding case correctly.
        const self = this;
        for (const pair of args) {
          invariant(
            is_pair(pair) && pair.car instanceof SchemeSymbol,
            `syntax-parameterize: invalid syntax for syntax-parameterize: ${toString(code, true)}`,
          );
        }
        return Promise.all(
          args.map((pair) => genRun(genEvaluate((pair.cdr as Pair).car, { ...eval_args, env: self }))),
        ).then((syntaxes) => {
          args.forEach((pair, i) => {
            const syntax = syntaxes[i] as SchemeValue;
            const name = pair.car as SchemeValue;
            typecheck("syntax-parameterize", syntax, ["syntax"]);
            typecheck("syntax-parameterize", name, "symbol");
            syntax.__name__ = name.valueOf();
            if (syntax.__name__ instanceof SchemeString) {
              syntax.__name__ = syntax.__name__.valueOf();
            }
            const parameter = new SyntaxParameter(syntax);
            // used inside syntax-rules
            if ((name as SchemeSymbol).is_gensym()) {
              const symbol = (name as SchemeSymbol).literal();
              const parent = self.get(symbol, { throwError: false });
              if (parent instanceof SyntaxParameter) {
                // create anaphoric binding for literal symbol
                env.set(symbol, parameter);
              }
            }
            env.set(name, parameter);
          });
          const expr = hygienic_begin([env, eval_args.dynamic_env], code.cdr);
          return genRun(genEvaluate(expr, { ...eval_args, env }));
        });
      }),
    ),
    // ------------------------------------------------------------------
    // define delegates to the generator evaluator (evalDefine) via
    // genMacroWrapper. Verified empirically equivalent to the old defmacro on
    // every reachable case (fn-shorthand + recursion, symbol alias, define in
    // let/begin, macroexpand round-trip; full suite green). Three legacy-only
    // behaviors are NOT ported because they are unreachable through the
    // current macro engine, so no test can exercise them: (1) the
    // Syntax.__merge_env__ parent-env redirect — only fires when a syntax-rules
    // template introduces a define, but expansion dies upstream at pattern
    // matching first; (2) the macroexpand guard — macroexpand already returns
    // the form inert without executing it; (3) __name__ stamping on
    // Syntax/Parameter values (not just lambdas) — cosmetic introspection.
    // If the macro engine later gains macro-introduced-define support, add the
    // hygiene redirect to evalDefine WITH a test that actually reaches it.
    define: genMacroWrapper("define"),
    // ------------------------------------------------------------------
    "set-obj!": doc("set-obj!", function (obj, key, value, options = null) {
      const obj_type = typeof obj;
      invariant(!is_null(obj), () => typeErrorMessage("set-obj!", type(obj), ["object", "function"]));
      invariant(obj_type === "object" || obj_type === "function", () =>
        typeErrorMessage("set-obj!", type(obj), ["object", "function"]),
      );
      typecheck("set-obj!", key, ["string", "symbol", "number"]);
      obj = unbind(obj);
      key = key.valueOf();
      if (arguments.length === 2) {
        delete obj[key];
      } else if (is_prototype(obj) && is_function(value)) {
        obj[key] = unbind(value);
        obj[key][__prototype__] = true;
      } else if (is_function(value) || is_native(value) || is_nil(value)) {
        obj[key] = value;
      } else {
        obj[key] = value && !is_prototype(value) ? value.valueOf() : value;
      }
      if (options) {
        const value = obj[key];
        Object.defineProperty(obj, key, { ...(options as PropertyDescriptor), value });
      }
    }),
    // ------------------------------------------------------------------
    "null-environment": doc("null-environment", function () {
      return global_env.inherit("null");
    }),
    // ------------------------------------------------------------------
    values: doc("values", function values(...args) {
      return Values.from(args);
    }),
    // ------------------------------------------------------------------
    "call-with-values": doc(
      "call-with-values",
      function (this: Environment, producer: SchemeFunction, consumer: SchemeFunction) {
        typecheck("call-with-values", producer, "function", 1);
        typecheck("call-with-values", consumer, "function", 2);
        const maybe = producer.apply(this);
        if (maybe instanceof Values) {
          return consumer.apply(this, maybe.valueOf());
        }
        return consumer.call(this, maybe);
      },
    ),
    // ------------------------------------------------------------------
    "current-environment": doc("current-environment", function (this: Environment) {
      if (this.__name__ === "__frame__") {
        return this.__parent__;
      }
      return this;
    }),
    // ------------------------------------------------------------------
    "parent.frame": doc("parent.frame", function () {
      return user_env;
    }),
    // ------------------------------------------------------------------
    "parent.frames": doc("parent.frames", function () {
      return new Pair(user_env, nil);
    }),
    // ------------------------------------------------------------------
    // lambda delegates to the generator (evalLambda via SPECIAL_FORMS); the
    // binding exists for first-class lookup + the macro engine's identity check
    // (`value === env.get("lambda")` in syntax-rules.ts), like define/let/if.
    lambda: genMacroWrapper("lambda"),
    // ------------------------------------------------------------------
    macroexpand: doc(null, new Macro("macroexpand", macro_expand())),
    // ------------------------------------------------------------------
    // define-macro delegates to the generator evaluator (evalDefineMacro) via
    // genMacroWrapper — binds positional + rest params to the unevaluated form
    // and registers the expander Macro in the calling env. Drops the literal's
    // last dependency on the legacy macro-engine path.
    "define-macro": genMacroWrapper("define-macro"),
    // ------------------------------------------------------------------
    "syntax-rules": new Macro("syntax-rules", function (this: Environment, macro: SchemeValue, options: SchemeValue) {
      const { use_dynamic, error } = options;
      // TODO: find identifiers and freeze the scope when defined #172
      const env = this;

      function get_identifiers(node: SchemeValue) {
        const symbols: SchemeValue[] = [];
        while (!is_nil(node)) {
          const x = node.car;
          symbols.push(x.valueOf());
          node = node.cdr;
        }
        return symbols;
      }

      function validate_identifiers(node) {
        while (!is_nil(node)) {
          const x = node.car;
          TypeError.invariant(x instanceof SchemeSymbol, "syntax-rules: wrong identifier");
          node = node.cdr;
        }
      }

      if (macro.car instanceof SchemeSymbol) {
        validate_identifiers(macro.cdr.car);
      } else {
        validate_identifiers(macro.car);
      }
      const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand }: SchemeValue) {
        log(">> SYNTAX");
        log(code);
        log(macro);
        const scope = env.inherit("syntax");
        const dynamic_env = scope;
        let var_scope: Environment = this;
        // for macros that define variables used in macro (2 levels nestting)
        if ((var_scope.__name__ as string | symbol) === Syntax.__merge_env__) {
          // copy refs for defined gynsyms
          const props = Object.getOwnPropertySymbols(var_scope.__env__);
          for (const symbol of props) {
            var_scope.__parent__!.set(symbol, var_scope.__env__[symbol]);
          }
          var_scope = var_scope.__parent__!;
        }
        const eval_args = { env: scope, dynamic_env, use_dynamic, error };
        let ellipsis, rules, symbols;
        if (macro.car instanceof SchemeSymbol) {
          ellipsis = macro.car;
          symbols = get_identifiers(macro.cdr.car);
          rules = macro.cdr.cdr;
        } else {
          ellipsis = "...";
          symbols = get_identifiers(macro.car);
          rules = macro.cdr;
        }
        try {
          while (!is_nil(rules)) {
            const rule = rules.car.car;
            let expr = rules.car.cdr.car;
            log("[[[ RULE");
            log(rule);
            const bindings = extract_patterns(rule, code, symbols, ellipsis, {
              expansion: this,
              define: env,
              globalEnv: global_env,
            });
            if (bindings) {
              /* c8 ignore next 5 */
              if (is_debug()) {
                console.log(JSON.stringify(symbolize(bindings), null, 2));
                console.log(`PATTERN: ${rule.toString(true)}`);
                console.log(`MACRO: ${code.toString(true)}`);
              }
              // name is modified in transform_syntax
              const names = [];
              const new_expr = transform_syntax({
                bindings,
                expr,
                symbols,
                scope,
                lex_scope: var_scope,
                names,
                ellipsis,
              });
              log("OUPUT>>> ", new_expr);
              // TODO: if expression is undefined throw an error
              if (new_expr) {
                expr = new_expr;
              }
              const new_env = var_scope.merge(scope, Syntax.__merge_env__ as unknown as string);
              if (macro_expand) {
                return { expr, scope: new_env };
              }
              // Drain: evaluate the expanded template through the generator. This
              // is the last reachable legacy-evaluate caller. The Syntax transformer's
              // return value IS the final result (the generator awaits this promise
              // before returning the syntax expansion), so going async is transparent.
              // clear_gensyms runs on the resolved result (gensym→literal-symbol fixup).
              return unpromise(genRun(genEvaluate(expr, { ...eval_args, env: new_env })), (result: SchemeValue) =>
                // Hack: update the result if there are generated
                //       gensyms that should be literal symbols
                clear_gensyms(result, names),
              );
            }
            rules = rules.cdr;
          }
        } catch (error_) {
          (error_ as Error).message += `\nin macro:\n  ${macro.toString(true)}`;
          throw error_;
        }
        throw new Error(`syntax-rules: no matching syntax in macro ${code.toString(true)}`);
      }, env);
      (syntax as SchemeValue).__code__ = macro;
      return syntax;
    }),
    // ------------------------------------------------------------------
    quote: doc(
      null,
      new Macro("quote", function (arg) {
        return quote(arg.car);
      }),
    ),
    "unquote-splicing": doc("unquote-splicing", function () {
      throw new Error(`You can't call \`unquote-splicing\` outside of quasiquote`);
    }),
    unquote: doc("unquote", function () {
      throw new Error(`You can't call \`unquote\` outside of quasiquote`);
    }),
    // ------------------------------------------------------------------
    // quasiquote delegates to the generator evaluator (evalQuasiquote) via
    // genMacroWrapper — full R7RS expansion: unquote, unquote-splicing,
    // nesting levels, dotted tails, and vector quasiquotation.
    quasiquote: genMacroWrapper("quasiquote"),
    // ------------------------------------------------------------------
    clone: doc("clone", function clone(list) {
      typecheck("clone", list, "pair");
      return list.clone();
    }),
    // ------------------------------------------------------------------
    append: doc("append", function append(this: Environment, ...items: SchemeValue[]) {
      items = items.map((item) => {
        if (is_pair(item)) {
          return item.clone();
        }
        return item;
      });
      return (global_env.get("append!") as SchemeFunction).call(this, ...items);
    }),
    // ------------------------------------------------------------------
    "append!": doc("append!", function (...items) {
      const is_list = global_env.get("list?") as SchemeFunction;
      return items.reduce((acc, item, idx) => {
        typecheck("append!", acc, ["nil", "pair"]);
        // R7RS: last argument can be any value (creates improper list)
        const isLast = idx === items.length - 1;
        if (!isLast && (is_pair(item) || is_nil(item)) && !is_list(item)) {
          throw new Error("append!: Invalid argument, value is not a list");
        }
        if (is_nil(acc)) {
          if (is_nil(item)) {
            return nil;
          }
          return item;
        }
        if (is_null(item)) {
          return acc;
        }
        return acc.append(item);
      }, nil);
    }),
    // ------------------------------------------------------------------
    reverse: doc("reverse", function reverse(arg) {
      typecheck("reverse", arg, ["array", "pair", "nil"]);
      if (is_nil(arg)) {
        return nil;
      }
      if (is_pair(arg)) {
        const arr = (global_env.get("list->array") as SchemeFunction)(arg).toReversed();
        return (global_env.get("array->list") as SchemeFunction)(arr);
      } else if (Array.isArray(arg)) {
        return arg.toReversed();
      } else {
        throw new TypeError(typeErrorMessage("reverse", type(arg), "array or pair"));
      }
    }),
    // ------------------------------------------------------------------
    nth: doc("nth", function nth(index, obj) {
      typecheck("nth", index, "number");
      typecheck("nth", obj, ["array", "pair"]);
      if (is_pair(obj)) {
        let node = obj;
        let count = 0;
        while (count < index) {
          if (!node.cdr || is_nil(node.cdr) || node.have_cycles("cdr")) {
            return nil;
          }
          node = node.cdr as Pair;
          count++;
        }
        return node.car;
      } else if (Array.isArray(obj)) {
        return obj[index];
      } else {
        throw new TypeError(typeErrorMessage("nth", type(obj), "array or pair", 2));
      }
    }),
    // ------------------------------------------------------------------
    list: doc("list", function list(...args) {
      const result = args.reduceRight((list, item) => new Pair(item, list), nil);
      return withInputProvenance(args, result);
    }),
    // ------------------------------------------------------------------
    substring: doc("substring", function substring(string, start, end) {
      typecheck("substring", string, "string");
      typecheck("substring", start, "number");
      typecheck("substring", end, ["number", "void"]);
      return string.substring(start.valueOf(), end?.valueOf());
    }),
    // ------------------------------------------------------------------
    concat: doc("concat", function concat(...args) {
      for (const [i, arg] of args.entries()) typecheck("concat", arg, "string", i + 1);
      return args.join("");
    }),
    // ------------------------------------------------------------------
    join: doc("join", function join(separator, list) {
      typecheck("join", separator, "string");
      typecheck("join", list, ["pair", "nil"]);
      return (global_env.get("list->array") as SchemeFunction)(list).join(separator);
    }),
    // ------------------------------------------------------------------
    split: doc("split", function split(separator, string) {
      typecheck("split", separator, ["regex", "string"]);
      typecheck("split", string, "string");
      return (global_env.get("array->list") as SchemeFunction)(string.split(separator));
    }),
    // ------------------------------------------------------------------
    replace: doc("replace", function replace(pattern, replacement, string) {
      typecheck("replace", pattern, ["regex", "string"]);
      typecheck("replace", replacement, ["string", "function"]);
      typecheck("replace", string, "string");
      if (is_function(replacement)) {
        // ref: https://stackoverflow.com/a/48032528/387194
        const replacements: SchemeValue[] = [];
        string.replace(pattern, function (...args: SchemeValue[]) {
          replacements.push(replacement(...args));
        });
        return unpromise(replacements, (replacements) => {
          return string.replace(pattern, () => (replacements as SchemeValue[]).shift());
        });
      }
      return string.replace(pattern, replacement);
    }),
    // ------------------------------------------------------------------
    match: doc("match", function match(pattern, string) {
      typecheck("match", pattern, ["regex", "string"]);
      typecheck("match", string, "string");
      const m = string.match(pattern);
      return m ? (global_env.get("array->list") as SchemeFunction)(m) : false;
    }),
    // ------------------------------------------------------------------
    search: doc("search", function search(pattern, string) {
      typecheck("search", pattern, ["regex", "string"]);
      typecheck("search", string, "string");
      return string.search(pattern);
    }),
    // ------------------------------------------------------------------
    repr: doc("repr", function repr(obj, quote) {
      return toString(obj, quote);
    }),
    // ------------------------------------------------------------------
    "escape-regex": doc("escape-regex", function (string) {
      typecheck("escape-regex", string, "string");
      return escape_regex(string.valueOf());
    }),
    // ------------------------------------------------------------------
    env: doc("env", function env(this: Environment, env: SchemeValue) {
      env = env || this;
      const names = Object.keys(env.__env__).map((name) => new SchemeSymbol(name));
      let result;
      result = names.length > 0 ? Pair.fromArray(names) : nil;
      if (env.__parent__ instanceof Environment) {
        return (global_env.get("env") as SchemeFunction).call(this, env.__parent__).append(result);
      }
      return result;
    }),
    // ------------------------------------------------------------------
    new: doc("new", function (obj, ...args) {
      // Unwrap membrane-wrapped functions to get the actual constructor
      let constructor = obj;
      if (constructor instanceof SchemeJSFunction) {
        constructor = constructor.source;
      }
      constructor = unbind(constructor);
      const instance = new constructor(...args.map((x) => unbox(x)));
      return instance;
    }),
    // ------------------------------------------------------------------
    typecheck: doc(null, typecheck),
    // ------------------------------------------------------------------
    "set-special!": doc("set-special!", function (seq, name, type = specials.LITERAL) {
      typecheck("set-special!", seq, "string", 1);
      typecheck("set-special!", name, "symbol", 2);
      specials.append(seq.valueOf(), name, type);
    }),
    // ------------------------------------------------------------------
    get,
    ".": get,
    // ------------------------------------------------------------------
    instanceof: doc("instanceof", function (type, obj) {
      return obj instanceof unbind(type);
    }),
    // ------------------------------------------------------------------
    "function?": doc("function?", is_function),
    // ------------------------------------------------------------------
    "real?": doc("real?", function (value) {
      if (value instanceof SchemeExact || value instanceof SchemeInexact) {
        return value.isReal;
      }
      if (type(value) !== "number") {
        return false;
      }
      return typeof value === "number" && !Number.isNaN(value);
    }),
    // ------------------------------------------------------------------
    "number?": doc("number?", function (x) {
      return (
        Number.isNaN(x) ||
        x instanceof SchemeExact ||
        x instanceof SchemeInexact ||
        typeof x === "number" ||
        typeof x === "bigint"
      );
    }),
    // ------------------------------------------------------------------
    "string?": doc("string?", function (obj) {
      return SchemeString.isString(obj);
    }),
    // ------------------------------------------------------------------
    "pair?": doc("pair?", is_pair),
    // ------------------------------------------------------------------
    "regex?": doc("regex?", function (obj) {
      return obj instanceof RegExp;
    }),
    // ------------------------------------------------------------------
    "null?": doc("null?", function (obj) {
      return is_null(obj);
    }),
    // ------------------------------------------------------------------
    "boolean?": doc("boolean?", function (obj) {
      // L1 boxes parser literals as SchemeBool — JS `typeof` no longer catches them.
      // Mirrors the `number?` / `string?` pattern of accepting both raw and boxed forms.
      return typeof obj === "boolean" || obj instanceof SchemeBool;
    }),
    // ------------------------------------------------------------------
    "symbol?": doc("symbol?", function (obj) {
      return obj instanceof SchemeSymbol;
    }),
    // ------------------------------------------------------------------
    "array?": doc("array?", function (obj) {
      return Array.isArray(obj);
    }),
    // ------------------------------------------------------------------
    "object?": doc("object?", function (obj) {
      return (
        !is_nil(obj) &&
        obj !== null &&
        !(obj instanceof SchemeCharacter) &&
        !(obj instanceof RegExp) &&
        !(obj instanceof SchemeString) &&
        !is_pair(obj) &&
        !(obj instanceof SchemeExact) &&
        !(obj instanceof SchemeInexact) &&
        typeof obj === "object" &&
        !Array.isArray(obj)
      );
    }),
    // ------------------------------------------------------------------
    flatten: doc("flatten", function flatten(list) {
      typecheck("flatten", list, "pair");
      return list.flatten();
    }),
    // ------------------------------------------------------------------
    // `vector` and `vector-append` live in bridge.ts (wrappedOps), minting boxed
    // SchemeVector. The former stdlib `vector` here was DEAD (initBridge applies
    // wrappedOps over global_env after stdlib builds, so bridge's always won) AND
    // wrong (it typecheck'd args as numbers — non-R7RS). Removed (boxing S7, R11).
    // ------------------------------------------------------------------
    "array->list": doc("array->list", function (array) {
      typecheck("array->list", array, "array");
      return Pair.fromArray(array);
    }),
    // ------------------------------------------------------------------
    "tree->array": doc("tree->array", to_array("tree->array", true)),
    // ------------------------------------------------------------------
    "list->array": doc("list->array", to_array("list->array")),
    // ------------------------------------------------------------------
    apply: doc("apply", function apply(this: Environment, fn: SchemeFunction, ...args: SchemeValue[]) {
      typecheck("apply", fn, "function", 1);
      const last = args.pop();
      typecheck("apply", last, ["pair", "nil"], args.length + 2);
      args = args.concat((global_env.get("list->array") as SchemeFunction).call(this, last));
      return fn.apply(this, prepare_fn_args(fn, args));
    }),
    // ------------------------------------------------------------------
    length: speculative(doc("length", function length(obj) {
      if (!obj || is_nil(obj)) {
        return 0;
      }
      // Tier 2 speculation: length of a still-filling collection is its narrowing
      // cardinality INTERVAL, surfaced as a number-domain HalfBaked that the
      // comparison ops read for early collapse. Reached only when speculation is
      // on (the choke leaves a HalfBaked unforced solely for this marked op).
      if (is_half_baked(obj)) {
        return obj.toCardinalityNumber();
      }
      if (is_pair(obj)) {
        if (isCircularList(obj)) TypeError.invariant(false, "length: circular list");
        return withInputProvenance([obj], obj.length());
      }
      if ("length" in obj) {
        return withInputProvenance([obj], obj.length);
      }
    })),
    // ------------------------------------------------------------------
    "string->number": doc("string->number", function (arg, radix = 10) {
      typecheck("string->number", arg, "string", 1);
      typecheck("string->number", radix, "number", 2);
      arg = arg.valueOf();
      radix = radix.valueOf();
      try {
        if (arg.match(rational_bare_re) || arg.match(rational_re)) {
          return parse_rational(arg, radix);
        } else if (arg.match(complex_bare_re) || arg.match(complex_re)) {
          // R7RS: pure imaginary must have explicit sign (+3i or -3i, not 3i)
          // Reject patterns like "3i", "33i", "3.3i" without leading sign
          if (/^#?[iexobd]*[0-9.]+i$/i.test(arg)) {
            return false;
          }
          return parse_complex(arg, radix);
        } else {
          const valid_bare = (radix === 10 && !/e/i.test(arg)) || radix === 16;
          if ((arg.match(int_bare_re) && valid_bare) || arg.match(int_re)) {
            return parse_integer(arg, radix);
          }
          if (float_re.test(arg)) {
            return parse_float(arg);
          }
        }
      } catch {
        // Invalid number format - return #f per R7RS
        return false;
      }
      return false;
    }),
    throw: doc("throw", function (message) {
      throw new Error(message);
    }),
    // ------------------------------------------------------------------
    try: genMacroWrapper("try"),
    // ------------------------------------------------------------------
    find: doc("find", function find(arg, list) {
      typecheck("find", arg, ["regex", "function"]);
      typecheck("find", list, ["pair", "nil"]);
      if (is_null(list)) {
        return nil;
      }
      const fn = matcher("find", arg);
      return unpromise(fn(list.car), function (value) {
        if (value && !is_nil(value)) {
          return list.car;
        }
        return find(arg, list.cdr);
      });
    }),
    // ------------------------------------------------------------------
    "for-each": doc("for-each", function (this: Environment, fn: SchemeFunction, ...lists: SchemeValue[]) {
      typecheck("for-each", fn, "function");
      for (const [i, arg] of lists.entries()) {
        typecheck("for-each", arg, ["pair", "nil"], i + 1);
      }
      // we need to use call(this because babel transpile this code into:
      // var ret = map.apply(void 0, [fn].concat(lists));
      // it don't work with weakBind
      const ret = (global_env.get("map") as SchemeFunction).call(this, fn, ...lists);
      if (is_promise(ret)) {
        return ret.then(() => {});
      }
    }),
    // ------------------------------------------------------------------
    map: doc("map", function map(this: SchemeValue, fn: SchemeFunction, ...lists: SchemeValue[]) {
      typecheck("map", fn, "function");
      const is_list = global_env.get("list?") as SchemeFunction;
      for (const [i, arg] of lists.entries()) {
        typecheck("map", arg, ["pair", "nil"], i + 1);
        // detect cycles
        invariant(!is_pair(arg) || is_list.call(this, arg), `map: argument ${i + 1} is not a list`);
      }
      if (lists.length === 0 || lists.some(is_nil)) {
        return nil;
      }

      // Convert lists to arrays for parallel processing
      const arrays = lists.map((l) => (global_env.get("list->array") as SchemeFunction)(l));
      const length = Math.min(...arrays.map((a: SchemeValue[]) => a.length));

      // Call function for all elements in parallel
      const { env, dynamic_env, use_dynamic } = this;
      const results: SchemeValue[] = [];
      for (let i = 0; i < length; i++) {
        const args = arrays.map((arr: SchemeValue[]) => arr[i]);
        results.push(call_function(fn, args, { env, dynamic_env, use_dynamic }));
      }

      // Wait for all and convert back to list
      const hasPromises = results.some(is_promise);

      // Tier-2 speculation: map's count is known exactly up front (one output
      // per input → bounds [1,1]), so its `HalfBaked` interval is already a
      // point — `length` is decidable immediately while values still resolve.
      // This carries speculation THROUGH a map sitting between filter and the
      // length/comparison (the values stay lazy; only the count is surfaced).
      if (hasPromises && isSpeculating()) {
        const slots = results.map((r) => Promise.resolve(r).then((v) => [v as SchemeValue]));
        return HalfBaked.collection(slots, () => [1, 1]);
      }
      if (hasPromises) {
        return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
          Pair.fromArray(resolved as SchemeValue[]),
        );
      }
      return Pair.fromArray(results);
    }),
    // ------------------------------------------------------------------
    "list?": doc("list?", function (obj) {
      // A circular list is NOT a proper list (R7RS). Detect runtime cycles
      // (have_cycles below only catches reader #0= cycles).
      if (is_pair(obj) && isCircularList(obj)) {
        return false;
      }
      let node = obj;
      while (true) {
        if (is_nil(node)) {
          return true;
        }
        if (!is_pair(node)) {
          return false;
        }
        if (node.have_cycles("cdr")) {
          return false;
        }
        node = node.cdr;
      }
    }),
    // ------------------------------------------------------------------
    fold: doc(
      "fold",
      fold("fold", function (this: unknown, fold, fn, init, ...lists) {
        typecheck("fold", fn, "function");
        for (const [i, arg] of lists.entries()) {
          typecheck("fold", arg, ["pair", "nil"], i + 1);
        }
        if (lists.some(is_nil)) {
          return init;
        }
        const value = fold.call(this, fn, init, ...lists.map((l: SchemeValue) => l.cdr));
        return unpromise(value, (value) => {
          return fn(...lists.map((l: SchemeValue) => l.car), value);
        });
      }),
    ),
    // ------------------------------------------------------------------
    pluck: doc("pluck", function pluck(...keys) {
      return function (obj) {
        keys = keys.map((x) => (x instanceof SchemeSymbol ? x.__name__ : x));
        if (keys.length === 0) {
          return nil;
        } else if (keys.length === 1) {
          const [key] = keys;
          return obj[key];
        }
        const result = {};
        for (const key of keys) {
          result[key] = obj[key];
        }
        return result;
      };
    }),
    // ------------------------------------------------------------------
    reduce: doc(
      "reduce",
      fold("reduce", function (this: unknown, reduce, fn, init, ...lists) {
        typecheck("reduce", fn, "function");
        for (const [i, arg] of lists.entries()) {
          typecheck("reduce", arg, ["pair", "nil"], i + 1);
        }
        if (lists.some(is_nil)) {
          return init;
        }
        return unpromise(fn(...lists.map((l: SchemeValue) => l.car), init), (value) => {
          return reduce.call(this, fn, value, ...lists.map((l: SchemeValue) => l.cdr));
        });
      }),
    ),
    // ------------------------------------------------------------------
    filter: doc("filter", function filter(arg, list) {
      typecheck("filter", arg, ["regex", "function"]);
      typecheck("filter", list, ["pair", "nil"]);
      const array = (global_env.get("list->array") as SchemeFunction)(list);
      if (array.length === 0) {
        return nil;
      }
      const fn = matcher("filter", arg);

      // Call predicate on all elements in parallel
      const predicateResults = array.map((item) => fn(item));
      const hasPromises = predicateResults.some(is_promise);

      // `is_false` rather than raw `!r`: post-Option-C, predicates can return
      // SchemeBool wrappers (e.g. `:active` on a SchemeJSObject yields a
      // boxed boolean carrying container provenance). Raw `&&` treats any
      // object as truthy and would retain false-valued entries.

      // Tier-2 speculation: when the predicate fan is still filling AND the
      // caller opted in, return a lazy `HalfBaked` collection instead of
      // awaiting `promise_all`. Each slot resolves to the items it contributes
      // ([] dropped, [item] kept), so the cardinality interval narrows from both
      // ends as slots settle — letting `(>= (length …) k)` collapse the instant
      // lo reaches k, with the rest of the fan still pending. Bounds [0,1] per
      // slot (a predicate keeps at most one). Forced back to a Pair (identical
      // to the eager result) at any non-speculating boundary. EMPTY_PROVENANCE:
      // filter doesn't union container provenance on the eager path either.
      if (hasPromises && isSpeculating()) {
        const slots = predicateResults.map((r, i) => {
          const keep = (verdict: unknown): SchemeValue[] =>
            !is_false(verdict) && !is_nil(verdict) ? [array[i]] : [];
          return is_promise(r) ? (r as Promise<unknown>).then(keep) : Promise.resolve(keep(r));
        });
        return HalfBaked.collection(slots, () => [0, 1]);
      }
      if (hasPromises) {
        return (promise_all(predicateResults) as Promise<unknown[]>).then((results) => {
          const filtered = array.filter((_, i) => !is_false(results[i]) && !is_nil(results[i]));
          return Pair.fromArray(filtered);
        });
      }
      const filtered = array.filter((_, i) => !is_false(predicateResults[i]) && !is_nil(predicateResults[i]));
      return Pair.fromArray(filtered);
    }),
    // ------------------------------------------------------------------
    compose: doc(null, compose),
    pipe: doc(null, pipe),
    curry: doc(null, curry),
    // ------------------------------------------------------------------
    "eq?": doc("eq?", eq),
    "eqv?": doc("eqv?", eqv),
    // ------------------------------------------------------------------
    // R5RS § 6.2.5 arrow-form aliases for R7RS § 6.2 exact/inexact.
    //
    // Why call-time lookup rather than direct binding:
    // The target functions (`exact`, `inexact`) live in `bridge.ts` and are
    // applied to `global_env` AFTER this object literal evaluates — see
    // `applyToEnvironment` in initBridge(). Closing over the values now
    // would capture `undefined`; the lookup MUST happen on call. Wrapping as
    // a thin trampoline lets the same Scheme code that uses `exact->inexact`
    // (chibi/gambit/racket conventions) work without bridge.ts changes.
    //
    // The R7RS-renamed `exact`/`inexact` are still the canonical names; these
    // arrow forms are R5RS-compat aliases (kept by every Scheme that takes
    // legacy code seriously). Cost is one extra lookup per call, paid only
    // when downstream code uses the legacy spelling.
    "exact->inexact": doc(
      "exact->inexact",
      function exactToInexact(z: SchemeValue): SchemeValue {
        return (global_env.get("inexact") as SchemeFunction)(z);
      },
    ),
    "inexact->exact": doc(
      "inexact->exact",
      function inexactToExact(z: SchemeValue): SchemeValue {
        return (global_env.get("exact") as SchemeFunction)(z);
      },
    ),
    // ------------------------------------------------------------------
    or: genMacroWrapper("or"),
    // ------------------------------------------------------------------
    and: genMacroWrapper("and"),
    // ------------------------------------------------------------------
    not: doc("not", function not(value) {
      // R7RS: only #f is falsy. Post-L1 `#f` parses to `SchemeBool(false)`
      // (a truthy object in JS), so `!value` would wrongly return false here.
      // `is_false` is the canonical scheme-falsy predicate (`guards.ts`).
      return is_false(value);
    }),
  },
  undefined,
);
const user_env = global_env.inherit("user-env");
export { user_env as env };

// -------------------------------------------------------------------------
function set_interaction_env(interaction, internal) {
  interaction.constant("**internal-env**", internal);
  interaction.doc(
    "**internal-env**",
    `**internal-env**

         Constant used to hide stdin, stdout and stderr so they don't interfere
         with variables with the same name. Constants are an internal type
         of variable that can't be redefined, defining a variable with the same name
         will throw an error.`,
  );
  global_env.set("**interaction-environment**", interaction);
}

// -------------------------------------------------------------------------
set_interaction_env(user_env, internal_env);
global_env.doc(
  "**interaction-environment**",
  `**interaction-environment**

    Internal dynamic, global variable used to find interpreter environment.
    It's used so the read and write functions can locate **internal-env**
    that contains the references to stdin, stdout and stderr.`,
);

// NOTE: Numeric operations from bridge.ts should be applied by calling initBridge()
// This cannot be done at module load time due to circular dependency
// See: src/bridge.ts initBridge()

// -------------------------------------------------------------------------
// ref: https://stackoverflow.com/a/4331218/387194
function allPossibleCases(arr: SchemeValue[]): SchemeValue[] {
  if (arr.length === 1) {
    return arr[0];
  } else {
    const result: SchemeValue[] = [];
    // recur with the rest of array
    const allCasesOfRest = allPossibleCases(arr.slice(1));
    for (const element of allCasesOfRest) {
      for (let j = 0; j < arr[0].length; j++) {
        result.push(arr[0][j] + element);
      }
    }
    return result;
  }
}

// -------------------------------------------------------------------------
function combinations(input: SchemeValue, start: number, end: number): SchemeValue[] {
  let result: SchemeValue[] = [];
  for (let i = start; i <= end; ++i) {
    const input_arr: SchemeValue[] = [];
    for (let j = 0; j < i; ++j) {
      input_arr.push(input);
    }
    result = result.concat(allPossibleCases(input_arr));
  }
  return result;
}

// -------------------------------------------------------------------------
// cadr caddr cadadr etc.
for (const spec of combinations(["d", "a"], 2, 5)) {
  const s = spec.split("");
  const chars = [...s].reverse();
  const name = `c${spec}r`;
  global_env.set(
    name,
    doc(name, function (arg) {
      return chars.reduce(function (list, type) {
        typecheck(name, list, "pair");
        return type === "a" ? list.car : list.cdr;
      }, arg);
    }),
  );
}

// -------------------------------------------------------------------------
// prepare_fn_args is the one survivor of the deleted legacy `evaluate` cluster —
// it's still used by the stdlib `apply` builtin to unbox callback args (#76).
function prepare_fn_args(fn: SchemeValue, args: SchemeValue[]): SchemeValue[] {
  if (is_bound(fn) && !is_object_bound(fn) && !lips_context(fn)) {
    args = args.map(unbox);
  }
  if (!is_raw_lambda(fn) && args.some(is_lips_function) && !is_lips_function(fn) && !is_array_method(fn)) {
    // we unbox values from callback functions #76
    // calling map on array should not unbox the value
    const result: SchemeValue[] = [];
    let i = args.length;
    while (i--) {
      const arg = args[i];
      if (is_lips_function(arg)) {
        const wrapper = function (this: SchemeValue, ...args: SchemeValue[]) {
          return unpromise(arg.apply(this, args), unbox);
        };
        // make wrapper work like output of bind
        hidden_prop(wrapper, "__bound__", true);
        hidden_prop(wrapper, "__fn__", arg);
        // copy prototype from function to wrapper
        // so this work when calling new from JavaScript
        // case of Preact that pass LIPS class as argument
        // to h function
        wrapper.prototype = arg.prototype;
        result[i] = wrapper;
      } else {
        result[i] = arg;
      }
    }
    args = result;
  }
  return args;
}

// -------------------------------------------------------------------------
// The legacy `evaluate` (+ its evaluate_args/evaluate_syntax/evaluate_macro/
// apply/search_param helpers) is DELETED — every evaluation now runs on the
// generator (evaluator.ts). The audit #42 wrapOperator contract it used to
// carry is preserved in exec_with_stacktrace below (it surfaces wrapOperator's
// TypeError + membrane cause out of the generator's SchemeError wrapping).
async function exec_with_stacktrace(code: SchemeValue, { env, dynamic_env, use_dynamic }: SchemeValue = {}) {
  // The legacy `evaluate` driver is gone — this runs on the generator. The
  // generator's run() already attaches a Scheme stack trace (SchemeError.schemeStack)
  // and threads onReject through the tap, so the old __code__-pushing /
  // "Error:"-prefix-cleaning error callback is obsolete.
  try {
    return await genRun(genEvaluate(code, { env, dynamic_env, use_dynamic }));
  } catch (e) {
    // Preserve the audit #42 wrapOperator contract. run() wraps every
    // non-SchemeError — including the TypeError that wrapOperator throws to name
    // operator + arg types — in a SchemeError, which masks BOTH the TypeError
    // class and the membrane "Cannot convert to SchemeNumeric" cause (it sinks to
    // SchemeError.cause.cause). Surface the original TypeError (it carries its own
    // membrane cause), so the user-visible shape bridge.ts:wrapOperator
    // established survives. Plain SchemeErrors pass through with their frames.
    if (e instanceof SchemeError && e.cause instanceof TypeError) {
      throw e.cause;
    }
    throw e;
  }
}

// -------------------------------------------------------------------------
export const exec = async (
  arg,
  {
    env,
    dynamic_env,
    use_dynamic,
  }: {
    env?: Environment | boolean;
    dynamic_env?: Environment;
    use_dynamic?: boolean;
  } = {},
): Promise<SchemeValue[]> => {
  if (!is_env(dynamic_env)) {
    dynamic_env = ((env === true ? user_env : env) ?? user_env) as Environment;
  }
  const resolvedEnv = ((env === true ? user_env : env) ?? user_env) as Environment;
  if (is_pair(arg)) {
    return [await exec_with_stacktrace(arg, { env: resolvedEnv, dynamic_env, use_dynamic })];
  }
  const input = Array.isArray(arg) ? arg : _parse(arg);
  const results: SchemeValue[] = [];
  for await (const code of input) {
    const value = await exec_with_stacktrace(code, {
      env: resolvedEnv,
      dynamic_env,
      use_dynamic,
    });
    results.push(await value);
  }
  return results;
};

for (const [i, cls] of Object.entries(available_class)) {
  class_map[cls] = +i;
}
// -------------------------------------------------------------------------

// unwrap async generator into Promise<Array>
export const parse = async (arg: SchemeValue, env?: Environment, source?: string) => {
  const result: SchemeValue[] = [];
  for await (const item of _parse(arg, env, source)) {
    result.push(item);
  }
  return result;
};

export const lips = {
  env: global_env,
  exec,
  parse,
  tokenize,
  Environment,
  user_env,
  Pair,
  QuotedPromise,
  Formatter,
  repr,
  SchemeSymbol,
  SchemeString,
};
global_env.set("lips", lips);

// Additional exports needed by Environment.ts
export { eof as eof };
setLipsRuntime({
  doc,
  get_props,
  patch_value,
  get,
  unbind,
  parse,
  global_env,
});
