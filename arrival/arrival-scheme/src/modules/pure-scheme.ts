/**
 * Pure Scheme Module
 *
 * Provides a minimal, sandboxed Scheme environment with:
 * - Core primitives (car, cdr, cons, list)
 * - Arithmetic operations
 * - Predicates and comparisons
 * - List operations (map, filter, fold)
 * - Core special forms (if, lambda, define, let, cond)
 *
 * No I/O, no JavaScript interop, no side effects beyond local mutation.
 */

import type { EnvironmentModule, FallbackResolver } from "../bindings.js";
import { BOOTSTRAP_SCHEME } from "../bootstrap.js";
import { nil, type SchemeValue } from "../types.js";

/**
 * List of pure Scheme binding names.
 * These are the core R7RS-like bindings without any I/O or JS interop.
 */
export const PURE_SCHEME_BINDINGS = [
  // Core constants
  "nil",

  // Core primitives
  "cons",
  "car",
  "cdr",
  "list",
  "length",
  "append",
  "reverse",
  "list-ref",
  "list-tail",
  "list-copy",
  "make-list",
  "caar",
  "cadr",
  "cdar",
  "cddr",
  "caaar",
  "caadr",
  "cadar",
  "caddr",
  "cdaar",
  "cdadr",
  "cddar",
  "cdddr",

  // Predicates
  "pair?",
  "null?",
  "list?",
  "boolean?",
  "symbol?",
  "number?",
  "string?",
  "char?",
  "vector?",
  "procedure?",
  "eq?",
  "eqv?",
  "equal?",
  "zero?",
  "positive?",
  "negative?",
  "odd?",
  "even?",
  "exact?",
  "inexact?",
  "integer?",
  "real?",
  "rational?",
  "complex?",

  // Arithmetic
  "+",
  "-",
  "*",
  "/",
  "modulo",
  "remainder",
  "quotient",
  "abs",
  "floor",
  "ceiling",
  "truncate",
  "round",
  "min",
  "max",
  "gcd",
  "lcm",
  "expt",
  "sqrt",
  "exp",
  "log",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "exact->inexact",
  "inexact->exact",
  "number->string",
  "string->number",

  // Comparisons
  "=",
  "<",
  ">",
  "<=",
  ">=",

  // Logic
  "not",
  "and",
  "or",

  // Higher-order
  "map",
  "for-each",
  "filter",
  "apply",
  "fold-left",
  "fold-right",
  "memq",
  "memv",
  "member",
  "assq",
  "assv",
  "assoc",

  // Vector operations
  "vector",
  "make-vector",
  "vector-length",
  "vector-ref",
  "vector-set!",
  "vector->list",
  "list->vector",
  "vector-map",
  "vector-for-each",
  "vector-copy",
  "vector-copy!",
  "vector-fill!",

  // String operations (pure, no I/O)
  "string",
  "make-string",
  "string-length",
  "string-ref",
  "string-set!",
  "string-append",
  "substring",
  "string->list",
  "list->string",
  "string=?",
  "string<?",
  "string>?",
  "string<=?",
  "string>=?",
  "string-ci=?",
  "string-ci<?",
  "string-ci>?",
  "string-ci<=?",
  "string-ci>=?",
  "string-upcase",
  "string-downcase",
  "string-foldcase",
  "string-map",
  "string-for-each",

  // Character operations
  "char->integer",
  "integer->char",
  "char=?",
  "char<?",
  "char>?",
  "char<=?",
  "char>=?",
  "char-ci=?",
  "char-ci<?",
  "char-ci>?",
  "char-ci<=?",
  "char-ci>=?",
  "char-alphabetic?",
  "char-numeric?",
  "char-whitespace?",
  "char-upper-case?",
  "char-lower-case?",
  "char-upcase",
  "char-downcase",
  "char-foldcase",

  // Symbol operations
  "symbol->string",
  "string->symbol",
  "symbol=?",

  // Control flow / special forms (these are macros/syntax)
  "if",
  "cond",
  "case",
  "and",
  "or",
  "when",
  "unless",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "let-values",
  "let*-values",
  "begin",
  "do",
  "lambda",
  "define",
  "set!",
  "quote",
  "quasiquote",
  "unquote",
  "unquote-splicing",
  "define-values",

  // Delayed evaluation
  "delay",
  "force",
  "delay-force",
  "make-promise",
  "promise?",

  // Multiple values
  "values",
  "call-with-values",

  // Exceptions (pure part - no I/O)
  "error",
  "raise",
  "raise-continuable",
  "with-exception-handler",
  "guard",

  // Continuations
  "call-with-current-continuation",
  "call/cc",
  "dynamic-wind",

  // Eval (meta)
  "eval",

  // Type conversion
  "list->array",
  "array->list",
] as const;

/**
 * Create a resolver that pulls pure Scheme bindings from a source environment.
 * This is used to create a sandbox from an existing fully-loaded environment.
 */
export function createPureSchemeResolver(sourceEnv: {
  get(name: string, opts?: { throwError?: boolean }): SchemeValue | undefined;
}): FallbackResolver {
  return {
    id: "pure-scheme",
    resolve(name: string): SchemeValue | undefined {
      if (PURE_SCHEME_BINDINGS.includes(name as (typeof PURE_SCHEME_BINDINGS)[number])) {
        return sourceEnv.get(name, { throwError: false });
      }
      return undefined;
    },
  };
}

/**
 * Create a pure Scheme module that pulls bindings from a source environment.
 *
 * @example
 * ```typescript
 * import { global_env } from "./lips.js";
 * const pureModule = createPureSchemeModule(global_env);
 * const sandbox = Environment.fromModules([pureModule]);
 * ```
 */
export function createPureSchemeModule(sourceEnv: {
  get(name: string, opts?: { throwError?: boolean }): unknown;
}): EnvironmentModule {
  // Pre-populate bindings from source environment
  const bindings: Record<string, SchemeValue> = {
    // nil is a constant, not in global_env
    nil,
  };

  for (const name of PURE_SCHEME_BINDINGS) {
    if (name === "nil") continue; // Already added above
    const value = sourceEnv.get(name, { throwError: false });
    if (value !== undefined) {
      bindings[name] = value as SchemeValue;
    }
  }

  return {
    id: "pure-scheme",
    bindings,
    bootstrap: BOOTSTRAP_SCHEME,
  };
}

/**
 * Names that should NOT be available in a pure sandbox.
 * Used for validation/security auditing.
 */
export const FORBIDDEN_IN_SANDBOX = [
  // I/O
  "read",
  "write",
  "display",
  "newline",
  "print",
  "read-char",
  "write-char",
  "peek-char",
  "read-line",
  "read-string",
  "open-input-file",
  "open-output-file",
  "close-input-port",
  "close-output-port",
  "current-input-port",
  "current-output-port",
  "current-error-port",
  "call-with-input-file",
  "call-with-output-file",
  "with-input-from-file",
  "with-output-to-file",
  "load",
  "include",
  "include-ci",

  // System
  "exit",
  "emergency-exit",
  "command-line",
  "get-environment-variable",
  "get-environment-variables",

  // JavaScript interop
  "-->",
  "..",
  "new",
  "instanceof",
  "typeof",
  "set-obj!",
  "get-obj",

  // LIPS-specific I/O
  "timer",
  "promisify",
  "fetch",
] as const;
