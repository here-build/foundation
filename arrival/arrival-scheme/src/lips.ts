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
import { IgnoreException } from "./IgnoreException.js";
import { Lexer } from "./Lexer.js";
import { Parameter } from "./Parameter.js";
import { Parser } from "./Parser.js";
import { QuotedPromise } from "./QuotedPromise.js";
import { Formatter } from "./Formatter.js";
import {
  is_callable,
  is_context,
  is_continuation,
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
  is_parameter,
  is_plain_object,
  is_promise,
  is_prototype,
  is_raw_lambda,
} from "./guards.js";
import { SchemeSymbol } from "./LSymbol.js";
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
import { Nil, nil, SchemeCharacter } from "./types.js";
import * as specials from "./specials.js";
import { LambdaContext } from "./LambdaContext.js";
import { call_function, resolve_promises } from "./call-function.js";
import { isNumeric, SchemeExact, SchemeInexact } from "./numbers.js";
import { type, typecheck, typecheck_args, typeErrorMessage } from "./utils/typecheck.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "./utils/parsing.js";
import { EnvLookup } from "./EnvLookup.js";
import { Values } from "./Values.js";
import { available_class, class_map, unserialize } from "./serialize.js";
import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { Pair } from "./Pair.js";
import { promise_all, unpromise } from "./utils/promises.js";
import { compose, curry, fold, pipe } from "./utils/functional.js";

import { SchemeBool } from "./LBool.js";
import { SchemeString } from "./LString.js";
import { NOT_FOUND, SandboxViolationError, SchemeJSFunction, SchemeJSObject, sandboxedAccess } from "./membrane.js";
import genRun, { type EvalContext, evaluate as genEvaluate, isSpeculating } from "./evaluator.js";

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

