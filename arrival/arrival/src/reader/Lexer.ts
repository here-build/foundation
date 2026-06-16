/**
 * Incremental, table-driven FSM tokenizer. The Parser drives it through `peek()`/`skip()` (one token
 * of lookahead, never the whole string), so a streaming or partial parse never re-lexes from the top.
 *
 * The non-obvious part is rule ORDERING: rules concatenate `_rules` → `_brackets` → specials →
 * `_symbol_rules`, symbols last. That layering is the disambiguation strategy — a delimiter like
 * `(`/`{` is claimed as a bracket before the symbol rules could absorb it, which is why adding the
 * SRFI-105 `{}` delimiter was a one-line widening of the bracket char-class.
 */
import invariant from "tiny-invariant";
import { eof } from "../values/EOF.js";
import { Unterminated } from "../errors.js";
import { is_string } from "../eval/guards.js";
import { directives, hash_literals, parsable_contants } from "../values/primitives.js";
import * as specials from "./specials.js";

/**
 * FSM transition row: `[char_re, prev_re, next_re, from_state, to_state]`. A row fires when the
 * current char matches `char_re`, the neighbours match `prev_re`/`next_re` (null = any), AND the
 * machine is in `from_state` (null = stateless). `to_state` null means the token is COMPLETE at this
 * char — that null-terminator contract is what `next_token` and `literal_rule` both rely on.
 */
type LexerRule = [RegExp | string, RegExp | string | null, RegExp | string | null, symbol | null, symbol | null];

interface LexerInternals {
  _i: number;
  _whitespace: boolean;
  _col: number;
  _newline: number;
  _line: number;
  _state: symbol | null;
  _next: number | null;
  _token: string | null;
  _prev_char: string;
}

// null neighbour-constraint = wildcard; a string constraint is an exact char compare, not a regex.
function match_or_null(re: RegExp | string | null, char: string): boolean {
  if (re === null) {
    return true;
  }
  if (typeof re === "string") {
    return char === re;
  }
  return !!char.match(re);
}

