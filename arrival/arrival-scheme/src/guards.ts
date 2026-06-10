// ----------------------------------------------------------------------
import { Continuation } from "./Continuation.js";
import { Environment } from "./Environment.js";
import { LambdaContext } from "./LambdaContext.js";
import { SchemeBool } from "./LBool.js";
import { Macro } from "./Macro.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Parameter } from "./Parameter.js";
import { Syntax } from "./Syntax.js";
import {
  __lambda__,
  __method__,
  __prototype__,
  char_re,
  complex_re,
  directives,
  float_re,
  int_re,
  rational_re,
  re_re,
} from "./primitives.js";
import { QuotedPromise } from "./QuotedPromise.js";
import * as specials from "./specials.js";
import { nil } from "./types.js";
// Leaf value-kernel predicates live in value-guards.ts (no Environment/Macro
// dep) so Pair.ts can import them without dragging the evaluator world in.
// Re-exported here so every existing `from "./guards.js"` call site is unchanged.
import { is_native, is_nil, is_pair, is_plain_object } from "./value-guards.js";
export { is_native, is_nil, is_pair, is_plain_object };

// Import directly from source files to avoid circular dependency with lips.ts

export function is_int(value: unknown): value is number {
  return typeof value === "number" && Number.parseInt(value.toString(), 10) === value;
}

// ----------------------------------------------------------------------
function is_atom_string(str: string): boolean {
  return !(["(", ")", "[", "]"].includes(str) || specials.names().includes(str));
}

// ----------------------------------------------------------------------
export function is_symbol_string(str: unknown): str is string {
  if (typeof str !== "string") return false;
  return (
    is_atom_string(str) &&
    !(
      re_re.test(str) ||
      /^"[\s\S]*"$/.test(str) ||
      str.match(int_re) ||
      float_re.test(str) ||
      str.match(complex_re) ||
      str.match(rational_re) ||
      char_re.test(str) ||
      ["#t", "#f", "nil"].includes(str)
    )
  );
}

export function is_special(token: unknown): boolean {
  return typeof token === "string" && specials.names().includes(token);
}

export function is_vector_literal(token: unknown): token is "#(" {
  return token === "#(";
}

export function is_bytevector_literal(token: unknown): token is "#u8(" {
  return token === "#u8(";
}

export function is_builtin(token: unknown): boolean {
  return typeof token === "string" && specials.__builtins__.includes(token);
}

export function is_literal(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.LITERAL;
}

export function is_symbol_extension(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.SYMBOL;
}
// ----------------------------------------------------------------------
// :: Check for nullish values
// ----------------------------------------------------------------------
export function is_null(value: unknown): value is null | undefined | typeof nil {
  return is_undef(value) || is_nil(value) || value === null;
}

// ----------------------------------------------------------------------
export function is_function(o: unknown): o is Function {
  return typeof o === "function" && "bind" in o && typeof o.bind === "function";
}

// ----------------------------------------------------------------------------
export function is_directive(token: unknown): boolean {
  return typeof token === "string" && directives.includes(token);
}

// ----------------------------------------------------------------------------
export function is_false(o: unknown): o is false | null | SchemeBool {
  switch (true) {
    case o === false:
    case o === null:
      return true;
    case o instanceof SchemeBool:
      return (o as SchemeBool).value === false;
    default:
      return false;
  }
}

// ----------------------------------------------------------------------------
export function is_string(o: unknown): o is string {
  return typeof o === "string";
}

// ----------------------------------------------------------------------------
export function is_prototype(obj: unknown): boolean {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "constructor" in obj &&
    typeof obj.constructor === "function" &&
    obj.constructor.prototype === obj
  );
}

// ----------------------------------------------------------------------
export function is_context(o: unknown): o is LambdaContext {
  return o instanceof LambdaContext;
}

// ----------------------------------------------------------------------
export function is_parameter(o: unknown): o is Parameter {
  return o instanceof Parameter;
}

