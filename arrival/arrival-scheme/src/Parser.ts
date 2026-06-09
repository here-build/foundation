// -------------------------------------------------------------------------
// :: Parser inspired by BiwaScheme
// :: ref: https://github.com/biwascheme/biwascheme/blob/master/src/system/parser.js
// -------------------------------------------------------------------------
import { DatumReference } from "./DatumReference.js";
import { foldcase_string } from "./foldcase.js";
import * as specials from "./specials.js";
import {
  is_builtin,
  is_bytevector_literal,
  is_directive,
  is_literal,
  is_nil,
  is_pair,
  is_plain_object,
  is_special,
  is_symbol_extension,
  is_vector_literal,
} from "./guards.js";
import { Environment, EnvironmentValue } from "./Environment.js";
import type { EOF } from "./EOF.js";
import { eof } from "./EOF.js";
import { type SourceLocation, ParseError, Unterminated } from "./errors.js";
import { Lexer } from "./Lexer.js";
// -------------------------------------------------------------------------
// :: Runtime dependencies - ES6 live bindings resolve the cycle
// :: (these are only used inside methods, not at module evaluation time)
// -------------------------------------------------------------------------
import { call_function, evaluate as lipsEvaluate, global_env, lips, unpromise } from "./lips.js";
import { parse_argument } from "./utils/parsing.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import { Macro } from "./Macro.js";
import { Pair } from "./Pair.js";
import type { Nil, SchemeValue } from "./types.js";
import { nil } from "./types.js";
import invariant from "tiny-invariant";

// ---------------------------------------------------------------------------
// Nesting-depth cap — native-stack-overflow defense for the parser.
// ---------------------------------------------------------------------------
// War story (2026-05-30 sandbox-escape audit): `_read_object` ⇄ `read_list`
// recurse through real JS call frames, one level per open paren. Input like
// `"(".repeat(10000) + "1" + ")".repeat(10000)` overflows the native stack
// BEFORE the parser can produce a structured value, surfacing as a raw
// `RangeError: Maximum call stack size exceeded` — a host-implementation leak
// that sandbox code can't `guard` cleanly. The parser already tracks a running
// paren balance (`_state.parentheses`), which is exactly the live descent depth
// while reading (it only decrements once a list closes, after the recursion for
// its contents has returned). So an O(1) check at each open site bails with a
// Scheme-level ParseError well before V8's frame limit.
//
// Default: 2,000. Calibrated against the MOST fragile downstream consumer, not
// the parser alone. Empirical overflow points on Node/V8 (2026-05-30):
//   - parser recursion alone: graceful past depth 12,000;
//   - generator trampoline eval (the sandbox/MCP runtime path): stack-SAFE at
//     every depth — deep input yields a graceful "cannot apply" error;
//   - legacy `lips.exec` recursive evaluator: native stack overflow at ~3,500.
// 2,000 sits comfortably below that 3,500 floor (so a deeply-nested form is
// rejected at PARSE time, before any evaluator recurses into it) while staying
// orders of magnitude above any hand-written or machine-generated s-expression
// depth. Host-overridable via `setMaxNestingDepth` for trusted/looser contexts.
let maxNestingDepth = 2_000;

/** Current parser nesting-depth cap (open delimiters before a ParseError). */
export function getMaxNestingDepth(): number {
  return maxNestingDepth;
}

/**
 * Override the parser nesting-depth cap. `Infinity` disables it (trusted input
 * only — re-exposes the native-stack-overflow vector). Must be a positive
 * number.
 */
export function setMaxNestingDepth(depth: number): void {
  invariant(
    typeof depth === "number" && !Number.isNaN(depth) && depth > 0,
    `setMaxNestingDepth: expected a positive number, got ${depth}`,
  );
  maxNestingDepth = depth;
}

/**
 * Token metadata from lexer.
 */
export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

/**
 * Parser options.
 */
interface ParserOptions {
  env?: Environment;
  meta?: boolean;
  formatter?: (token: TokenMeta) => TokenMeta;
  /** Source identifier (filename / module path) stamped onto every location this
   *  parser produces — so a throw inside a required module reads as `file:line`. */
  source?: string;
}

