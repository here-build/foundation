// ----------------------------------------------------------------------
// :: Macro constructor
// ----------------------------------------------------------------------
import { trim_lines } from "./utils/trim_lines.js";
import { typecheck } from "./utils/typecheck.js";

// Interface for macro invocation context
export interface MacroInvokeContext {
  env: unknown;
  error?: (e: Error) => void;
  use_dynamic?: boolean;
  dynamic_env?: unknown;
  [key: string]: unknown;
}

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

  static defmacro(name: string, fn: Function, doc?: string, dump?: boolean): Macro {
    const macro = new Macro(name, fn, doc, dump);
    macro.__defmacro__ = true;
    return macro;
  }

  invoke(code: unknown, { env, ...rest }: MacroInvokeContext, macro_expand: unknown): unknown {
    const args = {
      ...rest,
      macro_expand,
    };
    const result = this.__fn__.call(env, code, args, this.__name__);
    return result;
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
