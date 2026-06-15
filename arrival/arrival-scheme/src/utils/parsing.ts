// Pure token→value parsers for the Scheme numeric tower (exact/inexact, rational, complex, radix
// prefixes), string literals, characters, and symbols. No I/O, no lexer state — given a token string,
// returns the boxed value. Numeric-grammar helpers originate from the LIPS reader.
import invariant from "tiny-invariant";
import { is_exact, is_inexact, is_int } from "../guards.js";
import { schemeFalse, schemeTrue } from "../values/SchemeBool.js";
import { SchemeString } from "../values/SchemeString.js";
import { SchemeSymbol } from "../values/SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "../values/numbers.js";
import {
  char_re,
  complex_bare_match_re,
  complex_list_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  parsable_contants,
  pre_num_parse_re,
  rational_bare_re,
  rational_re,
  re_re,
} from "../values/primitives.js";
import { parseBigInt } from "../serialize.js";
import { SchemeCharacter } from "../values/types.js";

// -------------------------------------------------------------------------
// :: ref: https://github.com/bestiejs/punycode.js/blob/master/punycode.js
// -------------------------------------------------------------------------
export function ucs2decode(string: string): number[] {
  const output: number[] = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd8_00 && value <= 0xdb_ff && counter < length) {
      // It's a high surrogate, and there is a next character.
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc_00) === 0xdc_00) {
        // Low surrogate.
        output.push(((value & 0x3_ff) << 10) + (extra & 0x3_ff) + 0x1_00_00);
      } else {
        // It's an unmatched surrogate; only append this code unit, in case the
        // next code unit is the high surrogate of a surrogate pair.
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

// -------------------------------------------------------------------------
export function num_pre_parse(arg: string): {
  radix?: number;
  inexact?: boolean;
  exact?: boolean;
  number?: string;
} {
  const parts = arg.match(pre_num_parse_re);
  const options: {
    radix?: number;
    inexact?: boolean;
    exact?: boolean;
    number?: string;
  } = {};
  if (parts![1]) {
    const type = parts![1].replaceAll("#", "").toLowerCase().split("");
    if (type.includes("x")) {
      options.radix = 16;
    } else if (type.includes("o")) {
      options.radix = 8;
    } else if (type.includes("b")) {
      options.radix = 2;
    } else if (type.includes("d")) {
      options.radix = 10;
    }
    if (type.includes("i")) {
      options.inexact = true;
    }
    if (type.includes("e")) {
      options.exact = true;
    }
  }
  options.number = parts![2];
  return options;
}

// ----------------------------------------------------------------------
export function parse_rational(arg: string, radix = 10): SchemeExact | SchemeInexact {
  const parse = num_pre_parse(arg);
  const parts = parse.number!.split("/");
  const r = parse.radix || radix;
  const num = parseBigInt(parts[0], r);
  const denom = parseBigInt(parts[1], r);
  if (parse.inexact) {
    return new SchemeInexact(Number(num) / Number(denom));
  }
  return new SchemeExact(num, denom);
}

// ----------------------------------------------------------------------
export function parse_integer(arg: string, radix = 10): SchemeExact | SchemeInexact {
  const parse = num_pre_parse(arg);
  const r = parse.radix || radix;
  if (parse.inexact) {
    return new SchemeInexact(Number.parseInt(parse.number!, r));
  }
  return new SchemeExact(parseBigInt(parse.number!, r));
}

// ----------------------------------------------------------------------
export function parse_character(arg: string): SchemeCharacter {
  let m = arg.match(/#\\x([0-9a-f]+)$/i);
  let char: string | undefined;
  if (m) {
    const ord = Number.parseInt(m[1], 16);
    char = String.fromCodePoint(ord);
  } else {
    m = arg.match(/#\\([\s\S]+)$/);
    if (m) {
      char = m[1];
    }
  }
  invariant(char !== undefined, `Parse: invalid character in ${arg}`);
  return new SchemeCharacter(char);
}

// ----------------------------------------------------------------------
export function parse_big_int(str: string): {
  exponent: number | undefined;
  mantisa: bigint | undefined;
} {
  const num_match = str.match(/^(([-+]?\d*)(?:\.(\d+))?)e([-+]?\d+)/i);
  let exponent: number | undefined;
  let mantisa: bigint | undefined;
  if (num_match) {
    exponent = Number.parseInt(num_match[4], 10);
    const digits = num_match[1].replace(/[-+]?(\d*)\..+$/, "$1").length;
    const decimal_points = num_match[3]?.length;
    if (digits < Math.abs(exponent)) {
      mantisa = parseBigInt(num_match[1].replace(/\./, ""), 10);
      if (decimal_points) {
        exponent -= decimal_points;
      }
    }
  }
  return { exponent, mantisa };
}

// ----------------------------------------------------------------------
export function string_to_float(str: string): number {
  return Number.parseFloat(str);
}

// ----------------------------------------------------------------------
export function parse_float(arg: string): SchemeExact | SchemeInexact {
  const parse = num_pre_parse(arg);
  const value = string_to_float(parse.number!);
  const simple_number = (parse.number!.match(/\.0$/) || !/\./.test(parse.number!)) && !/e/i.test(parse.number!);
  if (!parse.inexact) {
    if (parse.exact && simple_number) {
      return new SchemeExact(BigInt(Math.round(value)));
    }
    // positive big num that eval to int e.g.: 1.2e+20
    if (is_int(value) && Number.isSafeInteger(value) && /e\+?\d/i.test(parse.number!)) {
      return new SchemeExact(BigInt(Math.round(value)));
    }
    // calculate big int and big fraction by hand - it don't fit into JS float
    const { mantisa, exponent } = parse_big_int(parse.number!);
    if (mantisa !== undefined && exponent !== undefined) {
      const expAbs = Math.abs(exponent);
      const factorBigInt = 10n ** BigInt(expAbs);
      if (parse.exact && exponent < 0) {
        return new SchemeExact(mantisa, factorBigInt);
      } else if (exponent > 0 && (parse.exact || !/\./.test(parse.number!))) {
        return new SchemeExact(mantisa * factorBigInt);
      }
    }
  }
  // For inexact floats, check if exact was requested
  if (parse.exact) {
    // Convert float to rational approximation
    // Use a simple continued fraction approach for reasonable precision
    const floatVal = value;
    if (Number.isInteger(floatVal)) {
      return new SchemeExact(BigInt(Math.round(floatVal)));
    }
    // Convert decimal to fraction
    const str = floatVal.toString();
    const decimalIndex = str.indexOf(".");
    if (decimalIndex !== -1) {
      const decimals = str.length - decimalIndex - 1;
      const denom = 10n ** BigInt(decimals);
      const num = BigInt(str.replace(".", "").replace("-", ""));
      const sign = floatVal < 0 ? -1n : 1n;
      return new SchemeExact(sign * num, denom);
    }
    return new SchemeExact(BigInt(Math.round(floatVal)));
  }
  return new SchemeInexact(value);
}

// ----------------------------------------------------------------------
export function parse_complex(arg: string, radix = 10): SchemeExact | SchemeInexact {
  const parse = num_pre_parse(arg);
  radix = parse.radix || radix;

  function parse_num(n: string): SchemeExact | SchemeInexact {
    let value: SchemeExact | SchemeInexact;
    if (n === "+") {
      value = new SchemeExact(1n);
    } else if (n === "-") {
      value = new SchemeExact(-1n);
    } else if (n.match(int_bare_re)) {
      value = new SchemeExact(parseBigInt(n, radix));
    } else if (n.match(rational_bare_re)) {
      const parts = n.split("/");
      value = new SchemeExact(parseBigInt(parts[0], radix), parseBigInt(parts[1], radix));
    } else if (float_re.test(n)) {
      const float = parse_float(n);
      if (parse.exact && is_inexact(float)) {
        // Convert to exact rational
        const floatVal = float.real;
        if (Number.isInteger(floatVal)) {
          return new SchemeExact(BigInt(Math.round(floatVal)));
        }
        const str = floatVal.toString();
        const decimalIndex = str.indexOf(".");
        if (decimalIndex !== -1) {
          const decimals = str.length - decimalIndex - 1;
          const denom = 10n ** BigInt(decimals);
          const num = BigInt(str.replace(".", "").replace("-", ""));
          const sign = floatVal < 0 ? -1n : 1n;
          return new SchemeExact(sign * num, denom);
        }
        return new SchemeExact(BigInt(Math.round(floatVal)));
      }
      return float;
    } else if (/nan.0$/.test(n)) {
      return new SchemeInexact(Number.NaN);
    } else if (/inf.0$/.test(n)) {
      if (n[0] === "-") {
        return new SchemeInexact(Number.NEGATIVE_INFINITY);
      }
      return new SchemeInexact(Number.POSITIVE_INFINITY);
    } else {
      invariant(false, `Internal Parser Error at: ${n}`);
    }
    if (parse.inexact) {
      return new SchemeInexact(value.valueOf());
    }
    return value;
  }

  let parts;
  const bare_match = parse.number!.match(complex_bare_match_re);
  parts = radix !== 10 && bare_match ? bare_match : parse.number!.match(complex_list_re[radix]);
  let re: SchemeExact | SchemeInexact;
  let im: SchemeExact | SchemeInexact;
  im = parse_num(parts![2]);
  if (parts![1]) {
    re = parse_num(parts![1]);
  } else if (is_inexact(im)) {
    re = new SchemeInexact(0);
  } else {
    re = new SchemeExact(0n);
  }
  // If imaginary part is zero and exact, return just the real part
  const imVal = im.valueOf();
  if (imVal === 0 && is_exact(im)) {
    return re;
  }
  // Return complex number as InexactNumber with imaginary part
  return new SchemeInexact(re.valueOf(), im.valueOf());
}

// ----------------------------------------------------------------------
export function parse_string(string: string): SchemeString {
  // handle non JSON escapes and skip unicode escape \u (even partial)
  string = string
    .replaceAll(/\\x([0-9a-f]+);/gi, function (_, hex) {
      // Emit the real codepoint as JSON \uXXXX escape(s). For astral codepoints
      // (> U+FFFF) String.fromCodePoint yields a UTF-16 surrogate pair, which we
      // re-emit as two \uXXXX units so JSON.parse reconstructs the true char.
      const codepoint = Number.parseInt(hex, 16);
      const utf16 = String.fromCodePoint(codepoint);
      let out = "";
      for (let i = 0; i < utf16.length; i++) {
        out += String.raw`\u` + utf16.charCodeAt(i).toString(16).padStart(4, "0");
      }
      return out;
    })
    .replaceAll("\n", String.raw`\n`); // in LIPS strings can be multiline
  const m = string.match(/(\\*)(\\x[0-9A-F])/i);
  if (m && m[1].length % 2 === 0) {
    throw new Error(`Invalid string literal, unclosed: ${m[2]}`);
  }
  try {
    const str = new SchemeString(JSON.parse(string));
    str.freeze();
    return str;
  } catch (error) {
    invariant(
      false,
      `Invalid string literal: ${(error as Error).message.replace(/in JSON /, "").replace(/.*Error: /, "")}`,
    );
  }
}

// ----------------------------------------------------------------------
export const parse_symbol = (arg: string): SchemeSymbol =>
  new SchemeSymbol(
    /(?:^|.)\|/.test(arg)
      ? arg
          .split("|")
          .filter(Boolean)
          .reduce((acc, str) => {
            let result = "";
            if (/^\\+$/.test(str)) {
              if (str.length > 1) {
                const count = Math.floor(str.length / 2);
                result = "\\".repeat(count);
              }
              if (str.length % 2 !== 0) {
                result += "|";
              }
            } else {
              result = str;
            }
            return acc + result;
          })
          .replaceAll(/\\(x[^;]+);/g, (_, chr) => String.fromCharCode(Number.parseInt(`0${chr}`, 16)))
          .replaceAll(
            /\\([trn])/g,
            (_, chr) =>
              (
                ({
                  t: "\t",
                  r: "\r",
                  n: "\n",
                }) as Record<string, string>
              )[chr],
          )
      : arg,
  );

// ── Self-evaluating literal constants ──
// Hoisted to module scope so every `+inf.0` / `-inf.0` / `+nan.0` in source shares ONE instance.
// These MUST stay boxed SchemeInexact, not raw JS numbers: a bare primitive leaks an un-AValue past
// the parser and breaks every downstream consumer that assumes numerics are SchemeExact/SchemeInexact
// (`is_inexact`, the bridge's wrapOperator, the L2+ provenance algebra).
const nan = new SchemeInexact(Number.NaN);
const posInf = new SchemeInexact(Number.POSITIVE_INFINITY);
const negInf = new SchemeInexact(Number.NEGATIVE_INFINITY);

const constants: Record<string, unknown> = {
  "#t": schemeTrue,
  "#f": schemeFalse,
  "#true": schemeTrue,
  "#false": schemeFalse,
  "+inf.0": posInf,
  "-inf.0": negInf,
  "+nan.0": nan,
  "-nan.0": nan,
  ...parsable_contants,
};

// ── Token → value dispatch ──
// Constants first, then string, then the `#`-prefixed family (regex/char), then the numeric tower;
// anything that falls through is a symbol. Order matters — the cheap `Object.hasOwn` and prefix tests
// gate the expensive numeric regexes.
export function parse_argument(arg: string): unknown {
  if (Object.hasOwn(constants, arg)) {
    return constants[arg];
  }
  if (/^"[\s\S]*"$/.test(arg)) {
    return parse_string(arg);
  } else if (arg[0] === "#") {
    const regex = arg.match(re_re);
    if (regex) {
      return new RegExp(regex[1], regex[2]);
    } else if (char_re.test(arg)) {
      return parse_character(arg);
    }
    // characters with more than one codepoint
    const m = arg.match(/#\\(.+)/);
    if (m && ucs2decode(m[1]).length === 1) {
      return parse_character(arg);
    }
  }
  if (/[0-9a-f]|[+-]i/i.test(arg)) {
    if (arg.match(int_re)) {
      return parse_integer(arg);
    } else if (float_re.test(arg)) {
      return parse_float(arg);
    } else if (arg.match(rational_re)) {
      return parse_rational(arg);
    } else if (arg.match(complex_re)) {
      return parse_complex(arg);
    }
  }
  invariant(!/^#[iexobd]/.test(arg), `Invalid numeric constant: ${arg}`);
  return parse_symbol(arg);
}
