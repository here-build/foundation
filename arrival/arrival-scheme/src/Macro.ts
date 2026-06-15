import { trim_lines } from "./utils/trim-lines.js";
import { typecheck } from "./utils/typecheck.js";

export interface MacroInvokeContext {
  env: unknown;
  error?: (e: Error) => void;
  use_dynamic?: boolean;
  dynamic_env?: unknown;
  [key: string]: unknown;
}

/**
 * A define-macro fexpr: a function that receives UNEVALUATED code and returns a
 * replacement form. `Syntax` (syntax-rules) subclasses this. `__defmacro__` marks
 * instances that `macroexpand` is allowed to expand.
 */
export class Macro {
  static __class__ = "macro";

  __name__: string;
  __fn__: Function;
  __doc__?: string;
  __defmacro__?: boolean;

  constructor(name: string, fn: Function, doc?: string, dump?: boolean) {
    typecheck("Macro", name, "string", 1);
    typecheck("Macro", fn, "function", 2);
    if (doc) {
      this.__doc__ = dump ? doc : trim_lines(doc);
    }
    this.__name__ = name;
    this.__fn__ = fn;
  }

  // The fexpr body runs with `env` as `this`; `macro_expand` is threaded in so a
  // macro can recursively expand its own output.
  invoke(code: unknown, { env, ...rest }: MacroInvokeContext, macro_expand: unknown): unknown {
    return this.__fn__.call(env, code, { ...rest, macro_expand }, this.__name__);
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