// -------------------------------------------------------------------------
// :: Default formatter for tokens with metadata
// -------------------------------------------------------------------------
function defaultFormatter(token: { token: string; col: number; offset: number; line: number }) {
  return token;
}

// -------------------------------------------------------------------------
export class Parser {
  // Re-export for backwards compatibility
  public static readonly Unterminated = Unterminated;

  // Instance properties
  __lexer__!: Lexer;
  __env__?: Environment;
  private readonly _formatter!: (token: TokenMeta) => TokenMeta;
  private readonly _meta!: boolean;
  private readonly _source?: string;
  private _refs!: (SchemeValue | Promise<SchemeValue>)[];
  private readonly _state!: { parentheses: number; fold_case: boolean };

  constructor({ env, meta = false, formatter = defaultFormatter, source }: ParserOptions = {}) {
    Object.defineProperty(this, "_formatter", {
      value: formatter,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_source", {
      value: source,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "__env__", {
      value: env,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(this, "_meta", {
      value: meta,
      configurable: true,
      enumerable: false,
    });
    // datum labels
    Object.defineProperty(this, "_refs", {
      value: [],
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_state", {
      value: {
        parentheses: 0,
        fold_case: false,
      },
      configurable: true,
      enumerable: false,
    });
  }

  _with_syntax_scope<T>(fn: () => T | Promise<T>): T | Promise<T> {
    // expose parser and change stdin so parser extension can use current-input
    // to read data from the parser stream #150
    // Cast needed because __parser__ is an internal extension not in SchemeValue
    global_env.set("lips", {
      ...lips,
      __parser__: this,
    } as unknown as EnvironmentValue);
    const cleanup = () => {
      global_env.set("lips", lips);
    };
    return unpromise(
      fn(),
      (result) => {
        cleanup();
        return result as T;
      },
      cleanup,
    ) as T | Promise<T>;
  }

  parse(arg: string | SchemeString) {
    if (arg instanceof SchemeString) {
      arg = arg.toString();
    }
    Object.defineProperty(this, "__lexer__", {
      value: new Lexer(arg),
      configurable: true,
      enumerable: true,
    });
  }

  resolve(name: string) {
    return this.__env__?.get(name, { throwError: false });
  }

  async peek() {
    let token;
    while (true) {
      token = this.__lexer__.peek(true);
      if (token === eof) {
        return eof;
      }
      if (this.is_comment(token!.token)) {
        this.skip();
        continue;
      }
      if (is_directive(token!.token)) {
        this.skip();
        if (token!.token === "#!fold-case") {
          this._state.fold_case = true;
        } else if (token!.token === "#!no-fold-case") {
          this._state.fold_case = false;
        }
        continue;
      }
      if (token!.token === "#;") {
        this.skip();
        invariant(this.__lexer__.peek() !== eof, "Lexer: syntax error eof found after comment");
        await this._read_object();
        continue;
      }
      break;
    }
    token = this._formatter(token);
    if (this._state.fold_case) {
      token.token = foldcase_string(token.token);
    }
    if (this._meta) {
      return token;
    }
    return token.token;
  }

  reset() {
    this._refs.length = 0;
  }

  skip() {
    this.__lexer__.skip();
  }

  /**
   * Get the source location of the current token.
   * Returns undefined if no token metadata is available.
   */
  _getLocation(): SourceLocation | undefined {
    const meta = this.__lexer__.__token__;
    if (!meta) return undefined;
    return {
      line: meta.line + 1, // Convert 0-indexed to 1-indexed
      col: meta.col,
      offset: meta.offset,
      // `source` (this parser's filename/module path) makes frames read as
      // `file:line`; undefined for sourceless parses (the bare REPL/entry).
      source: this._source,
    };
  }

  async read() {
    const token = await this.peek();
    this.skip();
    return token;
  }

  match_datum_label(token: string) {
    const m = token.match(/^#(\d+)=$/);
    return m?.[1] ?? null;
  }

  match_datum_ref(token: string) {
    const m = token.match(/^#(\d+)#$/);
    return m?.[1] ?? null;
  }

  /**
   * Enter one nesting level. Increments the live descent depth and throws a
   * Scheme-level ParseError if it would exceed the cap — called at every open
   * delimiter (list, vector literal, bytevector literal) BEFORE recursing, so
   * we bail before the native JS stack overflows. See `maxNestingDepth`.
   */
  private _enterNesting() {
    if (++this._state.parentheses > maxNestingDepth) {
      throw new ParseError(
        `input nesting depth exceeded ${maxNestingDepth}`,
        this._getLocation(),
      );
    }
  }

  is_open(token: string) {
    return ["(", "["].includes(token);
  }

  is_close(token: string) {
    return [")", "]"].includes(token);
  }

  async read_list(): Promise<Pair | Nil> {
    let head: Pair | typeof nil = nil;
    let prev: Pair | typeof nil = head;
    let dot = false;
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        break;
      }
      if (typeof token === "string" && this.is_close(token)) {
        --this._state.parentheses;
        this.skip();
        break;
      }
      // Capture location BEFORE reading the object
      const loc = this._getLocation();
      if (token === "." && !is_nil(head)) {
        this.skip();
        (prev as Pair).cdr = await this._read_object();
        dot = true;
      } else {
        invariant(!dot, "Parser: syntax error more than one element after dot");
        const node = await this._read_object();
        const cur = new Pair(node, nil);
        if (loc) {
          cur.setLocation(loc);
        }
        if (is_nil(head)) {
          head = cur;
        } else {
          (prev as Pair).cdr = cur;
        }
        prev = cur;
      }
    }
    return head;
  }

  async read_value() {
    const token = await this.read();
    invariant(token !== eof, "Parser: Expected token eof found");
    return parse_argument(token);
  }

  is_comment(token: string) {
    return token.match(/^;/) || (token.match(/^#\|/) && token.match(/\|#$/));
  }

  async evaluate(code: SchemeValue): Promise<SchemeValue> {
    const result = lipsEvaluate(code, {
      env: this.__env__,
      error: (e: Error) => {
        throw e;
      },
    });
    // Await to normalize both sync and async returns
    return (await result) as SchemeValue;
  }

  // public API that handle R7RS datum labels
  async read_object(): Promise<SchemeValue | EOF> {
    this.reset();
    let object = await this._read_object();
    if (object instanceof DatumReference) {
      object = object.valueOf();
    }
    if (this._refs.length > 0) {
      return unpromise(this._resolve_object(object as SchemeValue), (resolved: SchemeValue) => {
        if (is_pair(resolved)) {
          // mark cycles on parser level
          resolved.mark_cycles();
        }
        return resolved;
      });
    }
    return object;
  }

  balanced(): boolean {
    return this._state.parentheses === 0;
  }

  ballancing_error(expr: SchemeValue, prev: SchemeValue): never {
    const count = this._state.parentheses;
    let e: Error & { __code__?: string[] };
    if (count < 0) {
      e = new Error("Parser: unexpected parenthesis");
      e.__code__ = [`${String(prev)})`];
    } else {
      e = new Error("Parser: expected parenthesis but eof found");
      const re = new RegExp(`\\){${count}}$`);
      e.__code__ = [String(expr).replace(re, "")];
    }
    throw e;
  }

  // TODO: Cover This function (array and object branch)
  async _resolve_object(object: SchemeValue): Promise<SchemeValue> {
    if (Array.isArray(object)) {
      return Promise.all(object.map((item) => this._resolve_object(item)));
    }
    if (is_plain_object(object)) {
      const result: Record<string, SchemeValue> = {};
      for (const key of Object.keys(object)) {
        result[key] = await this._resolve_object(object[key] as SchemeValue);
      }
      return result as unknown as SchemeValue;
    }
    if (is_pair(object)) {
      return this._resolve_pair(object);
    }
    return object;
  }

  async _resolve_pair(pair: Pair): Promise<Pair> {
    if (is_pair(pair)) {
      if (pair.car instanceof DatumReference) {
        pair.car = await pair.car.valueOf();
      } else if (is_pair(pair.car)) {
        await this._resolve_pair(pair.car);
      }
      if (pair.cdr instanceof DatumReference) {
        pair.cdr = await pair.cdr.valueOf();
      } else if (is_pair(pair.cdr)) {
        await this._resolve_pair(pair.cdr);
      }
    }
    return pair;
  }

  async _read_object(): Promise<SchemeValue | EOF> {
    const token = await this.peek();
    if (token === eof) {
      return token;
    }
    // Capture location early for all constructs
    const loc = this._getLocation();
    if (is_special(token)) {
      // Handle vector literals #(...) specially
      if (is_vector_literal(token)) {
        this.skip();
        this._enterNesting();
        const list = await this.read_list();
        // Convert list to array
        if (is_nil(list)) {
          return [];
        }
        return (list as Pair).to_array(false);
      }
      // Handle bytevector literals #u8(...) specially
      if (is_bytevector_literal(token)) {
        this.skip();
        this._enterNesting();
        const list = await this.read_list();
        // Convert list to Uint8Array
        if (is_nil(list)) {
          return new Uint8Array(0);
        }
        const arr = (list as Pair).to_array(false) as number[];
        return new Uint8Array(arr.map((v) => (typeof v === "number" ? v : Number(v))));
      }
      // Built-in parser extensions are mapping short symbols to longer symbols
      // that can be function or macro. Parser doesn't care
      // if it's not built-in and the extension can be macro or function.
      // FUNCTION: when it's used, it gets arguments like FEXPR and the
      // result is returned by parser as is the macro.
      // MACRO: if macro is used, then it is evaluated in place and the
      // result is returned by parser and it is quoted.
      const special = specials.get(token);
      const builtin = is_builtin(token);
      this.skip();
      let expr: any, extension: any;
      const is_symbol = is_symbol_extension(token);
      const was_close_paren = this.is_close(await this.peek());
      const object = is_symbol ? undefined : await this._read_object();
      if (object === eof) {
        throw new Unterminated("Expecting expression, eof found");
      }
      if (!builtin) {
        extension = this.__env__!.get(special.symbol);
        if (typeof extension === "function") {
          let args: any;
          if (is_literal(token)) {
            args = [object];
          } else if (is_nil(object)) {
            args = [];
          } else if (is_pair(object)) {
            args = object.to_array(false);
          }
          invariant(args || is_symbol, () => `Parse Error: Invalid parser extension invocation ${special.symbol}`);
          return this._with_syntax_scope(() =>
            call_function(extension, is_symbol ? [] : args, {
              env: this.__env__,
              dynamic_env: this.__env__,
              use_dynamic: false,
            }),
          );
        }
      }
      if (is_literal(token)) {
        invariant(!was_close_paren, "Parse Error: expecting datum");
        expr = new Pair(special.symbol, new Pair(object, nil));
        if (loc) expr.setLocation(loc);
      } else {
        expr = new Pair(special.symbol, object);
        if (loc) expr.setLocation(loc);
      }
      // Built-in parser extensions just expand into lists like 'x ==> (quote x)
      if (builtin) {
        return expr;
      }
      invariant(extension instanceof Macro, () => `Parse Error: invalid parser extension: ${special.symbol}`);
      // Evaluate parser extension at parse time
      const result = await this._with_syntax_scope(() => {
        return this.evaluate(expr);
      });
      // We need literal quotes to make that macro's return pairs works
      // because after the parser returns the value it will be evaluated again
      // by the interpreter, so we create quoted expressions.
      if (is_pair(result) || result instanceof SchemeSymbol) {
        const quoted = Pair.fromArray([new SchemeSymbol("quote"), result]) as Pair;
        if (loc) quoted.setLocation(loc);
        return quoted;
      }
      return result;
    }
    const ref = this.match_datum_ref(token);
    if (ref !== null) {
      this.skip();
      invariant(+ref in this._refs, `Parse Error: invalid datum label #${ref}#`);
      return new DatumReference(ref, this._refs[+ref] as SchemeValue);
    }
    const ref_label = this.match_datum_label(token);
    if (ref_label !== null) {
      this.skip();
      this._refs[+ref_label] = this._read_object() as SchemeValue | Promise<SchemeValue>;
      return this._refs[+ref_label] as SchemeValue | Promise<SchemeValue>;
    } else if (this.is_close(token)) {
      --this._state.parentheses;
      this.skip();
      // invalid state, we don't need to return anything
    } else if (this.is_open(token)) {
      this._enterNesting();
      this.skip();
      const list = await this.read_list();
      // Attach location of opening paren to head of list
      if (loc && is_pair(list)) {
        list.setLocation(loc);
      }
      return list;
    } else {
      return this.read_value();
    }
  }
}
