// ----------------------------------------------------------------------
// return last S-Expression
// @param tokens - array of tokens (objects from tokenizer or strings)
// @param sexp - number of expression to look behind
// ----------------------------------------------------------------------
import { is_special, is_symbol_string } from "./guards.js";
import { tokenize } from "./stdlib.js";
import { SchemeString } from "./SchemeString.js";
import {
  def_lambda_re,
  glob,
  keywords_re,
  let_re,
  non_def,
  not_p,
  p_e,
  p_o,
  re_re,
  string_re,
  syntax_rules,
} from "./primitives.js";
import { balanced } from "./utils/balanced.js";
import invariant from "tiny-invariant";

// ----------------------------------------------------------------------
// :: Type definitions for Formatter
// ----------------------------------------------------------------------
export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

export interface FormatterExceptions {
  specials: (string | RegExp)[];
  shift: Record<number, (string | RegExp)[]>;
}

export interface FormatterOptions {
  offset?: number;
  indent?: number;
  exceptions?: Partial<FormatterExceptions>;
}

type PatternFlag = "+" | "*" | "?";
type PatternElement = RegExp | string | symbol | PatternElement[];
type PatternType = PatternElement | InstanceType<typeof Formatter.Pattern>;

function previousSexp<T extends string | TokenMeta>(tokens: T[], sexp = 1): T[] {
  let i = tokens.length;
  invariant(sexp > 0, `previousSexp: Invalid argument sexp = ${sexp}`);
  outer: while (sexp-- && i >= 0) {
    let count = 1;
    while (count > 0) {
      const token = tokens[--i];
      if (!token) {
        break outer;
      }
      const t = typeof token === "string" ? token : token.token;
      if (t === "(") {
        count--;
      } else if (t === ")") {
        count++;
      }
    }
    i--;
  }
  return tokens.slice(i + 1);
}

// ----------------------------------------------------------------------
// :: Find the number of spaces in line
// ----------------------------------------------------------------------
function lineIndent(tokens: TokenMeta[]): number {
  if (!tokens?.length) {
    return 0;
  }
  let i = tokens.length;
  if (tokens[i - 1].token === "\n") {
    return 0;
  }
  while (--i) {
    if (tokens[i].token === "\n") {
      const token = tokens[i + 1]?.token;
      if (token) {
        return token.length;
      }
    }
  }
  return 0;
}

// ----------------------------------------------------------------------
// :: Code formatter class
// :: based on http://community.schemewiki.org/?scheme-style
// :: and GNU Emacs scheme mode
// :: it rely on meta data from tokenizer function
// ----------------------------------------------------------------------
export class Formatter {
  static __class__ = "formatter";

