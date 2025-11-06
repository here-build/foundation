// Whitelist of safe built-in functions
export const SAFE_BUILTINS = [
  // List operations (keep LIPS-specific ones)
  "cons",
  "list",
  // Note: nil is not a function but the Nil constructor - handled separately
  "empty?",
  "list?",
  "pair?",

  // Remove these - handled by Ramda with FL compatibility:
  // "car", "cdr"

  // Core list operations - LIPS native with FL enhancement
  "map",
  "filter",
  "reduce",

  // Remove these - handled by Ramda+FL:
  // "append", "reverse", "nth", "length", "flatten"
  // "fold", "for-each", "apply", "compose", "pipe", "curry", "find", "pluck"

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

  // Utility
  "type",
  "clone",
  "values",
  "quote",
  "quasiquote",
  "unquote-splicing",
  "unquote",

  // All the cdr/car variants
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
  "cadddr"
];
