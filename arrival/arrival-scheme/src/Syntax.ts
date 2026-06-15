// TODO: Syntax shouldn't extend Macro — syntax transformers aren't runtime values.
import { Macro, MacroInvokeContext } from "./Macro.js";

// Type for syntax object (can be Syntax or Function)
type SyntaxLike = Syntax | Function;

export class Syntax extends Macro {
  static __class__ = "syntax";
  static __merge_env__ = Symbol.for("merge");
  // SRFI-139
  static Parameter = class SyntaxParameter {
    static __class__ = "syntax-parameter";

    _syntax!: SyntaxLike; // Definite assignment - set via Object.defineProperty
    constructor(syntax: SyntaxLike) {
      Object.defineProperty(this, "_syntax", {
        value: syntax,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(syntax, "_param", {
        value: true,
        configurable: true,
        enumerable: false,
      });
    }
  };
  __env__: unknown;

  constructor(fn: Function, env: unknown) {
    // Macro constructor requires name and fn, but Syntax doesn't have a name initially
    super("", fn);
    this.__env__ = env;
    // allow macroexpand
    this.__defmacro__ = true;
  }

  invoke(code: unknown, { error, env, use_dynamic }: MacroInvokeContext, macro_expand: unknown): unknown {
    const args = {
      error,
      env,
      use_dynamic,
      dynamic_env: this.__env__,
      macro_expand,
    };
    return this.__fn__.call(env, code, args, this.__name__ || "syntax");
  }

  toString(): string {
    if (this.__name__) {
      return `#<syntax:${this.__name__}>`;
    }
    return "#<syntax>";
  }
}
