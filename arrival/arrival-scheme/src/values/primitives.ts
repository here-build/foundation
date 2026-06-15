import { characters } from "./types.js";

export const p_o = /^[[(]$/;
export const p_e = /^[\])]$/;
export const not_p = /[^()[\]]/;
export const non_def = /^(?!.*\b(?:[()[\]]|define(?:-macro)?|let(?:\*|rec|-env|-syntax)?|lambda|syntax-rules)\b).*$/;
export const let_re = /^(?:#:)?(let(?:\*|rec|-env|-syntax)?)$/; // ----------------------------------------------------------------------
export const string_re = /"(?:\\[\s\S]|[^"])*"?/g;
export const pre_num_parse_re = /((?:#[xodbie]){0,2})(.*)/i; // TODO: float complex
// functions generate regexes to match number rational, integer, complex, complex+rational
function num_mnemicic_re(mnemonic) {
  return mnemonic ? `(?:#${mnemonic}(?:#[ie])?|#[ie]#${mnemonic})` : "(?:#[ie])?";
}

export function gen_rational_re(mnemonic, range) {
  return `${num_mnemicic_re(mnemonic)}[+-]?${range}+/${range}+`;
}

export function gen_complex_re(mnemonic, range) {
  // [+-]i have (?=..) so it don't match +i from +inf.0
  return `${num_mnemicic_re(mnemonic)}(?:[+-]?(?:${range}+/${range}+|nan.0|inf.0|${range}+))?(?:[+-]i|[+-]?(?:${range}+/${range}+|${range}+|nan.0|inf.0)i)(?=[()[\\]\\s]|$)`;
}

export function gen_integer_re(mnemonic, range) {
  return `${num_mnemicic_re(mnemonic)}[+-]?${range}+`;
}

export function make_complex_match_re(mnemonic, range) {
  // complex need special treatment of 10e+1i when it's hex or decimal
  const neg = mnemonic === "x" ? `(?!\\+|${range})` : `(?!\\.|${range})`;
  let fl = "";
  if (mnemonic === "") {
    fl = String.raw`(?:[-+]?(?:[0-9]+(?:[eE][-+]?[0-9]+)|(?:\.[0-9]+|[0-9]+\.[0-9]+(?![0-9]))(?:[eE][-+]?[0-9]+)?))`;
  }
  return new RegExp(
    `^((?:(?:${fl}|[-+]?inf.0|[-+]?nan.0|[+-]?${range}+/${range}+(?!${range})|[+-]?${range}+)${neg})?)(${fl}|[-+]?inf.0|[-+]?nan.0|[+-]?${range}+/${range}+|[+-]?${range}+|[+-])i$`,
    "i",
  );
} // TODO: extend to ([+-]1/2|float)([+-]1/2|float)
export const re_re = /^#\/((?:\\\/|[^/]|\[[^/\]]*\/[^\]]*\])+)\/([gimyus]*)$/;
const float_stre = String.raw`(?:[-+]?(?:[0-9]+(?:[eE][-+]?[0-9]+)|(?:\.[0-9]+|[0-9]+\.[0-9]+)(?:[eE][-+]?[0-9]+)?)|[0-9]+\.)`;
export const complex_float_stre = `(?:#[ie])?(?:[+-]?(?:[0-9][0-9_]*/[0-9][0-9_]*|nan.0|inf.0|${float_stre}|[+-]?[0-9]+))?(?:${float_stre}|[+-](?:[0-9]+/[0-9]+|[0-9]+|nan.0|inf.0)?)i`;
export const float_re = new RegExp(`^(#[ie])?${float_stre}$`, "i");
export const complex_list_re = (function () {
  const result = {};
  for (const [radix, mnemonic, range] of [
    [10, "", "[0-9]"],
    [16, "x", "[0-9a-fA-F]"],
    [8, "o", "[0-7]"],
    [2, "b", "[01]"],
  ]) {
    result[radix] = make_complex_match_re(mnemonic, range);
  }
  return result;
})();
export const glob = Symbol.for("*");
// match keyword if it's normal token or gensym (prefixed with #:)
export function keywords_re(...args) {
  return new RegExp(`^(?:#:)?(?:${args.join("|")})$`);
} // rules for breaking S-Expressions into lines
export const syntax_rules = keywords_re("syntax-rules");
export const def_lambda_re = keywords_re("define", "lambda", "define-macro", "syntax-rules");
// -------------------------------------------------------------------------
const character_symbols = Object.keys(characters).join("|");
const char_sre_re = `#\\\\(?:x[0-9a-f]+|${character_symbols}|[\\s\\S])`;
export const char_re = new RegExp(`^${char_sre_re}$`, "i"); // regexes with full range but without mnemonics for string->number
// Complex with (int) (float) (rational)
function make_num_stre(fn) {
  const ranges = [
    ["o", "[0-7]"],
    ["x", "[0-9a-fA-F]"],
    ["b", "[01]"],
    ["d", "[0-9]"],
    ["", "[0-9]"],
  ];
  // float exception that don't accept mnemonics
  let result = ranges.map(([m, range]) => fn(m, range)).join("|");
  if (fn === gen_complex_re) {
    result = `${complex_float_stre}|${result}`;
  }
  return result;
}

function make_type_re(fn) {
  return new RegExp(`^(?:${make_num_stre(fn)})$`, "i");
}

export const complex_re = make_type_re(gen_complex_re);
export const rational_re = make_type_re(gen_rational_re);
export const int_re = make_type_re(gen_integer_re);
export const int_bare_re = new RegExp(`^(?:${gen_integer_re("", "[0-9a-f]")})$`, "i");
export const rational_bare_re = new RegExp(`^(?:${gen_rational_re("", "[0-9a-f]")})$`, "i");
export const complex_bare_re = new RegExp(`^(?:${gen_complex_re("", "[0-9a-f]")})$`, "i");
export const complex_bare_match_re = make_complex_match_re("", "[0-9a-fA-F]");
// those constants need to be add as rules to the Lexer to work with vector literals
export const parsable_contants = {
  "#null": null,
  "#void": undefined,
};
export const directives = ["#!fold-case", "#!no-fold-case"];
export const hash_literals = ["#t", "#f"];
export const type_constants = new Map([
  [Number.NaN, "NaN"],
  [null, "null"],
]);
// ----------------------------------------------------------------------
// Hidden props
// ----------------------------------------------------------------------
export const __context__ = Symbol.for("__context__");
export const __fn__ = Symbol.for("__fn__");
export const __data__ = Symbol.for("__data__");
export const __ref__ = Symbol.for("__ref__");
export const __cycles__ = Symbol.for("__cycles__");
export const __method__ = Symbol.for("__method__");
export const __prototype__ = Symbol.for("__prototype__");
export const __lambda__ = Symbol.for("__lambda__");
export const __location__ = Symbol.for("__location__");