  static readonly defaults = {
    offset: 0,
    indent: 2,
    exceptions: {
      specials: [
        /^(?:#:)?(?:define(?:-values|-syntax|-macro|-class|-record-type)?|lambda|let-env|try|catch|when|unless|while|syntax-rules|(let|letrec)(-syntax|\*?-values|\*)?)$/,
      ],
      shift: {
        1: ["&", "#"],
      },
    },
  };

  // ----------------------------------------------------------------------
  // :: Token based pattern matching (used by formatter)
  // ----------------------------------------------------------------------
  /*
    Function nested_pattern(pattern) {
    return pattern instanceof Array ||
    pattern instanceof Pattern;
    }
  */
  static Pattern = class Pattern {
    static __class__ = "pattern";

    patterns: PatternElement[];
    flag: PatternFlag;

    constructor(...args: [...PatternElement[], PatternFlag]) {
      const flag = args.pop() as PatternFlag;
      this.patterns = args as PatternElement[];
      this.flag = flag;
    }

    toString(): string {
      const patterns = this.patterns.map((x) => String(x)).join("|");
      return `#<pattern(${patterns} ${this.flag})>`;
    }
  };

  // ----------------------------------------------------------------------
  // Pattern has any number of patterns that it matches using OR operator
  // Pattern is in form of array with regular expressions
  // ----------------------------------------------------------------------
  static sexp = new Formatter.Pattern([p_o, glob, p_e], "+");
  static Ahead = class Ahead {
    static __class__ = "ahead";

    constructor(
      public readonly pattern: {
        [Symbol.match](string: string): RegExpMatchArray | null;
      },
    ) {}

    match(string: string): RegExpMatchArray | null {
      return string.match(this.pattern);
    }

    // TODO: make it print
    toString(): string {
      return `#<pattern(${this.pattern})>`;
    }
  };
  static not_close = new Formatter.Ahead(/[^)\]]/);
  static sexp_or_atom = new Formatter.Pattern([p_o, glob, p_e], [not_p], "+");
  static symbol = new Formatter.Pattern([Symbol.for("symbol")], "?");
  static symbols = new Formatter.Pattern([Symbol.for("symbol")], "*");
  static let_value = new Formatter.Pattern([p_o, Symbol.for("symbol"), glob, p_e], "+");
  static identifiers = [p_o, Formatter.symbols, p_e];
  // line breaking rules
  static rules = [
    [[Formatter.sexp], 0, Formatter.not_close],
    [[p_o, keywords_re("begin", "cond-expand")], 1, Formatter.not_close],
    [[p_o, let_re, Formatter.symbol, p_o, Formatter.let_value, p_e], 1, Formatter.not_close],
    [[p_o, let_re, Formatter.symbol, Formatter.sexp_or_atom], 1, Formatter.not_close],
    [[p_o, let_re, p_o, Formatter.let_value], 1, Formatter.not_close],
    [[p_o, keywords_re("define-syntax"), /.+/], 1],
    [[p_o, syntax_rules, not_p, Formatter.identifiers], 1],
    [[p_o, syntax_rules, not_p, Formatter.identifiers, Formatter.sexp], 1, Formatter.not_close],
    [[p_o, syntax_rules, Formatter.identifiers], 1],
    [[p_o, syntax_rules, Formatter.identifiers, Formatter.sexp], 1, Formatter.not_close],
    [[p_o, non_def, new Formatter.Pattern([/[^()[\]]/], "+"), Formatter.sexp], 1, Formatter.not_close],
    [[p_o, Formatter.sexp], 1, Formatter.not_close],
    [[p_o, not_p, Formatter.sexp], 1, Formatter.not_close],
    [[p_o, keywords_re("lambda", "if"), not_p], 1, Formatter.not_close],
    [[p_o, keywords_re("while"), not_p, Formatter.sexp], 1, Formatter.not_close],
    [[p_o, keywords_re("if"), not_p, glob], 1, Formatter.not_close],
    [[p_o, def_lambda_re, Formatter.identifiers], 0, Formatter.not_close],
    [[p_o, def_lambda_re, Formatter.identifiers, string_re], 0, Formatter.not_close],
    [[p_o, def_lambda_re, Formatter.identifiers, string_re, Formatter.sexp], 0, Formatter.not_close],
    [[p_o, def_lambda_re, Formatter.identifiers, Formatter.sexp], 0, Formatter.not_close],
  ];
  __code__: string;

  constructor(code: string) {
    this.__code__ = code.replaceAll("\r", "");
  }

  // ----------------------------------------------------------------------
  static match(pattern, input) {
    return inner_match(pattern, input) === input.length;

    function inner_match(pattern, input) {
      /*
            function empty_match() {
            if (p <= 0 && i <= 0) {
            return false;
            }
            var prev_pattern = pattern[p - 1];
            if (!nested_pattern(prev_pattern)) {
            prev_pattern = [prev_pattern];
            }
            var next_pattern = pattern[p + 1];
            if (next_pattern && !nested_pattern(next_pattern)) {
            next_pattern = [next_pattern];
            }
            return match(prev_pattern, [input[i - 1]]) &&
            (!next_pattern || match(next_pattern, [input[i]]));
            }
          */
      function get_first_match(patterns, input) {
        for (const p of patterns) {
          const m = inner_match(p, input);
          if (m !== -1) {
            return m;
          }
        }
        return -1;
      }

      function not_symbol_match() {
        return pattern[p] === Symbol.for("symbol") && !is_symbol_string(input[i]);
      }

      function match_next() {
        const next_pattern = pattern[p + 1];
        const next_input = input[i + 1];
        if (next_pattern !== undefined && next_input !== undefined) {
          return inner_match([next_pattern], [next_input]);
        }
      }

      var p = 0;
      const glob = {};
      for (var i = 0; i < input.length; ++i) {
        if (pattern[p] === undefined) {
          return i;
        }
        if (pattern[p] instanceof Formatter.Pattern) {
          var m;
          if (["+", "*"].includes(pattern[p].flag)) {
            while (i < input.length) {
              m = get_first_match(pattern[p].patterns, input.slice(i));
              if (m === -1) {
                break;
              }
              i += m;
            }
            i -= 1;
            p++;
            continue;
          } else if (pattern[p].flag === "?") {
            m = get_first_match(pattern[p].patterns, input.slice(i));
            if (m === -1) {
              i -= 2; // if not found use same test on same input again
            } else {
              p++;
            }
            continue;
          }
        } else if (pattern[p] instanceof RegExp) {
          if (!input[i].match(pattern[p])) {
            return -1;
          }
        } else if (SchemeString.isString(pattern[p])) {
          if (pattern[p].valueOf() !== input[i]) {
            return -1;
          }
        } else if (typeof pattern[p] === "symbol") {
          if (pattern[p] === Symbol.for("*")) {
            // ignore S-expressions inside for case when next pattern is )
            glob[p] = glob[p] || 0;
            //var zero_match = empty_match();
            if (["(", "["].includes(input[i])) {
              glob[p]++;
            } else if ([")", "]"].includes(input[i])) {
              glob[p]--;
            }
            if ((pattern[p + 1] !== undefined && glob[p] === 0 && match_next() === -1) || glob[p] > 0) {
              continue;
            }
          } else if (not_symbol_match()) {
            return -1;
          }
        } else if (Array.isArray(pattern[p])) {
          const inc = inner_match(pattern[p], input.slice(i));
          if (inc === -1 || inc + i > input.length) {
            // if no more input it's not match
            return -1;
          }
          i += inc - 1;
          p++;
          continue;
        } else {
          return -1;
        }
        p++;
      }
      if (pattern.length !== p) {
        // if there are still patterns it's not match
        return -1;
      }
      return input.length;
    }
  }

  static exception_shift(
    token: string,
    settings: Required<FormatterOptions> & { exceptions: FormatterExceptions },
  ): number {
    function match(list: (string | RegExp)[]): boolean {
      if (list.length === 0) {
        return false;
      }
      if (list.includes(token)) {
        return true;
      } else {
        const regexes = list.filter((s): s is RegExp => s instanceof RegExp);
        if (regexes.length === 0) {
          return false;
        }
        for (const re of regexes) {
          if (token.match(re)) {
            return true;
          }
        }
      }
      return false;
    }

    if (match(settings.exceptions.specials)) {
      return settings.indent;
    }
    const shift = settings.exceptions.shift;
    for (const [indent, tokens] of Object.entries(shift)) {
      if (match(tokens)) {
        return +indent;
      }
    }
    return -1;
  }

  _options(options?: FormatterOptions): Required<FormatterOptions> & { exceptions: FormatterExceptions } {
    const defaults = Formatter.defaults;
    if (options === undefined) {
      return Object.assign({}, defaults);
    }
    const exceptions = options?.exceptions || {};
    const specials = exceptions.specials || [];
    const shift = exceptions.shift || { 1: [] };
    return {
      ...defaults,
      ...options,
      exceptions: {
        specials: [...defaults.exceptions.specials, ...specials],
        shift: {
          ...shift,
          1: [...defaults.exceptions.shift[1], ...(shift[1] || [])],
        },
      },
    };
  }

  indent(options?: FormatterOptions): number {
    const tokens = tokenize(this.__code__, true) as TokenMeta[];
    return this._indent(tokens, options);
  }

  _indent(tokens: TokenMeta[], options?: FormatterOptions): number {
    const settings = this._options(options);
    const spaces = lineIndent(tokens);
    const sexp = previousSexp(tokens);
    // one character before S-Expression
    const before_sexpr = tokens[tokens.length - sexp.length - 1];
    const last = tokens.at(-1);
    if (last && /^"[\s\S]+[^"]$/.test(last.token)) {
      return spaces + settings.indent;
    }
    if (sexp?.length) {
      if (sexp[0].line > 0) {
        settings.offset = 0;
      }
      if (sexp.toString() === tokens.toString() && balanced(sexp)) {
        return settings.offset + sexp[0].col;
      } else if (sexp.length === 1) {
        return settings.offset + sexp[0].col + 1;
      } else {
        // search for token before S-Expression for case like #(10 or &(:x
        let exception = -1;
        if (before_sexpr) {
          const shift = Formatter.exception_shift(before_sexpr.token, settings);
          if (shift !== -1) {
            exception = shift;
          }
        }
        if (exception === -1) {
          exception = Formatter.exception_shift(sexp[1].token, settings);
        }
        if (exception !== -1) {
          return settings.offset + sexp[0].col + exception;
        } else if (sexp[0].line < sexp[1].line) {
          return settings.offset + sexp[0].col + 1;
        } else if (sexp.length > 3 && sexp[1].line === sexp[3].line) {
          if (sexp[1].token === "(" || sexp[1].token === "[") {
            return settings.offset + sexp[1].col;
          }
          return settings.offset + sexp[3].col;
        } else if (sexp[0].line === sexp[1].line) {
          return settings.offset + settings.indent + sexp[0].col;
        } else {
          const next_tokens = sexp.slice(2);
          for (const token of next_tokens) {
            if (token.token.trim()) {
              return token.col;
            }
          }
        }
      }
    } else {
      return 0;
    }
    return spaces + settings.indent;
  }

  _spaces(i: number): string {
    return " ".repeat(i);
  }

  break(): this {
    const code = this.__code__.replaceAll(/\n[ \t]*/g, "\n ").replace(/^\s+/, "");
    // function that work when calling tokenize with meta data or not
    const extractToken = (t: TokenMeta): string => {
      return t.token.match(string_re) || re_re.test(t.token) ? t.token : t.token.replace(/\s+/, " ");
    };
    const first_token_index = (tokens: string[]): number | undefined => {
      for (let i = tokens.length; i--; ) {
        const token = tokens[i];
        if (token.trim() && !is_special(token)) {
          return tokens.length - i - 1;
        }
      }
    };
    // Tokenize is part of the parser/lexer that split code into tokens and includes
    // meta data like number of column or line
    const tokens: string[] = (tokenize(code, true) as TokenMeta[]).map(extractToken).filter((t: string) => t !== "\n");
    const { rules } = Formatter;
    outer: for (let i = 1; i < tokens.length; ++i) {
      if (!tokens[i].trim()) {
        continue;
      }
      const sub = tokens.slice(0, i);
      const sexp: Record<number, string[]> = {};
      for (let count of rules.map((b) => b[1] as number)) {
        count = count.valueOf();
        // some patterns require to check what was before like
        // if inside let binding
        if (count > 0 && !sexp[count]) {
          sexp[count] = previousSexp(sub, count) as string[];
        }
      }
      for (const [pattern, rawCount, ext] of rules) {
        const count = (rawCount as number).valueOf();
        // 0 count mean ignore the previous S-Expression
        const test_sexp = count > 0 ? sexp[count] : sub;
        const input = test_sexp.filter((t: string) => t.trim() && !is_special(t));
        const inc = first_token_index(test_sexp);
        const m = Formatter.match(pattern, input);
        const next = tokens.slice(i).find((t: string) => t.trim() && !is_special(t));
        if (m && ((ext instanceof Formatter.Ahead && ext.match(next || "")) || !ext)) {
          const index = i - inc!;
          if (tokens[index] !== "\n") {
            if (tokens[index].trim()) {
              tokens.splice(index, 0, "\n");
              i++;
            } else {
              tokens[index] = "\n";
            }
          }
          i += inc!;
          continue outer;
        }
      }
    }
    this.__code__ = tokens.join("");
    return this;
  }

  format(options?: FormatterOptions): string {
    // prepare code with single space after newline
    // so we have space token to align
    const code = this.__code__.replaceAll(/[ \t]*\n[ \t]*/g, "\n ");
    const tokens = tokenize(code, true) as TokenMeta[];
    const settings = this._options(options);
    let indent = 0;
    let offset = 0;
    for (let i = 0; i < tokens.length; ++i) {
      const token = tokens[i];
      if (token.token === "\n") {
        indent = this._indent(tokens.slice(0, i), settings);
        offset += indent;
        if (tokens[i + 1]) {
          tokens[i + 1].token = this._spaces(indent);
          // because we have single space as initial indent
          indent--;
          offset--;
          for (let j = i + 2; j < tokens.length; ++j) {
            tokens[j].offset += offset;
            tokens[j].col += indent;
            if (tokens[j].token === "\n") {
              // ++i is called after the loop
              i = j - 1;
              break;
            }
          }
        }
      }
    }
    return tokens
      .map((token: TokenMeta) => {
        if (token.token.match(string_re) && /\n/.test(token.token)) {
          const spaces = " ".repeat(token.col);
          const [head, ...tail] = token.token.split("\n");
          token.token = [head, ...tail.map((line: string) => spaces + line)].join("\n");
        }
        return token.token;
      })
      .join("");
  }
}