function is_gensym(symbol: SchemeValue): boolean {
  if (typeof symbol === "symbol") {
    return !!/^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

// -------------------------------------------------------------------------
const gensym = (function () {
  let count = 0;

  function with_props(name, sym) {
    const symbol = new SchemeSymbol(sym);
    hidden_prop(symbol, "__literal__", name);
    return symbol;
  }

  return function (name: SchemeValue = null) {
    if (name instanceof SchemeSymbol) {
      if (name.is_gensym()) {
        return name;
      }
      name = name.valueOf();
    }
    if (is_gensym(name)) {
      // don't do double gynsyms in nested syntax-rules
      return new SchemeSymbol(name);
    }
    // use ES6 symbol as name for lips symbol (they are unique)
    if (name !== null) {
      return with_props(name, Symbol(`#:${name}`));
    }
    count++;
    return with_props(count, Symbol(`#:g${count}`));
  };
})();
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
function equal(x, y) {
  if (is_function(x)) {
    return is_function(y) && unbind(x) === unbind(y);
  } else if (x instanceof SchemeExact) {
    // Exact numbers - must both be exact for equal?
    return y instanceof SchemeExact && x.equals(y);
  } else if (x instanceof SchemeInexact) {
    // Inexact numbers - must both be inexact for equal?
    return y instanceof SchemeInexact && x.equals(y);
  } else if (typeof x === "number") {
    if (typeof y !== "number") {
      return false;
    }
    if (Number.isNaN(x)) {
      return Number.isNaN(y);
    }
    if (x === Number.NEGATIVE_INFINITY) {
      return y === Number.NEGATIVE_INFINITY;
    }
    if (x === Number.POSITIVE_INFINITY) {
      return y === Number.POSITIVE_INFINITY;
    }
    // For regular numbers, use Object.is for -0/+0 distinction, otherwise simple equality
    if (x === 0 && y === 0) {
      return Object.is(x, y);
    }
    return x === y;
  } else if (x instanceof SchemeCharacter) {
    if (!(y instanceof SchemeCharacter)) {
      return false;
    }
    return x.__char__ === y.__char__;
  } else if (x instanceof SchemeBool) {
    return y instanceof SchemeBool && x.value === y.value;
  } else if (
    (typeof x === "string" || x instanceof SchemeString) &&
    (typeof y === "string" || y instanceof SchemeString)
  ) {
    // this is part of "friendly" compatibility layer. it's not directly following scheme logic but solves lot of problems
    return x.valueOf() === y.valueOf();
  } else {
    return x === y;
  }
}

// ----------------------------------------------------------------------
// R7RS § 6.1 — three-tier equivalence hierarchy.
//
// War story: `eq?` and `eqv?` were both aliased to `equal` (lips.ts:3634-3635
// pre-fix), so every dispatch flowed through one helper whose string branch
// (lips.ts:670-672 — `x.valueOf() === y.valueOf()`) collapsed distinct heap
// SchemeString instances to #t. That collapsed the three-tier R7RS hierarchy
// into a single `equal?`-flavoured comparison, breaking `memq`/`assv`/`case`
// dispatch and the R7RS § 6.1 atom-grade contract that `(eqv? (string-copy "a")
// (string-copy "a"))` MUST be #f.
//
// Why three functions, not two-plus-an-alias:
//   - `eq?` — pointer-grade. R7RS allows implementations to make immediates
//     (numbers, chars, interned symbols, nil, booleans) answer #t even across
//     distinct heap copies; we lean inclusive there because the provenance
//     clone machinery (AValue.withProvenance) routinely mints copies of
//     canonically-identifying values that should still compare eq? Without
//     this carve-out, `(eq? (if #t #f #t) (if #f #t #f))` would surprise
//     readers — both arms produce a SchemeBool(false) clone with different
//     provenance heap-id, but the canonical answer is #t.
//   - `eqv?` — same as eq? plus explicit number/char value equality. Per
//     R7RS § 6.1, "eqv? returns #t if obj1 and obj2 are both exact numbers and
//     are numerically equal" — but eq? above already covers SchemeExact and
//     SchemeInexact via the .equals() call, so eqv?'s extra coverage is empty
//     here. Kept as a distinct function so any future divergence (e.g.
//     NaN/±0 handling change) lands in one place, and so the binding shape
//     reflects the R7RS contract a reader expects.
//   - `equal?` — structural recursion. Bound in bridge.ts via deepEqual,
//     untouched.
//
// Provenance-clone trap: `x === y` is NOT sufficient for symbols/nil/booleans
// because every withProvenance() call mints a fresh heap object. Use
// instance-aware checks (SchemeSymbol.__name__, Nil instanceof, SchemeBool.value)
// so clones still compare eq? — otherwise an `if`-induced provenance clone of
// `nil` or `#f` would fail eq? against the singleton, breaking `(eq? x '())`
// in the most common interpreter shape.
function eq(x: SchemeValue, y: SchemeValue): boolean {
  if (x === y) return true;
  // Symbol interning: parser produces shared SchemeSymbol instances, but
  // provenance clones break heap identity. Name equality is the canonical
  // R7RS answer for interned symbols.
  if (x instanceof SchemeSymbol && y instanceof SchemeSymbol) return x.__name__ === y.__name__;
  // Nil singleton: every nil-clone (from withProvenance) is observably the
  // empty list; eq? must answer #t. See clone-identity.test.ts for the
  // meta-bug ledger across other modules.
  if (x instanceof Nil && y instanceof Nil) return true;
  // Booleans: #t and #f have schemeTrue/schemeFalse singletons, but clones
  // exist. Compare by .value so clones still satisfy the contract.
  if (x instanceof SchemeBool && y instanceof SchemeBool) return x.value === y.value;
  // Characters: SchemeCharacter doesn't intern, so even literal `#\a` mints
  // fresh instances. Compare by __char__.
  if (x instanceof SchemeCharacter && y instanceof SchemeCharacter) return x.__char__ === y.__char__;
  // Numbers: R7RS-implementation-defined for eq? on numbers, but treating
  // them with eqv? semantics is the standard choice (chibi, gambit, racket).
  if (x instanceof SchemeExact && y instanceof SchemeExact) return x.equals(y);
  if (x instanceof SchemeInexact && y instanceof SchemeInexact) return x.equals(y);
  // Everything else (Pair, vector/Array, SchemeString, plain objects) keeps
  // strict pointer-grade: distinct heap instances answer #f. This is what
  // distinguishes eq?/eqv? from equal? — and what makes the string-copy
  // bug from the prior `equal`-alias collapse stay fixed.
  return false;
}

function eqv(x: SchemeValue, y: SchemeValue): boolean {
  // Per R7RS § 6.1: eqv? is "eq? plus explicit number/char equality." Our
  // eq() above already includes both number branches (.equals on SchemeExact/
  // SchemeInexact) and char equality (__char__), so eqv? today reduces to
  // exactly eq?. Kept as a separate symbol so the binding mirrors the R7RS
  // contract and so any future divergence (e.g. NaN handling, ±0, exact/
  // inexact crossing) has a named home rather than living inside eq.
  return eq(x, y);
}

// ----------------------------------------------------------------------
function same_atom(a, b) {
  if (type(a) !== type(b)) {
    return false;
  }
  if (!is_atom(a)) {
    return false;
  }
  if (a instanceof RegExp) {
    return a.source === b.source;
  }
  if (a instanceof SchemeString) {
    return a.valueOf() === b.valueOf();
  }
  return equal(a, b);
}

// ----------------------------------------------------------------------
function is_atom(obj) {
  return (
    obj instanceof SchemeSymbol ||
    SchemeString.isString(obj) ||
    is_nil(obj) ||
    obj === null ||
    obj instanceof SchemeCharacter ||
    obj instanceof SchemeExact ||
    obj instanceof SchemeInexact ||
    obj === true ||
    obj === false
  );
}

// ----------------------------------------------------------------------
const macro = "define-macro";
// ----------------------------------------------------------------------
const recur_guard = -10_000;

function macro_expand(): SchemeFunction {
  return async function (this: Environment, code: SchemeValue, args: SchemeValue) {
    const env = (args["env"] = this);
    let bindings: SchemeValue[] = [];
    const let_macros = new Set(["let", "let*", "letrec"]);
    const lambda = global_env.get("lambda");
    const define = global_env.get("define");

    function is_let_macro(symbol) {
      const name = symbol.valueOf();
      return let_macros.has(name);
    }

    function is_procedure(value, node) {
      return value === define && is_pair(node.cdr.car);
    }

    function is_lambda(value) {
      return value === lambda;
    }

    function proc_bindings(node: SchemeValue) {
      const names: SchemeValue[] = [];
      while (true) {
        if (is_nil(node)) {
          break;
        } else {
          if (node instanceof SchemeSymbol) {
            names.push(node.valueOf());
            break;
          }
          names.push((node.car as SchemeValue).valueOf());
          node = node.cdr;
        }
      }
      return [...bindings, ...names];
    }

    function let_binding(node) {
      return [
        ...bindings,
        ...node.to_array(false).map(function (node: SchemeValue) {
          invariant(is_pair(node), `macroexpand: Invalid let binding expectig pair got ${type(node)}`);
          return (node.car as SchemeValue).valueOf();
        }),
      ];
    }

    function is_macro(name, value) {
      return value instanceof Macro && value.__defmacro__ && !bindings.includes(name);
    }

    async function expand_let_binding(node: SchemeValue, n?: number): Promise<SchemeValue> {
      if (is_nil(node)) {
        return nil;
      }
      const pair = node.car;
      return new Pair(new Pair(pair.car, await traverse(pair.cdr, n ?? -1, env)), await expand_let_binding(node.cdr));
    }

    async function traverse(node: SchemeValue, n: number, env: Environment): Promise<SchemeValue> {
      if (is_pair(node) && node.car instanceof SchemeSymbol) {
        if (node[__data__]) {
          return node;
        }
        const name = node.car.valueOf();
        const value = env.get(node.car, { throwError: false });
        const is_let = is_let_macro(node.car);

        const is_binding = is_let || is_procedure(value, node) || is_lambda(value);

        const nodeCdr = node.cdr as SchemeValue;
        if (is_binding && is_pair(nodeCdr.car)) {
          let second;
          if (is_let) {
            bindings = let_binding(nodeCdr.car);
            second = await expand_let_binding(nodeCdr.car, n);
          } else {
            bindings = proc_bindings(nodeCdr.car);
            second = nodeCdr.car;
          }
          return new Pair(node.car, new Pair(second, await traverse(nodeCdr.cdr, n, env)));
        } else if (is_macro(name, value)) {
          const code = value instanceof Syntax ? node : nodeCdr;
          let result = await (value as SchemeValue).invoke(code, { ...args, env }, true);
          if (value instanceof Syntax) {
            const { expr, scope } = result;
            if (is_pair(expr)) {
              if ((n !== -1 && n <= 1) || n < recur_guard) {
                return expr;
              }
              if (n !== -1) {
                n = n - 1;
              }
              return traverse(expr, n, scope);
            }
            result = expr;
          }
          if (result instanceof SchemeSymbol) {
            return quote(result);
          }
          if (is_pair(result)) {
            if ((n !== -1 && n <= 1) || n < recur_guard) {
              return result;
            }
            if (n !== -1) {
              n = n - 1;
            }
            return traverse(result, n, env);
          }
          if (is_atom(result)) {
            return result;
          }
        }
      }
      // TODO: CYCLE DETECT
      let car = node.car;
      if (is_pair(car)) {
        car = await traverse(car, n, env);
      }
      let cdr = node.cdr;
      if (is_pair(cdr)) {
        cdr = await traverse(cdr, n, env);
      }
      const pair = new Pair(car, cdr);
      return pair;
    }

    if (is_pair(code.cdr) && isNumeric(code.cdr.car)) {
      return quote((await traverse(code, code.cdr.car.valueOf(), env)).car);
    }
    return quote((await traverse(code, -1, env)).car);
  };
}

// ----------------------------------------------------------------------
// :: for usage in syntax-rule when pattern match it will return
// :: list of bindings from code that match the pattern
// :: TODO detect cycles
// ----------------------------------------------------------------------
function extract_patterns(
  pattern: SchemeValue,
  code: SchemeValue,
  symbols: SchemeValue,
  ellipsis_symbol: SchemeValue,
  scope: SchemeValue = {},
) {
  const bindings: SchemeValue = {
    "...": {
      symbols: {} as SchemeValue, // symbols ellipsis (x ...)
      lists: [] as SchemeValue[],
    },
    symbols: {} as SchemeValue,
  };
  const { expansion, define } = scope;
  // pattern_names parameter is used to distinguish
  // multiple matches of ((x ...) ...) against ((1 2 3) (1 2 3))
  // in loop we add x to the list so we know that this is not
  // duplicated ellipsis symbol
  log(symbols);

  function traverse(pattern: SchemeValue, code: SchemeValue, state: SchemeValue = {}) {
    const { ellipsis = false, trailing = false, pattern_names = [] } = state;
    log({
      code,
      pattern,
    });
    if (is_atom(pattern) && !(pattern instanceof SchemeSymbol)) {
      return same_atom(pattern, code);
    }
    if (pattern instanceof SchemeSymbol) {
      const literal = pattern.literal(); // TODO: literal() may be SLOW
      if (symbols.includes(literal)) {
        if (!SchemeSymbol.is(code, literal) && !SchemeSymbol.is(pattern, code)) {
          return false;
        }
        const ref = expansion.ref(literal);
        return !ref || ref === define || ref === global_env;
      }
    }
    if (Array.isArray(pattern) && Array.isArray(code)) {
      log("<<< a 1");
      if (pattern.length === 0 && code.length === 0) {
        return true;
      }
      if (SchemeSymbol.is(pattern[1], ellipsis_symbol)) {
        if (pattern[0] instanceof SchemeSymbol) {
          const name = pattern[0].valueOf();
          log(`<<< a 2 ${ellipsis}`);
          if (ellipsis) {
            const count = code.length - 2;
            const array_head = count > 0 ? code.slice(0, count) : code;
            const as_list = Pair.fromArray(array_head, false);
            if (bindings["..."].symbols[name]) {
              bindings["..."].symbols[name].append(new Pair(as_list, nil));
            } else {
              bindings["..."].symbols[name] = new Pair(as_list, nil);
            }
          } else {
            bindings["..."].symbols[name] = Pair.fromArray(code, false);
          }
        } else if (Array.isArray(pattern[0])) {
          log("<<< a 3");
          const names = [...pattern_names];
          const new_state = { ...state, pattern_names: names, ellipsis: true };
          if (!code.every((node) => traverse(pattern[0], node, new_state))) {
            return false;
          }
        }
        if (pattern.length > 2) {
          const pat = pattern.slice(2);
          return traverse(pat, code.slice(-pat.length), state);
        }
        return true;
      }
      const first = traverse(pattern[0], code[0], state);
      log({ first, pattern: pattern[0], code: code[0] });
      const rest = traverse(pattern.slice(1), code.slice(1), state);
      log({ first, rest });
      return first && rest;
    }
    // pattern (a b (x ...)) and (x ...) match nil
    if (
      is_pair(pattern) &&
      is_pair(pattern.car) &&
      is_pair(pattern.car.cdr) &&
      SchemeSymbol.is(pattern.car.cdr.car, ellipsis_symbol)
    ) {
      log(">> 0");
      if (is_nil(code)) {
        log({ pattern });
        if (pattern.car.car instanceof SchemeSymbol) {
          const name = pattern.car.car.valueOf();
          invariant(!bindings["..."].symbols[name], "syntax: named ellipsis can only appear onces");
          bindings["..."].symbols[name] = code;
        }
      }
    }
    if (is_pair(pattern) && is_pair(pattern.cdr) && SchemeSymbol.is(pattern.cdr.car, ellipsis_symbol)) {
      log(">> 1 (a)");
      // pattern (... ???) - SRFI-46
      if (!is_nil(pattern.cdr.cdr) && is_pair(pattern.cdr.cdr)) {
        log(">> 1 (b)");
        // if we have (x ... a b) we need to remove two from the end
        const list_len = pattern.cdr.cdr.length();
        const improper_list = !is_nil(pattern.last_pair()!.cdr);
        if (!is_pair(code)) {
          return false;
        }
        let code_len = code.length();
        let list = code;
        const trailing = improper_list ? 1 : 1;
        while (code_len - trailing > list_len) {
          list = list.cdr as Pair;
          code_len--;
        }
        const rest = list.cdr;
        list.cdr = nil;
        const new_sate = { ...state, trailing: improper_list };
        if (!traverse(pattern.cdr.cdr, rest, new_sate)) {
          return false;
        }
      }
      if (pattern.car instanceof SchemeSymbol) {
        const name = pattern.car.__name__;
        if (bindings["..."].symbols[name] && !pattern_names.includes(name) && !ellipsis) {
          throw new Error("syntax: named ellipsis can only appear onces");
        }
        log(">> 1 (next)");
        if (is_nil(code)) {
          log(">> 2");
          if (ellipsis) {
            log("NIL");
            bindings["..."].symbols[name] = nil;
          } else {
            log("NULL");
            bindings["..."].symbols[name] = null;
          }
        } else if (is_pair(code) && (is_pair(code.car) || is_nil(code.car))) {
          log(`>> 3 ${ellipsis}`);
          if (ellipsis) {
            if (bindings["..."].symbols[name]) {
              let node = bindings["..."].symbols[name];
              node = is_nil(node) ? new Pair(nil, new Pair(code, nil)) : node.append(new Pair(code, nil));
              bindings["..."].symbols[name] = node;
            } else {
              bindings["..."].symbols[name] = new Pair(code, nil);
            }
          } else {
            log(">> 4");
            bindings["..."].symbols[name] = new Pair(code, nil);
          }
        } else {
          log(">> 6");
          if (is_pair(code)) {
            log(`>> 7 ${ellipsis}`);
            // cons (a . b) => (var ... . x)
            if (!is_pair(code.cdr) && !is_nil(code.cdr)) {
              log(">> 7 (b)");
              if (is_nil(pattern.cdr.cdr)) {
                return false;
              } else if (!bindings["..."].symbols[name]) {
                bindings["..."].symbols[name] = new Pair(code.car, nil);
                return traverse(pattern.cdr.cdr, code.cdr, state);
              }
            }
            // code as improper list
            const last_pair = code.last_pair()!;
            log({ last_pair });
            if (!is_nil(last_pair.cdr)) {
              log(">> 7 (c)");
              if (is_nil(pattern.cdr.cdr)) {
                // case (a ...) for (a b . x)
                return false;
              } else {
                log(">> 7 (d)");
                // case (a ... . b) for (a b . x)
                const copy = code.clone();
                copy.last_pair()!.cdr = nil;
                bindings["..."].symbols[name] = copy;
                return traverse(pattern.cdr.cdr, last_pair.cdr, state);
              }
            }
            pattern_names.push(name);
            if (bindings["..."].symbols[name]) {
              log(">> 7 (f)");
              const node = bindings["..."].symbols[name];
              bindings["..."].symbols[name] = node.append(new Pair(code, nil));
            } else {
              log(">> 7 (e)");
              bindings["..."].symbols[name] = new Pair(code, nil);
            }
            log({ IIIIII: bindings["..."].symbols[name] });
          } else if (
            pattern.car instanceof SchemeSymbol &&
            is_pair(pattern.cdr) &&
            SchemeSymbol.is(pattern.cdr.car, ellipsis_symbol)
          ) {
            // empty ellipsis with rest  (a b ... . d) #290
            log(">> 8");
            bindings["..."].symbols[name] = null;
            return traverse(pattern.cdr.cdr, code, state);
          } else {
            log(">> 9");
            return false;
            //bindings['...'].symbols[name] = code;
          }
        }
        return true;
      } else if (is_pair(pattern.car)) {
        var names = [...pattern_names];
        if (is_nil(code)) {
          log(">> 10");
          bindings["..."].lists.push(nil);
          return true;
        }
        log(">> 11");
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (is_pair(node)) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      if (Array.isArray(pattern.car)) {
        var names = [...pattern_names];
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (is_pair(node)) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      return false;
    }
    if (pattern instanceof SchemeSymbol) {
      invariant(!SchemeSymbol.is(pattern, ellipsis_symbol), "syntax: invalid usage of ellipsis");
      log(">> 12");
      const name = pattern.__name__;
      if (symbols.includes(name)) {
        return true;
      }
      if (ellipsis) {
        log(bindings["..."].symbols[name]);
        bindings["..."].symbols[name] ??= [];
        bindings["..."].symbols[name].push(code);
      } else {
        bindings.symbols[name] = code;
      }
      return true;
    }
    if (is_pair(pattern) && is_pair(code)) {
      log(">> 13");
      log({
        a: 13,
        code,
        pattern,
      });
      const rest_pattern = pattern.car instanceof SchemeSymbol && pattern.cdr instanceof SchemeSymbol;
      if (trailing && rest_pattern) {
        log(">> 13 (a)");
        // handle (x ... y . z)
        if (!is_nil(code.cdr)) {
          return false;
        }
        const car = (pattern.car as SchemeSymbol).valueOf();
        const cdr = (pattern.cdr as SchemeSymbol).valueOf();
        bindings.symbols[car] = code.car;
        bindings.symbols[cdr] = nil;
        return true;
        //return is_pair(code.cdr) && code.cdr.length() > 1;
      }
      if (is_nil(code.cdr)) {
        log(">> 13 (b)");
        // last item in in call using in recursive calls on
        // last element of the list
        // case of pattern (p . rest) and code (0)
        if (rest_pattern) {
          // fix for SRFI-26 in recursive call of (b) ==> (<> . x)
          // where <> is symbol
          if (!traverse(pattern.car, code.car, state)) {
            return false;
          }
          log(">> 14");
          let name = (pattern.cdr as SchemeValue).valueOf();
          if (!(name in bindings.symbols)) {
            bindings.symbols[name] = nil;
          }
          name = (pattern.car as SchemeValue).valueOf();
          if (!(name in bindings.symbols)) {
            bindings.symbols[name] = code.car;
          }
          return true;
        }
      }
      log({
        pattern,
        code,
      });
      // case (x y) ===> (var0 var1 ... warn) where var1 match nil
      // trailing: true start processing of (var ... x . y)
      if (
        is_pair(pattern.cdr) &&
        is_pair(pattern.cdr.cdr) &&
        pattern.cdr.car instanceof SchemeSymbol &&
        SchemeSymbol.is(pattern.cdr.cdr.car, ellipsis_symbol) &&
        is_pair(pattern.cdr.cdr.cdr) &&
        !SchemeSymbol.is(pattern.cdr.cdr.cdr.car, ellipsis_symbol) &&
        traverse(pattern.car, code.car, state) &&
        traverse(pattern.cdr.cdr.cdr, code.cdr, { ...state, trailing: true })
      ) {
        const name = pattern.cdr.car.__name__;
        log({
          pattern,
          code,
          name,
        });
        if (symbols.includes(name)) {
          return true;
        }
        bindings["..."].symbols[name] = null;
        return true;
      }
      log("recur");
      log({
        pattern,
        code,
      });
      const car = traverse(pattern.car, code.car, state);
      const cdr = traverse(pattern.cdr, code.cdr, state);
      log({
        $car_code: code.car,
        $car_pattern: pattern.car,
        car,
        $cdr_code: code.cdr,
        $cdr_pattern: pattern.cdr,
        cdr,
      });
      if (car && cdr) {
        return true;
      }
    } else if (is_nil(pattern) && (is_nil(code) || code === undefined)) {
      // undefined is case when you don't have body ...
      // and you do recursive call
      return true;
    } else {
      // pattern (...)
      invariant(
        !is_pair(pattern.car) || !SchemeSymbol.is(pattern.car.car, ellipsis_symbol),
        "syntax: invalid usage of ellipsis",
      );
      return false;
    }
  }

  if (traverse(pattern, code)) {
    return bindings;
  }
}

// ----------------------------------------------------------------------
// :: This function is called after syntax-rules macro is evaluated
// :: and if there are any gensyms added by macro they need to restored
// :: to original symbols
// ----------------------------------------------------------------------
function clear_gensyms(node, gensyms) {
  function traverse(node) {
    if (is_pair(node)) {
      if (gensyms.length === 0) {
        return node;
      }
      const car = traverse(node.car);
      const cdr = traverse(node.cdr);
      // TODO: check if it's safe to modify the list
      //       some funky modify of code can happen in macro
      return new Pair(car, cdr);
    } else if (node instanceof SchemeSymbol) {
      const replacement = gensyms.find((gensym) => {
        return gensym.gensym === node;
      });
      if (replacement) {
        return new SchemeSymbol(replacement.name);
      }
      return node;
    } else {
      return node;
    }
  }

  return traverse(node);
}

// ----------------------------------------------------------------------
function transform_syntax(options: SchemeValue = {}) {
  const { bindings, expr, scope, symbols, names, ellipsis: ellipsis_symbol } = options;
  const gensyms = {};

  function valid_symbol(symbol) {
    if (symbol instanceof SchemeSymbol) {
      return true;
    }
    return ["string", "symbol"].includes(typeof symbol);
  }

  function transform(symbol) {
    invariant(valid_symbol(symbol), `syntax: internal error, need symbol got ${type(symbol)}`);
    const name = symbol.valueOf();
    invariant(name !== ellipsis_symbol, "syntax: internal error, ellipsis not transformed");
    // symbols are gensyms from nested syntax-rules
    const n_type = typeof name;
    if (["string", "symbol"].includes(n_type)) {
      if (name in bindings.symbols) {
        return bindings.symbols[name];
      } else if (n_type === "string" && /\./.test(name)) {
        // calling method on pattern symbol #83
        const parts = name.split(".");
        const first = parts[0];
        if (first in bindings.symbols) {
          return Pair.fromArray([
            new SchemeSymbol("."),
            bindings.symbols[first],
            ...parts.slice(1).map((x) => new SchemeString(x)),
          ]);
        }
      }
    }
    if (symbols.includes(name)) {
      return symbol;
    }
    return rename(name, symbol);
  }

  function rename(name, symbol) {
    if (!gensyms[name]) {
      const ref = scope.ref(name);
      // nested syntax-rules needs original symbol to get renamed again
      if (typeof name === "symbol" && !ref) {
        name = symbol.literal();
      }
      if (gensyms[name]) {
        return gensyms[name];
      }
      const gensym_name = gensym(name);
      if (ref) {
        const value = scope.get(name);
        scope.set(gensym_name, value);
      } else {
        const value = scope.get(name, { throwError: false });
        // value is not in scope, but it's JavaScript object
        if (value !== undefined) {
          scope.set(gensym_name, value);
        }
      }
      // keep names so they can be restored after evaluation
      // if there are free symbols as output
      // kind of hack
      names.push({
        name,
        gensym: gensym_name,
      });
      gensyms[name] = gensym_name;
      // we need to check if name is a string, because it can be
      // gensym from nested syntax-rules
      if (typeof name === "string" && /\./.test(name)) {
        const [first, ...rest] = name.split(".").filter(Boolean);
        // save JavaScript dot notation for Env::get
        if (gensyms[first]) {
          hidden_prop(gensym_name, "__object__", [gensyms[first], ...rest]);
        }
      }
    }
    return gensyms[name];
  }

  function transform_ellipsis_expr(
    expr: SchemeValue,
    bindings: SchemeValue,
    state: { nested: boolean },
    next: (name: SchemeValue, value: SchemeValue) => void = () => {},
  ): SchemeValue {
    const { nested } = state;
    log({ bindings, expr });
    if (Array.isArray(expr) && expr.length === 0) {
      return expr;
    }
    if (expr instanceof SchemeSymbol) {
      const name = expr.valueOf();
      if (is_gensym(expr) && !bindings[name]) {
        // name = expr.literal();
      }
      log("[t 1");
      if (bindings[name]) {
        if (is_pair(bindings[name])) {
          const { car, cdr } = bindings[name];
          if (nested) {
            const { car: caar, cdr: cadr } = car as SchemeValue;
            if (!is_nil(cadr)) {
              next(name, new Pair(cadr, nil));
            }
            return caar;
          }
          if (!is_nil(cdr)) {
            next(name, cdr);
          }
          return car;
        } else if (Array.isArray(bindings[name])) {
          next(name, bindings[name].slice(1));
          return bindings[name][0];
        }
      }
      return transform(expr);
    }
    const is_array = Array.isArray(expr);
    if (is_pair(expr) || is_array) {
      const exprAny = expr as SchemeValue;
      const first = is_array ? expr[0] : exprAny.car;
      const second = is_array ? expr[1] : is_pair(exprAny.cdr) && exprAny.cdr.car;
      if (first instanceof SchemeSymbol && SchemeSymbol.is(second, ellipsis_symbol)) {
        const rest = is_array ? expr.slice(2) : exprAny.cdr.cdr;
        log("[t 2");
        const name = first.valueOf();
        const item = bindings[name];
        if (item === null) {
          return;
        } else if (name in bindings) {
          log({ name, binding: bindings[name] });
          if (is_pair(item)) {
            log(`[t 2 Pair ${nested}`);
            const { car, cdr } = item;
            const rest_expr = is_array ? expr.slice(2) : exprAny.cdr.cdr;
            if (nested) {
              if (!is_nil(cdr)) {
                log("|| next 1");
                next(name, cdr);
              }
              if ((is_array && rest_expr.length > 0) || (!is_nil(rest_expr) && !is_array)) {
                const rest = transform_ellipsis_expr(rest_expr, bindings, state, next);
                if (is_array) {
                  return (car as SchemeValue).concat(rest);
                } else if (is_pair(car)) {
                  return car.append(rest);
                } else {
                  log("UNKNOWN");
                }
              }
              return car;
            } else if (is_pair(car)) {
              if (!is_nil(car.cdr)) {
                log("|| next 2");
                next(name, new Pair(car.cdr, cdr));
              }
              // wrap with EnvLookup to handle undefined
              return new EnvLookup(car.car);
            } else if (is_nil(cdr)) {
              return car;
            } else {
              const last_pair = (expr as Pair).last_pair()!;
              if (last_pair.cdr instanceof SchemeSymbol) {
                log("|| next 3");
                next(name, item.last_pair());
                return car;
              }
            }
          } else if (Array.isArray(item)) {
            log(`[t 2 Array ${nested}`);
            if (nested) {
              next(name, item.slice(1));
              return Pair.fromArray(item);
            } else {
              const rest = item.slice(1);
              if (rest.length > 0) {
                next(name, rest);
              }
              return item[0];
            }
          } else {
            return item;
          }
        }
      }
      log("[t 3 recur ", expr);
      const rest_expr = is_array ? expr.slice(1) : expr.cdr;
      const head = transform_ellipsis_expr(first, bindings, state, next);
      const rest = transform_ellipsis_expr(rest_expr, bindings, state, next);
      log({ head, rest });
      if (is_array) {
        return [head, ...rest];
      }
      return new Pair(head, rest);
    }
    return expr;
  }

  function have_binding(binding: Record<string | symbol, unknown>, skip_nulls = false) {
    const values = Object.values(binding);
    const symbols = Object.getOwnPropertySymbols(binding);
    if (symbols.length > 0) {
      values.push(...symbols.map((x) => binding[x]));
    }
    return (
      values.length > 0 &&
      values.every((x) => {
        if (x === null) {
          return !skip_nulls;
        }
        return is_pair(x) || is_nil(x) || (Array.isArray(x) && x.length > 0);
      })
    );
  }

  function get_names(object) {
    return [...Object.keys(object), ...Object.getOwnPropertySymbols(object)];
  }

  function traverse(expr: SchemeValue, { disabled }: SchemeValue = {}) {
    log("traverse>> ", expr);
    const is_array = Array.isArray(expr);
    if (is_array && expr.length === 0) {
      return expr;
    }
    if (is_pair(expr) || is_array) {
      const exprVal = expr as SchemeValue;
      log(">> 0");
      const first = is_array ? expr[0] : exprVal.car;
      let second, rest_second;
      if (is_array) {
        second = expr[1];
        rest_second = expr.slice(2);
      } else if (is_pair(exprVal.cdr)) {
        second = exprVal.cdr.car;
        rest_second = exprVal.cdr.cdr;
      }
      log({ first, second, rest_second });
      // escape ellispsis from R7RS e.g. (... ...)
      if (!disabled && is_pair(first) && SchemeSymbol.is(first.car, ellipsis_symbol)) {
        return new Pair((first.cdr as SchemeValue).car, traverse(exprVal.cdr));
      }
      if (second && SchemeSymbol.is(second, ellipsis_symbol) && !disabled) {
        log(">> 1");
        const symbols = bindings["..."].symbols;
        // skip expand list of pattern was (x y ... z)
        // and code was (x z) so y == null
        const values = Object.values(symbols);
        if (values.length > 0 && values.every((x) => x === null)) {
          log(">>> 1 (a)");
          return traverse(rest_second, { disabled });
        }
        const keys = get_names(symbols);
        // case of list as first argument ((x . y) ...) or (x ... ...)
        // we need to recursively process the list
        // if we have pattern (_ (x y z ...) ...) and code (foo (1 2) (1 2))
        // x an y will be arrays of [1 1] and [2 2] and z will be array
        // of rest, x will also have it's own mapping to 1 and y to 2
        // in case of usage outside of ellipsis list e.g.: (x y)
        const is_spread = first instanceof SchemeSymbol && SchemeSymbol.is(rest_second.car, ellipsis_symbol);
        if (is_pair(first) || is_spread) {
          log(">>> 1 (b)");
          // lists is free ellipsis on pairs ((???) ...)
          // TODO: will this work in every case? Do we need to handle
          // nesting here?
          if (is_nil(bindings["..."].lists[0])) {
            if (!is_spread) {
              return traverse(rest_second, { disabled });
            }
            log(rest_second);
            return nil;
          }
          let new_expr = first;
          if (is_spread) {
            log(">>> 1 (c)"); // TODO: array
            new_expr = new Pair(first, new Pair(second, nil));
          }
          log(">> 2");
          let result;
          if (keys.length > 0) {
            log(">> 2 (a)");
            let bind = { ...symbols };
            result = is_array ? [] : nil;
            while (true) {
              log({ bind });
              if (!have_binding(bind)) {
                break;
              }
              const new_bind = {};
              const next = (key, value) => {
                // ellipsis decide if what should be the next value
                // there are two cases ((a . b) ...) and (a ...)
                new_bind[key] = value;
              };
              let car = transform_ellipsis_expr(new_expr, bind, { nested: true }, next);
              // undefined can be null caused by null binding
              // on empty ellipsis
              if (car !== undefined) {
                if (car instanceof EnvLookup) {
                  car = car.valueOf();
                }
                if (is_spread) {
                  if (is_array) {
                    if (Array.isArray(car)) {
                      result.push(...car);
                    } else {
                      log("ZONK {1}");
                    }
                  } else {
                    result = is_nil(result) ? car : result.append(car);
                  }
                } else if (is_array) {
                  result.push(car);
                } else {
                  result = new Pair(car, result);
                }
              }
              bind = new_bind;
            }
            if (!is_nil(result) && !is_spread && !is_array) {
              result = result.reverse();
            }
            // case of (list) ... (rest code)
            if (is_array) {
              if (rest_second) {
                log({ rest_second, expr });
                const rest = traverse(rest_second, { disabled });
                return result.concat(rest);
              }
              return result;
            }
            if (!is_nil(exprVal.cdr.cdr) && !SchemeSymbol.is(exprVal.cdr.cdr.car, ellipsis_symbol)) {
              const rest = traverse(exprVal.cdr.cdr, { disabled });
              return result.append(rest);
            }
            return result;
          } else {
            log(">> 3");
            let car = transform_ellipsis_expr(first, symbols, {
              nested: true,
            });
            if (car) {
              if (car instanceof EnvLookup) {
                car = car.valueOf();
              }
              return new Pair(car, nil);
            }
            return nil;
          }
        } else if (first instanceof SchemeSymbol) {
          log(">> 4");
          if (SchemeSymbol.is(rest_second.car, ellipsis_symbol)) {
            // case (x ... ...)
            log(">> 4 (a)");
          } else {
            log(">> 4 (b)");
          }
          // case: (x ...)
          const name = first.__name__;
          let bind = { [name]: symbols[name] };
          log({ bind });
          const is_null = symbols[name] === null;
          let result: SchemeValue = is_array ? [] : nil;
          while (true) {
            if (!have_binding(bind, true)) {
              log({ bind });
              break;
            }
            const new_bind = {};
            const next = (key, value) => {
              new_bind[key] = value;
            };
            let value = transform_ellipsis_expr(expr, bind, { nested: false }, next);
            log({ value });
            if (value !== undefined) {
              if (value instanceof EnvLookup) {
                value = value.valueOf();
              }
              if (is_array) {
                result.push(value);
              } else {
                result = new Pair(value, result);
              }
            }
            bind = new_bind;
          }
          if (!is_nil(result) && !is_array) {
            result = result.reverse();
          }
          // case if (x ... y ...) second spread is not processed
          // and (??? . x) last symbol
          // by ellipsis transformation
          const exprCdr = (expr as SchemeValue).cdr;
          if (is_pair(exprCdr) && (is_pair(exprCdr.cdr) || exprCdr.cdr instanceof SchemeSymbol)) {
            const node = traverse(exprCdr.cdr, { disabled });
            log({ node });
            if (is_null) {
              return node;
            }
            if (is_nil(result)) {
              result = node;
            } else {
              result.append(node);
            }
            log({ result, node });
          }
          log("<<<< 2");
          log({ result });
          return result;
        }
      }
      const head = traverse(first, { disabled });
      let rest;
      let is_syntax;
      if (first instanceof SchemeSymbol) {
        const value = scope.get(first, { throwError: false });
        is_syntax = value instanceof Macro && value.__name__ === "syntax-rules";
      }
      const exprAny = expr as SchemeValue;
      if (is_syntax) {
        rest =
          exprAny.cdr.car instanceof SchemeSymbol
            ? new Pair(
                traverse(exprAny.cdr.car, { disabled }),
                new Pair(exprAny.cdr.cdr.car, traverse(exprAny.cdr.cdr.cdr, { disabled })),
              )
            : new Pair(exprAny.cdr.car, traverse(exprAny.cdr.cdr, { disabled }));
        log("REST >>>> ", rest);
      } else {
        rest = traverse(exprAny.cdr, { disabled });
      }
      log({
        a: true,
        car: toString(exprAny.car),
        cdr: toString(exprAny.cdr),
        head: toString(head),
        rest: toString(rest),
      });
      return new Pair(head, rest);
    }
    if (expr instanceof SchemeSymbol) {
      if (disabled && SchemeSymbol.is(expr, ellipsis_symbol)) {
        return expr;
      }
      const symbols = Object.keys(bindings["..."].symbols);
      const name = expr.literal(); // TODO: slow
      invariant(!symbols.includes(name), `syntax-rules: missing ellipsis symbol next to name \`${name}'`);
      const value = transform(expr);
      if (value !== undefined) {
        return value;
      }
    }
    return expr;
  }

  return traverse(expr, {});
}

// -------------------------------------------------------------------------
function self_evaluated(obj) {
  const type = typeof obj;
  return (
    ["string", "function"].includes(type) ||
    typeof obj === "symbol" ||
    obj instanceof QuotedPromise ||
    obj instanceof SchemeSymbol ||
    obj instanceof SchemeString ||
    obj instanceof RegExp ||
    obj instanceof SchemeExact ||
    obj instanceof SchemeInexact
  );
}

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
function hidden_prop(obj, name, value) {
  Object.defineProperty(obj, Symbol.for(name), {
    get: () => value,
    set: () => {},
    configurable: false,
    enumerable: false,
  });
}

// ----------------------------------------------------------------------
function set_fn_length(fn, length) {
  try {
    Object.defineProperty(fn, "length", {
      get() {
        return length;
      },
    });
    return fn;
  } catch {
    const wrapper = function (this: unknown) {
      return Reflect.apply(fn, this, arguments);
    };
    Object.defineProperty(wrapper, "length", {
      value: length,
    });
    return wrapper;
  }
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
      results.push(evaluate(node.car, { env, dynamic_env, use_dynamic, error }));
      node = node.cdr;
    }
    const havePromises = results.filter(is_promise).length;
    return havePromises ? (promise_all(results) as Promise<unknown[]>).then(fn.bind(this)) : fn.call(this, results);
  });
}

// -------------------------------------------------------------------------
// :: Quote function used to pause evaluation from Macro
// -------------------------------------------------------------------------
export function quote(value) {
  if (is_promise(value)) {
    return value.then(quote);
  }
  if (is_pair(value) || value instanceof SchemeSymbol) {
    value[__data__] = true;
  }
  return value;
}

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
    "set!": doc(
      null,
      new Macro("set!", function (this: Environment, code: SchemeValue, { use_dynamic, ...rest }: SchemeValue = {}) {
        const dynamic_env = this;
        const env = this;
        let ref;
        const eval_args = { ...rest, env: this, dynamic_env, use_dynamic };
        let value = evaluate(code.cdr.car, eval_args);
        value = resolve_promises(value);

        function set(object, key, value) {
          if (is_promise(object)) {
            return object.then((key) => set(object, key, value));
          }
          if (is_promise(key)) {
            return key.then((key) => set(object, key, value));
          }
          if (is_promise(value)) {
            return value.then((value) => set(object, key, value));
          }
          (env.get("set-obj!") as SchemeFunction).call(env, object, key, value);
          return value;
        }

        if (is_pair(code.car) && SchemeSymbol.is(code.car.car, ".")) {
          const second = code.car.cdr.car;
          const third = code.car.cdr.cdr.car;
          const object = evaluate(second, eval_args);
          const key = evaluate(third, eval_args);
          return set(object, key, value);
        }
        TypeError.invariant(
          code.car instanceof SchemeSymbol,
          `set! first argument need to be a symbol or dot accessor that evaluate to object.`,
        );
        const symbol = code.car.valueOf();
        ref = this.ref(code.car.__name__);
        // we don't return value because we only care about sync of set value
        // when value is a promise
        return unpromise(value, (value) => {
          if (!ref) {
            // case (set! fn.toString (lambda () "xxx"))
            const parts = symbol.split(".");
            invariant(parts.length > 1, `Unbound variable \`${symbol}'`);
            const key = parts.pop();
            const name = parts.join(".");
            const obj = this.get(name, { throwError: false });
            if (obj) {
              set(obj, key, value);
              return;
            }
          }
          ref.set(symbol, value);
        });
      }),
    ),
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
        evaluate(code.car, { env: this, dynamic_env, error, use_dynamic }),
        function (value: SchemeValue) {
          typecheck("let-env", value, "environment");
          return evaluate(new Pair(new SchemeSymbol("begin"), code.cdr), {
            env: value,
            dynamic_env,
            error,
          });
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
      const eval_args = { ...options, env: this, dynamic_env: this };
      evaluate(new Pair(new SchemeSymbol("begin"), code), eval_args);
    }),
    // ------------------------------------------------------------------
    parameterize: doc(
      null,
      new Macro("parameterize", function (this: Environment, code: SchemeValue, options: SchemeValue) {
        const { dynamic_env } = options;
        const env = dynamic_env.inherit("parameterize").new_frame(null, {});
        const eval_args = { ...options, env: this };
        let params = code.car;
        invariant(is_pair(params), () => `Invalid syntax for parameterize expecting pair got ${type(params)}`);

        function next() {
          const body = new Pair(new SchemeSymbol("begin"), code.cdr);
          return evaluate(body, { ...eval_args, dynamic_env: env });
        }

        return (function loop() {
          const pair = params.car as SchemeValue;
          const name = pair.car.valueOf();
          return unpromise(evaluate(pair.cdr.car, eval_args), function (value) {
            const param = dynamic_env.get(name, { throwError: false });
            invariant(is_parameter(param), `Unknown parameter ${name}`);
            env.set(name, param.inherit(value));
            if (is_null(params.cdr)) {
              return next();
            } else {
              params = params.cdr;
              return loop();
            }
          });
        })();
      }),
    ),
    // ------------------------------------------------------------------
    "make-parameter": doc(
      null,
      new Macro("make-parameter", function (code, eval_args) {
        const dynamic_env = eval_args.dynamic_env;
        const init = evaluate(code.car, eval_args);
        let fn;
        if (is_pair(code.cdr.car)) {
          fn = evaluate(code.cdr.car, eval_args);
        }
        return new Parameter(init, fn);
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
        const syntax = evaluate(code.cdr.car, { env, ...eval_args });
        typecheck("define-syntax-parameter", syntax, "syntax", 2);
        syntax.__name__ = name.valueOf();
        if (syntax.__name__ instanceof SchemeString) {
          syntax.__name__ = syntax.__name__.valueOf();
        }
        env.set(code.car, new SyntaxParameter(syntax));
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
        const args = (global_env.get("list->array") as SchemeFunction)(code.car);
        const env = this.inherit("syntax-parameterize");
        while (args.length > 0) {
          const pair = args.shift();
          invariant(
            is_pair(pair) && pair.car instanceof SchemeSymbol,
            `syntax-parameterize: invalid syntax for syntax-parameterize: ${toString(code, true)}`,
          );
          const syntax = evaluate(((pair as Pair).cdr as Pair).car, { ...eval_args, env: this });
          const name = pair.car;
          typecheck("syntax-parameterize", syntax, ["syntax"]);
          typecheck("syntax-parameterize", name, "symbol");
          syntax.__name__ = name.valueOf();
          if (syntax.__name__ instanceof SchemeString) {
            syntax.__name__ = syntax.__name__.valueOf();
          }
          const parameter = new SyntaxParameter(syntax);
          // used inside syntax-rules
          if (name.is_gensym()) {
            const symbol = name.literal();
            const parent = this.get(symbol, { throwError: false });
            if (parent instanceof SyntaxParameter) {
              // create anaphoric binding for literal symbol
              env.set(symbol, parameter);
            }
          }
          env.set(name, parameter);
        }
        const expr = hygienic_begin([env, eval_args.dynamic_env], code.cdr);
        return evaluate(expr, { ...eval_args, env });
      }),
    ),
    // ------------------------------------------------------------------
    define: doc(
      null,
      Macro.defmacro("define", function (this: Environment, code: SchemeValue, eval_args: SchemeValue) {
        let env: Environment = this;
        if (is_pair(code.car) && code.car.car instanceof SchemeSymbol) {
          const new_code = new Pair(
            new SchemeSymbol("define"),
            new Pair(code.car.car, new Pair(new Pair(new SchemeSymbol("lambda"), new Pair(code.car.cdr, code.cdr)))),
          );
          return new_code;
        } else if (eval_args.macro_expand) {
          // prevent evaluation in macroexpand
          return;
        }
        eval_args.dynamic_env = this;
        eval_args.env = env;
        let value = code.cdr.car;
        let new_expr;
        if (is_pair(value)) {
          value = evaluate(value, eval_args);
          new_expr = true;
        } else if (value instanceof SchemeSymbol) {
          value = env.get(value);
        }
        typecheck("define", code.car, "symbol");
        return unpromise(value, (value) => {
          if ((env.__name__ as string | symbol) === Syntax.__merge_env__) {
            env = env.__parent__!;
          }
          if (
            new_expr &&
            ((is_function(value) && is_lambda(value)) || value instanceof Syntax || is_parameter(value))
          ) {
            (value as SchemeValue).__name__ = code.car.valueOf();
            if ((value as SchemeValue).__name__ instanceof SchemeString) {
              (value as SchemeValue).__name__ = (value as SchemeValue).__name__.valueOf();
            }
          }
          env.set(code.car, value);
        });
      }),
    ),
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
    lambda: new Macro("lambda", function (
      this: Environment,
      code: SchemeValue,
      { use_dynamic, error }: SchemeValue = {},
    ) {
      const self = this;

      function lambda(this: SchemeValue, ...args: SchemeValue[]) {
        // lambda got scopes as context in apply
        let { dynamic_env } = is_context(this) ? this : { dynamic_env: self };
        const env = self.inherit("lambda");
        dynamic_env = dynamic_env.inherit("lambda");
        if (this && !is_context(this)) {
          if (this && !this.__instance__) {
            Object.defineProperty(this, "__instance__", {
              enumerable: false,
              get: () => true,
              set: () => {},
              configurable: false,
            });
          }
          env.set("this", this);
        }
        // arguments and arguments.callee inside lambda function
        if (this instanceof LambdaContext) {
          const options = { throwError: false };
          env.set("arguments", this.env.get("arguments", options));
          env.set("parent.frame", this.env.get("parent.frame", options));
        } else {
          // this case is for lambda as callback function in JS; e.g. setTimeout
          const _args: SchemeValue = [...args];
          _args.callee = lambda;
          _args.env = env;
          env.set("arguments", _args);
        }

        function set(name, value) {
          env.__env__[name.__name__] = value;
          dynamic_env.__env__[name.__name__] = value;
        }

        let name = code.car;
        let i = 0;
        if (name instanceof SchemeSymbol || !is_nil(name)) {
          while (true) {
            if (!is_nil(name.car)) {
              if (name instanceof SchemeSymbol) {
                // rest argument,  can also be first argument
                const value = quote(Pair.fromArray(args.slice(i), false));
                set(name, value);
                break;
              } else if (is_pair(name)) {
                const value = args[i];
                set(name.car, value);
              }
            }
            if (is_nil(name.cdr)) {
              break;
            }
            i++;
            name = name.cdr;
          }
        }
        const rest = code.cdr;
        const output = hygienic_begin([env, dynamic_env], rest);
        const eval_args = {
          env,
          dynamic_env,
          use_dynamic,
          error,
        };
        return evaluate(output, eval_args);
      }

      const length = is_pair(code.car) ? code.car.length() : null;
      lambda.__code__ = new Pair(new SchemeSymbol("lambda"), code);
      lambda[__lambda__] = true;
      if (!is_pair(code.car)) {
        return lambda; // variable arguments
      }
      return set_fn_length(lambda, length);
    }),
    // ------------------------------------------------------------------
    macroexpand: doc(null, new Macro("macroexpand", macro_expand())),
    // ------------------------------------------------------------------
    "define-macro": doc(
      null,
      new Macro(macro, function (this: Environment, macro: SchemeValue, { use_dynamic, error }: SchemeValue) {
        if (is_pair(macro.car) && macro.car.car instanceof SchemeSymbol) {
          const name = macro.car.car.__name__;
          const makro_instance = Macro.defmacro(name, function (this: Environment, code: SchemeValue) {
            const env = new Environment("defmacro", {}, this);
            let name = macro.car.cdr;
            let arg = code;
            while (true) {
              if (is_nil(name)) {
                break;
              }
              if (name instanceof SchemeSymbol) {
                env.__env__[name.__name__] = arg;
                break;
              } else if (!is_nil(name.car)) {
                if (is_nil(arg)) {
                  env.__env__[name.car.__name__] = nil;
                } else {
                  if (is_pair(arg.car)) {
                    arg.car[__data__] = true;
                  }
                  env.__env__[name.car.__name__] = arg.car;
                }
              }
              if (is_nil(name.cdr)) {
                break;
              }
              if (!is_nil(arg)) {
                arg = arg.cdr;
              }
              name = name.cdr;
            }
            const eval_args = {
              env,
              dynamic_env: env,
              use_dynamic,
              error,
            };
            // evaluate macro
            if (is_pair(macro.cdr)) {
              // this eval will return lips code
              const rest = macro.cdr;
              const result = rest.reduce(function (result, node) {
                return evaluate(node, eval_args);
              });
              return unpromise(result, function (result) {
                if (result && typeof result === "object") {
                  delete (result as SchemeValue)[__data__];
                }
                return result;
              });
            }
          });
          (makro_instance as SchemeValue).__code__ = new Pair(new SchemeSymbol("define-macro"), macro);
          this.set(name, makro_instance);
        }
      }),
    ),
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
              const result = evaluate(expr, { ...eval_args, env: new_env });
              // Hack: update the result if there are generated
              //       gensyms that should be literal symbols
              // TODO: maybe not the part move when literal elisps may
              //       be generated, maybe they will need to be mark somehow
              return clear_gensyms(result, names);
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
    quasiquote: Macro.defmacro("quasiquote", function (this: Environment, arg: SchemeValue, env: SchemeValue) {
      const { use_dynamic, error } = env;
      const self = this;
      const dynamic_env = self;

      // -----------------------------------------------------------------
      function is_struct(value) {
        return is_pair(value) || is_plain_object(value) || Array.isArray(value);
      }

      // -----------------------------------------------------------------
      function resolve_pair(pair, fn, test = is_struct) {
        if (is_pair(pair)) {
          let car = pair.car;
          let cdr = pair.cdr;
          if (test(car)) {
            car = fn(car);
          }
          if (test(cdr)) {
            cdr = fn(cdr);
          }
          return is_promise(car) || is_promise(cdr)
            ? (promise_all([car, cdr]) as Promise<unknown[]>).then(([car, cdr]) => {
                return new Pair(car, cdr);
              })
            : new Pair(car, cdr);
        }
        return pair;
      }

      // -----------------------------------------------------------------
      function join(eval_pair, value) {
        if (is_nil(eval_pair) && is_nil(value)) {
          //return nil;
        }
        if (is_pair(eval_pair)) {
          if (!is_nil(value)) {
            eval_pair.append(value);
          }
        } else {
          eval_pair = new Pair(eval_pair, value);
        }
        return eval_pair;
      }

      // -----------------------------------------------------------------
      function unquoted_arr(arr) {
        return arr.some((value) => {
          return is_pair(value) && SchemeSymbol.is(value.car, /^(unquote|unquote-splicing)$/);
        });
      }

      // -----------------------------------------------------------------
      function quote_vector(arr, unquote_cnt, max_unq) {
        return arr.reduce((acc, x) => {
          if (!is_pair(x)) {
            acc.push(x);
            return acc;
          }
          if (SchemeSymbol.is(x.car, "unquote-splicing")) {
            let result;
            result =
              unquote_cnt + 1 < max_unq
                ? recur(x.cdr, unquote_cnt + 1, max_unq)
                : evaluate((x.cdr as SchemeValue).car, {
                    env: self,
                    use_dynamic,
                    dynamic_env,
                    error,
                  });
            invariant(is_pair(result), `Expecting list ${type(x)} found`);
            return acc.concat(result.to_array());
          }
          acc.push(recur(x, unquote_cnt, max_unq));
          return acc;
        }, []);
      }

      // -----------------------------------------------------------------
      function quote_object(object, unquote_cnt, max_unq) {
        const result = {};
        unquote_cnt++;
        for (const key of Object.keys(object)) {
          const value = object[key];
          if (is_pair(value)) {
            invariant(
              !SchemeSymbol.is(value.car, "unquote-splicing"),
              `You can't call \`unquote-splicing\` inside object`,
            );
            let output;
            output =
              unquote_cnt < max_unq
                ? recur((value.cdr as SchemeValue).car, unquote_cnt, max_unq)
                : evaluate((value.cdr as SchemeValue).car, {
                    env: self,
                    dynamic_env,
                    use_dynamic,
                    error,
                  });
            result[key] = output;
          } else {
            result[key] = value;
          }
        }
        if (Object.isFrozen(object)) {
          Object.freeze(result);
        }
        return result;
      }

      // -----------------------------------------------------------------
      function unquote_splice(pair, unquote_cnt, max_unq) {
        if (unquote_cnt < max_unq) {
          let cdr = nil;
          if (!is_nil(pair.cdr)) {
            cdr = recur(pair.cdr, unquote_cnt - 1, max_unq);
          }
          return new Pair(new Pair(pair.car.car, recur(pair.car.cdr, unquote_cnt, max_unq)), cdr);
        }
        const lists: SchemeValue[] = [];
        return (function next(node: SchemeValue) {
          const value = evaluate(node.car, {
            env: self,
            dynamic_env,
            use_dynamic,
            error,
          });
          lists.push(value);
          if (is_pair(node.cdr)) {
            return next(node.cdr);
          }
          return unpromise(lists, function (arr: SchemeValue) {
            if (arr.some((x: SchemeValue) => !is_pair(x))) {
              if (
                is_pair(pair.cdr) &&
                SchemeSymbol.is(pair.cdr.car, ".") &&
                is_pair(pair.cdr.cdr) &&
                is_nil(pair.cdr.cdr.cdr)
              ) {
                return pair.cdr.cdr.car;
              }
              invariant(is_nil(pair.cdr) || is_pair(pair.cdr), "You can't splice atom inside list");
              invariant((arr as SchemeValue[]).length === 1, "You can't splice multiple atoms inside list");
              if (!(is_pair(pair.cdr) && is_nil((arr as SchemeValue[])[0]))) {
                return (arr as SchemeValue[])[0];
              }
            }
            // don't create Cycles
            arr = arr.map((eval_pair) => {
              if (splices.has(eval_pair)) {
                return eval_pair.clone();
              } else {
                splices.add(eval_pair);
                return eval_pair;
              }
            });
            const value = recur(pair.cdr, 0, 1);
            if (is_nil(value) && is_nil(arr[0])) {
              return;
            }
            return unpromise(value, (value) => {
              if (is_nil(arr[0])) {
                return value;
              }
              if (arr.length === 1) {
                return join(arr[0], value);
              }
              const result = arr.reduce((result, eval_pair) => {
                return join(result, eval_pair);
              });
              return join(result, value);
            });
          });
        })(pair.car.cdr);
      }

      // -----------------------------------------------------------------
      var splices = new Set();

      function recur(pair, unquote_cnt, max_unq) {
        if (is_pair(pair)) {
          if (is_pair(pair.car)) {
            if (SchemeSymbol.is(pair.car.car, "unquote-splicing")) {
              return unquote_splice(pair, unquote_cnt + 1, max_unq);
            }
            if (SchemeSymbol.is(pair.car.car, "unquote")) {
              // + 2 - one for unquote and one for unquote splicing
              if (
                unquote_cnt + 2 === max_unq &&
                is_pair(pair.car.cdr) &&
                is_pair(pair.car.cdr.car) &&
                SchemeSymbol.is(pair.car.cdr.car.car, "unquote-splicing")
              ) {
                const rest = pair.car.cdr;
                return new Pair(
                  new Pair(new SchemeSymbol("unquote"), unquote_splice(rest, unquote_cnt + 2, max_unq)),
                  nil,
                );
              } else if (is_pair(pair.car.cdr) && !is_nil(pair.car.cdr.cdr)) {
                if (is_pair(pair.car.cdr.car)) {
                  // values inside unquote are lists
                  const result: SchemeValue[] = [];
                  return (function recur(node: SchemeValue): SchemeValue {
                    if (is_nil(node)) {
                      return Pair.fromArray(result);
                    }
                    return unpromise(
                      evaluate(node.car, {
                        env: self,
                        dynamic_env,
                        use_dynamic,
                        error,
                      }),
                      function (next) {
                        result.push(next);
                        return recur(node.cdr);
                      },
                    );
                  })(pair.car.cdr);
                } else {
                  // same as in guile if (unquote 1 2 3) it should be
                  // spliced - scheme spec say it's unspecify but it
                  // work like in CL
                  return pair.car.cdr;
                }
              }
            }
          }
          if (SchemeSymbol.is(pair.car, "quasiquote")) {
            const cdr = recur(pair.cdr, unquote_cnt, max_unq + 1);
            return new Pair(pair.car, cdr);
          }
          if (SchemeSymbol.is(pair.car, "quote")) {
            return new Pair(pair.car, recur(pair.cdr, unquote_cnt, max_unq));
          }
          if (SchemeSymbol.is(pair.car, "unquote")) {
            unquote_cnt++;
            if (unquote_cnt < max_unq) {
              return new Pair(new SchemeSymbol("unquote"), recur(pair.cdr, unquote_cnt, max_unq));
            }
            invariant(unquote_cnt <= max_unq, `You can't call \`unquote\` outside of quasiquote`);
            if (is_pair(pair.cdr)) {
              if (is_nil(pair.cdr.cdr)) {
                return evaluate(pair.cdr.car, {
                  env: self,
                  dynamic_env,
                  error,
                });
              } else {
                if (is_pair(pair.cdr.car)) {
                  // TODO: test if this part is needed
                  // this part was duplicated in previous section
                  // if (SchemeSymbol.is(pair.car.car, 'unquote')) {
                  // so this probably can be removed
                  const result: SchemeValue[] = [];
                  // evaluate all values in unquote
                  return (function recur(node: SchemeValue): SchemeValue {
                    if (is_nil(node)) {
                      return Pair.fromArray(result);
                    }
                    return unpromise(
                      evaluate(node.car, {
                        env: self,
                        dynamic_env,
                        use_dynamic,
                        error,
                      }),
                      function (next) {
                        result.push(next);
                        return recur(node.cdr);
                      },
                    );
                  })(pair.cdr);
                } else {
                  return pair.cdr;
                }
              }
            } else {
              return pair.cdr;
            }
          }
          return resolve_pair(pair, (pair) => {
            return recur(pair, unquote_cnt, max_unq);
          });
        } else if (is_plain_object(pair)) {
          return quote_object(pair, unquote_cnt, max_unq);
        } else if (Array.isArray(pair)) {
          return quote_vector(pair, unquote_cnt, max_unq);
        }
        return pair;
      }

      // -----------------------------------------------------------------
      function clear(node) {
        if (is_pair(node)) {
          delete node[__data__];
          if (!node.have_cycles("car")) {
            clear(node.car);
          }
          if (!node.have_cycles("cdr")) {
            clear(node.cdr);
          }
        }
      }

      // -----------------------------------------------------------------
      if (is_plain_object(arg.car) && !unquoted_arr(Object.values(arg.car))) {
        return quote(arg.car);
      }
      if (Array.isArray(arg.car) && !unquoted_arr(arg.car)) {
        return quote(arg.car);
      }
      if (
        is_pair(arg.car) &&
        !arg.car.find("unquote") &&
        !arg.car.find("unquote-splicing") &&
        !arg.car.find("quasiquote")
      ) {
        return quote(arg.car);
      }
      const x = recur(arg.car, 0, 1);
      return unpromise(x, (value) => {
        // clear nested data for tests
        clear(value);
        return quote(value);
      });
    }),
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
    vector: doc("vector", function (...args) {
      typecheck_args("vector", args, "number");
      return args;
    }),
    // ------------------------------------------------------------------
    "vector-append": doc("vector-append", function (...args) {
      if (args.length === 0) {
        return [];
      }
      typecheck_args("vector-append", args, "array");
      const [first, ...rest] = args;
      return first.concat(...rest);
    }),
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
// Default error handler: rethrow errors (except IgnoreException used for control flow)
const rethrowError = (error: Error, _code?: unknown) => {
  if (!(error instanceof IgnoreException)) {
    throw error;
  }
};


