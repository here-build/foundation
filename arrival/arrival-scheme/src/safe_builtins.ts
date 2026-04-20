// Whitelist of safe built-in functions from LIPS global env
export const SAFE_BUILTINS = [
  // List construction & access
  "cons",
  "car",
  "cdr",
  "list",
  "append",
  "reverse",
  "nth",

  // List predicates
  "empty?",
  "list?",
  "pair?",
  "null?",

  // Higher-order list operations — LIPS native, overridden in sandbox for FL compat
  "map",
  "filter",
  "reduce",
  "for-each",
  "find",
  "apply",

  // Control flow
  "if",
  "let",
  "let*",
  "letrec",
  "lambda",
  "define",
  "begin",
  "and",
  "or",
  "not",
  "quote",
  "do",

  // Math
  "+",
  "-",
  "*",
  "/",
  "abs",
  "sqrt",
  "floor",
  "round",
  "ceiling",
  "truncate",
  "odd?",
  "even?",
  "gcd",
  "lcm",
  "%",
  "**",
  "1+",
  "1-",

  // Comparison
  "==",
  ">",
  "<",
  "<=",
  ">=",
  "eq?",

  // Type checks
  "number?",
  "string?",
  "boolean?",
  "symbol?",
  "function?",
  "array?",
  "object?",
  "null?",
  "regex?",
  "real?",

  // String operations
  "substring",
  "concat",
  "join",
  "split",
  "replace",
  "match",
  "search",
  "string->number",
  "number->string",

  // Exactness conversion
  "exact",
  "inexact",

  // Multiple values
  "let-values",

  // Utility
  "type",
  "clone",
  "values",
  "vector",
  "quasiquote",
  "unquote-splicing",
  "unquote",

  // All the car/cdr variants
  "cadr",
  "caar",
  "cddr",
  "cdar",
  "caddr",
  "caaar",
  "caadr",
  "cadar",
  "cdaar",
  "cdadr",
  "cddar",
  "cdddr",
  "caaaar",
  "caaadr",
  "caadar",
  "caaddr",
  "cadaar",
  "cadadr",
  "caddar",
  "cadddr",
];