export class Lexer {
  // FSM state markers (interned via Symbol.for so user syntax-extensions can name the same states).
  static readonly string = Symbol.for("string");
  static readonly string_escape = Symbol.for("string_escape");
  static readonly symbol = Symbol.for("symbol");
  static readonly comment = Symbol.for("comment");
  static readonly regex = Symbol.for("regex");
  static readonly regex_init = Symbol.for("regex_init");
  static readonly regex_class = Symbol.for("regex_class");
  static readonly character = Symbol.for("character");
  static readonly bracket = Symbol.for("bracket");
  static readonly b_symbol = Symbol.for("b_symbol");
  static readonly b_symbol_ex = Symbol.for("b_symbol_ex");
  static readonly b_comment = Symbol.for("b_comment");
  static readonly i_comment = Symbol.for("i_comment");
  static readonly l_datum = Symbol.for("l_datum");
  static readonly dot = Symbol.for("dot");
  static readonly boundary = /^$|[\s()[\]{}']/;
  static _brackets: LexerRule[] = [[/[()[\]{}]/, null, null, null, null]];
  // Symbol rules MUST concatenate last — a delimiter is claimed as a bracket/special before these
  // greedy `\S` catch-alls can swallow it (the disambiguation strategy, see the file header).
  static _symbol_rules: LexerRule[] = [
    [/\S/, Lexer.boundary, Lexer.boundary, null, null],
    [/\S/, Lexer.boundary, null, null, Lexer.symbol],
    [/\S/, null, Lexer.boundary, null, null],
    [/\S/, null, null, null, Lexer.symbol],
    [/\S/, null, Lexer.boundary, Lexer.symbol, null],
  ];
  // Assembled rule list is memoized; invalidated when `specials` gains/drops a syntax extension
  // (see the `specials.on` registration at the bottom of the file).
  static _cache: { valid: boolean; rules: LexerRule[] | null } = {
    valid: false,
    rules: null,
  };
  // Instance fields are installed via Object.defineProperty in the constructor (non-enumerable, so
  // they stay hidden from Scheme-side introspection of this object).
  __input__!: string;

  // Last token's meta, snapshotted on peek() — a parser extension reads it to recover source position.
  __token__?: { token: string; col: number; offset: number; line: number };
  private _i!: number;
  private readonly _whitespace!: boolean;
  private _col!: number;
  private _newline!: number;
  private _line!: number;
  private _state!: symbol | null;
  private _next!: number | null;
  private _token!: string | null;
  private readonly _prev_char!: string;

  constructor(input: string, { whitespace = false } = {}) {
    Object.defineProperty(this, "__input__", {
      value: input.replaceAll("\r", ""),
      configurable: true,
      enumerable: true,
    });
    const internals: LexerInternals = {
      _i: 0,
      _whitespace: whitespace,
      _col: 0,
      _newline: 0,
      _line: 0,
      _state: null,
      _next: null,
      _token: null,
      _prev_char: "",
    };
    // hide internals from introspection
    for (const name of Object.keys(internals) as (keyof LexerInternals)[]) {
      Object.defineProperty(this, name, {
        configurable: false,
        enumerable: false,
        get() {
          return internals[name];
        },
        set(value: LexerInternals[typeof name]) {
          (internals[name] as LexerInternals[typeof name]) = value;
        },
      });
    }
  }

  static _rules: LexerRule[] = [
    // char_re prev_re next_re from_state to_state
    // null as to_state mean that is single char token
    // string
    [/"/, null, null, Lexer.string, null],
    [/"/, null, null, null, Lexer.string],
    [/"/, null, null, Lexer.string_escape, Lexer.string],
    [/\\/, null, null, Lexer.string, Lexer.string_escape],
    [/./s, /\\/, null, Lexer.string_escape, Lexer.string],

    // hash special symbols, lexer don't need to distinguish those
    // we only care if it's not pick up by vectors literals
    [/#/, null, /[bdxoei]/i, null, Lexer.symbol],

    // characters
    [/#/, null, /\\/, null, Lexer.character],
    [/\\/, /#/, /\s/, Lexer.character, Lexer.character],
    [/\\/, /#/, /[()[\]{}]/, Lexer.character, Lexer.character],
    [/\s/, /\\/, null, Lexer.character, null],
    [/\S/, null, Lexer.boundary, Lexer.character, null],

    // regex
    [/#/, Lexer.boundary, /\//, null, Lexer.regex_init],
    [/./, /\//, null, Lexer.regex_init, Lexer.regex],
    [/[ \t]/, null, null, Lexer.regex, Lexer.regex],
    [/\[/, /[^\\]/, null, Lexer.regex, Lexer.regex_class],
    [/\]/, /[^\\]/, null, Lexer.regex_class, Lexer.regex],
    [/[()[\]{}]/, null, null, Lexer.regex, Lexer.regex],
    [/\//, /\\/, null, Lexer.regex, Lexer.regex],
    [/\//, null, Lexer.boundary, Lexer.regex, null],
    [/[gimyus]/, /\//, Lexer.boundary, Lexer.regex, null],
    [/[gimyus]/, /\//, /[gimyus]/, Lexer.regex, Lexer.regex],
    [/[gimyus]/, /[gimyus]/, Lexer.boundary, Lexer.regex, null],

    // comment
    [/;/, /^$|[^#]/, null, null, Lexer.comment],
    [/\n/, ";", null, Lexer.comment, null],
    [/[\s\S]/, null, /\n/, Lexer.comment, null],
    [/\s/, null, null, Lexer.comment, Lexer.comment],

    // block comment
    [/#/, null, /\|/, null, Lexer.b_comment],
    [/\s/, null, null, Lexer.b_comment, Lexer.b_comment],
    [/#/, /\|/, null, Lexer.b_comment, null],

    // inline comments
    [/#/, null, /;/, null, Lexer.i_comment],
    [/;/, /#/, null, Lexer.i_comment, null],

    // datum label
    [/#/, null, /\d/, null, Lexer.l_datum],
    [/=/, /\d/, null, Lexer.l_datum, null],
    [/#/, /\d/, null, Lexer.l_datum, null],

    // for dot comma `(a .,b)
    [/\./, Lexer.boundary, /,/, null, null],

    // block symbols
    [/\|/, null, null, null, Lexer.b_symbol],
    [/\s/, null, null, Lexer.b_symbol, Lexer.b_symbol],
    [/\|/, null, Lexer.boundary, Lexer.b_symbol, null],
    [/\|/, null, /\S/, Lexer.b_symbol, Lexer.b_symbol_ex],
    [/\S/, null, Lexer.boundary, Lexer.b_symbol_ex, null],
  ];

  static get rules() {
    if (Lexer._cache.valid) {
      return Lexer._cache.rules;
    }
    const parsable = [...Object.keys(parsable_contants), ...directives, ...hash_literals];
    const tokens = [...specials.names(), ...parsable].sort((a, b) => {
      return b.length - a.length || a.localeCompare(b);
    });

    // syntax-extensions tokens that share the same first character after hash
    // should have same symbol, but because tokens are sorted, the longer
    // tokens are always process first.
    const special_rules = tokens.reduce((acc: LexerRule[], token) => {
      let sym: symbol;
      let after: RegExp | null = null;
      if (token[0] === "#") {
        if (token.length === 1) {
          sym = Symbol.for(token);
        } else {
          if (hash_literals.includes(token)) {
            after = Lexer.boundary;
          }
          sym = Symbol.for(token[1]);
        }
      } else {
        sym = Symbol.for(token);
      }

      return [...acc, ...Lexer.literal_rule(token, sym, null, after)];
    }, []);

    Lexer._cache.rules = [...Lexer._rules, ...Lexer._brackets, ...special_rules, ...Lexer._symbol_rules];

    Lexer._cache.valid = true;
    return Lexer._cache.rules;
  }

  static literal_rule(
    string: string,
    sym: symbol,
    p_re: RegExp | null = null,
    n_re: RegExp | null = null,
  ): LexerRule[] {
    invariant(string.length > 0, "Lexer: invalid literal rule");
    if (string.length === 1) {
      return [[string, p_re, n_re, null, null]];
    }
    const rules: LexerRule[] = [];
    for (let i = 0, len = string.length; i < len; ++i) {
      const char_re = string[i];
      const prev_re = string[i - 1] || p_re;
      const next_re = string[i + 1] || n_re;
      let from_state: symbol | null;
      let to_state: symbol | null;
      if (i === 0) {
        from_state = null;
        to_state = sym;
      } else if (i === len - 1) {
        from_state = sym;
        to_state = null;
      } else {
        from_state = sym;
        to_state = sym;
      }
      rules.push([char_re, prev_re, next_re, from_state, to_state]);
    }
    return rules;
  }

  get(name: keyof LexerInternals): LexerInternals[keyof LexerInternals] {
    return (this as unknown as LexerInternals)[name];
  }

  set<K extends keyof LexerInternals>(name: K, value: LexerInternals[K]): void {
    (this as unknown as LexerInternals)[name] = value;
  }

  token(meta = false) {
    if (meta) {
      let line = this._line;
      if (this._whitespace && this._token === "\n") {
        --line;
      }
      return {
        token: this._token,
        col: this._col,
        offset: this._i,
        line,
      };
    }
    return this._token;
  }

  peek(meta = false) {
    if (this._i >= this.__input__.length) {
      return eof;
    }
    if (this._token) {
      Object.defineProperty(this, "__token__", {
        value: this.token(true),
        configurable: true,
        enumerable: true,
      });
      return this.token(meta);
    }
    const found = this.next_token();
    if (found) {
      this._token = this.__input__.substring(this._i, this._next!);
      if (!this.__token__) {
        // handle case when accessing __token__ from the syntax extension
        // (e.g. string interpolation) as the first expression in a REPL
        Object.defineProperty(this, "__token__", {
          value: this.token(true),
          configurable: true,
          enumerable: true,
        });
      }
      return this.token(meta);
    }
    return eof;
  }

  skip() {
    if (this._next !== null) {
      this._token = null;
      this._i = this._next;
    }
  }

  match_rule(
    rule: LexerRule,
    { prev_char, char, next_char }: { prev_char: string; char: string; next_char: string },
  ): boolean {
    const [re, prev_re, next_re, state] = rule;
    invariant(rule.length === 5, `Lexer: Invalid rule of length ${rule.length}`);
    switch (true) {
      case is_string(re) ? re !== char : !char.match(re):
      case !match_or_null(prev_re, prev_char):
      case !match_or_null(next_re, next_char):
      case state !== this._state:
        return false;
      default:
        return true;
    }
  }

  next_token() {
    if (this._i >= this.__input__.length) {
      return false;
    }
    let start = true;
    loop: for (let i = this._i, len = this.__input__.length; i < len; ++i) {
      const char = this.__input__[i];
      const prev_char = this.__input__[i - 1] || "";
      const next_char = this.__input__[i + 1] || "";
      if (char === "\n") {
        ++this._line;
        const newline = this._newline;
        if (this._state === null) {
          // keep beginning of the newline to calculate col
          // we don't want to check inside the token (e.g. strings)
          this._newline = i + 1;
        }
        if (this._whitespace && this._state === null) {
          this._next = i + 1;
          this._col = this._i - newline;
          return true;
        }
      }
      // skip leading spaces
      if (start && this._state === null && /\s/.test(char)) {
        if (this._whitespace) {
          if (/\s/.test(next_char)) {
            continue;
          } else {
            this._next = i + 1;
            this._col = this._i - this._newline;
            return true;
          }
        } else {
          this._i = i + 1;
          continue;
        }
      }
      start = false;
      // Nested block comments `#| ... #| ... |# ... |#`. The declarative rule
      // table cannot count nesting depth, so handle the whole (possibly nested)
      // block comment here with an explicit depth counter and return it as a
      // single token (the same contract the rule table uses for the non-nested
      // case). R7RS 2.2 requires block comments to nest.
      if (this._state === null && char === "#" && next_char === "|") {
        let depth = 1;
        let j = i + 2;
        const len2 = this.__input__.length;
        while (j < len2 && depth > 0) {
          const c = this.__input__[j];
          const n = this.__input__[j + 1];
          if (c === "#" && n === "|") {
            depth++;
            j += 2;
          } else if (c === "|" && n === "#") {
            depth--;
            j += 2;
          } else {
            if (c === "\n") {
              ++this._line;
            }
            j++;
          }
        }
        if (depth > 0) {
          // ran off the end without closing — fall through to the unterminated
          // handling below by leaving the lexer in the b_comment state.
          this._state = Lexer.b_comment;
          break loop;
        }
        // `j` now points just past the final `|#`
        this._next = j;
        this._col = this._i - this._newline;
        this._state = null;
        return true;
      }
      for (const rule of Lexer.rules!) {
        if (this.match_rule(rule, { prev_char, char, next_char })) {
          // change state to null if end of the token
          const next_state = rule.at(-1) ?? null;
          this._state = next_state as symbol | null;
          if (this._state === null) {
            this._next = i + 1;
            this._col = this._i - this._newline;
            return true;
          }
          // token is activated
          continue loop;
        }
      }
      // no rule for token
      invariant(
        this._state !== null,
        () => `Invalid Syntax at line ${this._line + 1}\n${this.__input__.split("\n")[this._line]}`,
      );
      // collect char in token
      continue;
    }
    // we need to ignore comments because they can be the last expression in code
    // without extra newline at the end
    if (![null, Lexer.comment].includes(this._state)) {
      const line_number = this.__input__.slice(0, Math.max(0, this._newline)).match(/\n/g)?.length ?? 0;
      const line = this.__input__.slice(Math.max(0, this._newline));
      invariant(
        this.__input__[this._i] !== "#",
        () =>
          `Invalid Syntax at line ${line_number + 1}: invalid token ${this.__input__.slice(Math.max(0, this._i)).replace(/^([^\s()[\]{}]+).*/, "$1")}`,
      );
      throw new Unterminated(`Invalid Syntax at line ${line_number + 1}: Unterminated expression ${line}`);
    }
  }
}

// A syntax extension added/removed at runtime changes the special-rules layer → drop the memoized list.
specials.on(["remove", "append"], function () {
  Lexer._cache.valid = false;
  Lexer._cache.rules = null;
});