// -------------------------------------------------------------------------
// :: Argument evaluation - evaluates all arguments in parallel
// :: R7RS doesn't specify argument evaluation order, so parallel is valid
// -------------------------------------------------------------------------
function evaluate_args(rest: SchemeValue, { use_dynamic, ...options }: SchemeValue) {
  const expressions: SchemeValue[] = [];
  let node = rest;

  // First, collect all expressions
  while (is_pair(node)) {
    invariant(!node.have_cycles("cdr"), `Invalid expression: Can't evaluate cycle`);
    expressions.push(node.car);
    node = node.cdr;
  }

  invariant(is_nil(node), "Syntax Error: improper list found in apply");

  // Evaluate all expressions (parallel when async)
  const results = expressions.map((expr) => {
    let arg = evaluate(expr, { use_dynamic, ...options });
    if (use_dynamic) {
      arg = unpromise(arg, (arg) => {
        if (is_native_function(arg)) {
          return (arg as Function).bind(options.dynamic_env);
        }
        return arg;
      });
    }
    return resolve_promises(arg);
  });

  // Wait for all promises to resolve together
  const hasPromises = results.some(is_promise);
  if (hasPromises) {
    return promise_all(results);
  }
  return results;
}

// -------------------------------------------------------------------------
function evaluate_syntax(macro, code, eval_args) {
  const value = macro.invoke(code, eval_args);
  return unpromise(resolve_promises(value), function (value) {
    if (is_pair(value)) {
      value.mark_cycles();
    }
    return quote(value);
  });
}