// ----------------------------------------------------------------------
export function is_env(o: unknown): o is Environment {
  return o instanceof Environment;
}

// ----------------------------------------------------------------------
export function is_macro(o: unknown): o is Macro {
  return o instanceof Macro || o instanceof Syntax.Parameter;
}

// ----------------------------------------------------------------------
export function is_syntax(o: unknown): o is Syntax {
  return o instanceof Syntax;
}

// ----------------------------------------------------------------------
export function is_promise(o: unknown): o is Promise<unknown> {
  if (o instanceof QuotedPromise) {
    return false;
  }
  if (o instanceof Promise) {
    return true;
  }
  return !!o && typeof o === "object" && "then" in o && is_function(o.then);
}

export function is_undef(value: unknown): value is undefined {
  return value === undefined;
}

// ----------------------------------------------------------------------
export function is_continuation(o: unknown): o is Continuation {
  return o instanceof Continuation;
}

// ----------------------------------------------------------------------
export function is_callable(o: unknown): boolean {
  return is_function(o) || is_continuation(o) || is_parameter(o) || is_macro(o) || is_js_function_wrapper(o);
}

// Check for SchemeJSFunction without importing (avoids circular dep)
function is_js_function_wrapper(o: unknown): boolean {
  return (
    o !== null &&
    typeof o === "object" &&
    "source" in o &&
    typeof (o as { source: unknown }).source === "function" &&
    (o as { constructor?: { __class__?: string } }).constructor?.__class__ === "js-function"
  );
}

// -------------------------------------------------------------------------
export function is_instance(obj: unknown): boolean {
  if (!obj) {
    return false;
  }
  if (typeof obj !== "object") {
    return false;
  }
  // __instance__ is read only for instances
  const o = obj as { __instance__?: boolean };
  if (o.__instance__) {
    o.__instance__ = false;
    return o.__instance__;
  }
  return false;
}

// ----------------------------------------------------------------------
export function is_number(o: unknown): o is SchemeExact | SchemeInexact {
  return o instanceof SchemeExact || o instanceof SchemeInexact;
}

// ----------------------------------------------------------------------
export function is_exact(o: unknown): o is SchemeExact {
  return o instanceof SchemeExact;
}

// ----------------------------------------------------------------------
export function is_inexact(o: unknown): o is SchemeInexact {
  return o instanceof SchemeInexact;
}

// ----------------------------------------------------------------------
export function is_lambda(obj: unknown): boolean {
  return obj != null && typeof obj === "object" && __lambda__ in obj && !!(obj as Record<symbol, unknown>)[__lambda__];
}

// ----------------------------------------------------------------------
function is_method(obj: unknown): boolean {
  return obj != null && typeof obj === "object" && __method__ in obj && !!(obj as Record<symbol, unknown>)[__method__];
}

// ----------------------------------------------------------------------
export function is_raw_lambda(fn: unknown): boolean {
  return is_lambda(fn) && !(fn as Record<symbol, unknown>)[__prototype__] && !is_method(fn);
}

export function is_native_function(fn: unknown): boolean {
  const native = Symbol.for("__native__");
  if (!is_function(fn)) return false;
  const f = fn as Function & { name: string; [key: symbol]: unknown };
  return (
    f.toString().match(/\{\s*\[native code\]\s*\}/) !== null &&
    ((f.name.match(/^bound /) && f[native] === true) || (!f.name.startsWith("bound ") && !f[native]))
  );
}

// -------------------------------------------------------------------------
export const has_own_symbol = (obj: unknown, symbol: symbol): boolean =>
  obj !== null && typeof obj === "object" ? Object.hasOwn(obj, symbol) : false;

// -------------------------------------------------------------------------
export function is_iterator(obj: unknown, symbol: symbol): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (has_own_symbol(obj, symbol) || has_own_symbol(Object.getPrototypeOf(obj), symbol)) {
    return is_function((obj as Record<symbol, unknown>)[symbol]);
  }
  return false;
}