// -------------------------------------------------------------------------
function evaluate_macro(macro, code, eval_args) {
  function finalize(result) {
    if (is_pair(result)) {
      result.mark_cycles();
      return result;
    }
    return quote(result);
  }

  const value = macro.invoke(code, eval_args);
  return unpromise(
    resolve_promises(value),
    function ret(value) {
      return !value || value?.[__data__] || self_evaluated(value)
        ? value
        : unpromise(evaluate(value, eval_args), finalize);
    },
    (error) => {
      throw error;
    },
  );
}

// -------------------------------------------------------------------------
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
// War story (audit error shape #42, FIXED): `(- (* 0 "") (- (- 0 0) 0))`
// used to surface as "Unbound variable `-`". Two layers of masking made
// the diagnostic point at the wrong place:
//   (1) The fuzz harness ran without `initBridge()` because its setup file
//       only imported lips.ts (not index.ts), so wrappedOps were never
//       installed in global_env and `(* …)` legitimately had no `*` binding.
//       The fuzz "passing" was a false-positive: every random program took
//       the unbound-variable branch and got whitelisted.
//   (2) When the bridge IS initialized, `fromLIPS("")` threw a TypeError
//       reading `Invariant failed: Cannot convert to SchemeNumeric: ` —
//       technically a type error but it named neither operator nor argument.
//
// Both addressed:
//   (a) `evaluator-provenance.fuzz.test.ts` now calls `initBridge()` once
//       in `beforeAll`, dropping the bogus "unbound variable" whitelist.
//   (b) `wrapOperator` (bridge.ts:241) catches fromLIPS failures and
//       rethrows `TypeError: Cannot apply <op> to (<types>): argument N is
//       <type>` with the original as `cause`. The membrane stack is still
//       reachable through `.cause` for sandbox/security debugging.
// Verified path (post-fix): apply → bridge wrapOperator try/catch →
// rethrown TypeError naming op + arg types.

// -------------------------------------------------------------------------
function apply(
  fn: SchemeFunction,
  args: SchemeValue,
  { env, dynamic_env, use_dynamic, error = rethrowError }: SchemeValue = {},
) {
  args = evaluate_args(args, { env, dynamic_env, error, use_dynamic });
  return unpromise(args, function (args) {
    if (is_raw_lambda(fn)) {
      // lambda need environment as context
      // normal functions are bound to their contexts
      fn = unbind(fn);
    }
    args = prepare_fn_args(fn, args as SchemeValue[]);
    const _args = [...(args as SchemeValue[])];
    const result = call_function(fn, _args, { env, dynamic_env, use_dynamic });
    return unpromise(
      result,
      (result) => {
        if (is_pair(result)) {
          result.mark_cycles();
          return quote(result);
        }
        return box(result);
      },
      error,
    );
  });
}

// -------------------------------------------------------------------------
function search_param(env, param) {
  let candidate = env.get(param.__name__, { throwError: false });
  if (is_parameter(candidate) && candidate !== param) {
    return candidate;
  }
  let is_first_env = true;
  const top_env = user_env.get("**interaction-environment**");
  while (true) {
    const parent = env.get("parent.frame", { throwError: false });
    env = parent(0);
    if (env === top_env) {
      break;
    }
    is_first_env = false;
    candidate = env.get(param.__name__, { throwError: false });
    if (is_parameter(candidate) && candidate !== param) {
      return candidate;
    }
  }
  return param;
}

// -------------------------------------------------------------------------
interface EvaluateOptions {
  env?: Environment | boolean;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  error?: (error: Error, code?: unknown) => void;
  [key: string]: unknown;
}

export function evaluate(
  code: unknown,
  { env, dynamic_env, use_dynamic, error = rethrowError, ...rest }: EvaluateOptions = {},
) {
  try {
    if (!is_env(dynamic_env)) {
      dynamic_env = env === true ? user_env : env || user_env;
    }
    if (use_dynamic) {
      env = dynamic_env;
    } else if (env === true) {
      env = user_env;
    } else {
      env = env || global_env;
    }
    const eval_args = { env, dynamic_env, use_dynamic, error };
    let value;
    if (is_null(code)) {
      return code;
    }
    if (code instanceof SchemeSymbol) {
      return env.get(code);
    }
    if (!is_pair(code)) {
      return code;
    }
    const first = code.car;
    const rest = code.cdr;
    if (is_pair(first)) {
      value = resolve_promises(evaluate(first, eval_args));
      if (is_promise(value)) {
        return value.then((value) => {
          invariant(
            is_callable(value),
            () =>
              `${type(value)} ${((env as Environment).get("repr") as SchemeFunction)(value)} is not callable while evaluating ${code.toString()}`,
          );
          return evaluate(new Pair(value, code.cdr), eval_args);
        });
        // else is later in code
      }
      invariant(
        is_callable(value),
        () =>
          `${type(value)} ${((env as Environment).get("repr") as SchemeFunction)(value)} is not callable while evaluating ${code.toString()}`,
      );
    }
    if (first instanceof SchemeSymbol) {
      value = env.get(first);
    } else if (is_function(first)) {
      value = first;
    }
    let result;
    if (value instanceof Syntax) {
      result = evaluate_syntax(value, code, eval_args);
    } else if (value instanceof Macro) {
      result = evaluate_macro(value, rest, eval_args);
    } else if (is_function(value)) {
      result = apply(value, rest, eval_args);
    } else if (value instanceof SyntaxParameter) {
      result = evaluate_syntax(value._syntax, code, eval_args);
    } else if (is_parameter(value)) {
      const param = search_param(dynamic_env, value);
      if (is_null(code.cdr)) {
        result = param.invoke();
      } else {
        return unpromise(evaluate((code.cdr as Pair).car, eval_args), function (value) {
          param.__value__ = value;
        });
      }
    } else if (is_continuation(value)) {
      result = value.invoke();
    } else {
      invariant(!is_pair(code), () => `${type(first)} ${first?.toString()} is not a function`);
      return code;
    }
    // escape promise feature #54
    const __promise__ = env.get(Symbol.for("__promise__"), {
      throwError: false,
    });
    if (__promise__ === true && is_promise(result)) {
      // fix #139 evaluate the code inside the promise that is not data.
      // When promise is not quoted it happen automatically, when returning
      // promise from evaluate.
      result = result.then((result) => {
        if (is_pair(result) && !value[__data__]) {
          return evaluate(result, eval_args);
        }
        return result;
      });
      return new QuotedPromise(result);
    }
    return result;
  } catch (error_) {
    error?.call(env, error_ as Error, code);
  }
}

// -------------------------------------------------------------------------
function exec_with_stacktrace(code: SchemeValue, { env, dynamic_env, use_dynamic }: SchemeValue = {}) {
  return evaluate(code, {
    env,
    dynamic_env,
    use_dynamic,
    error: (e, code) => {
      if (e?.message) {
        if (e.message.startsWith("Error:")) {
          const re = /^(Error:)\s*([^:]+:\s*)/;
          // clean duplicated Error: added by JS
          e.message = e.message.replace(re, "$1 $2");
        }
        if (code) {
          // LIPS stack trace
          const eAny = e as SchemeValue;
          if (!Array.isArray(eAny.__code__)) {
            eAny.__code__ = [];
          }
          eAny.__code__.push((code as SchemeValue).toString(true));
        }
      }
      if (!(e instanceof IgnoreException)) {
        throw e;
      }
    },
  });
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
  evaluate,
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
  evaluate,
  global_env,
});
