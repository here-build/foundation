// -------------------------------------------------------------------------
// :: Parameters for make-parameter and parametrize
// -------------------------------------------------------------------------
import { is_function } from "./guards.js";
import { type } from "./utils/typecheck.js";
import invariant from "tiny-invariant";

type ParameterFn<T> = ((value: T) => T) & { __name__?: string };

export class Parameter<T = unknown> {
  static __class__ = "parameter";

  __value__: T;
  __fn__: ParameterFn<T> | null;
  private _p_name: string | null;

  constructor(init: T, fn: ParameterFn<T> | null = null, name: string | null = null) {
    this.__value__ = init;
    this.__fn__ = null;
    if (fn) {
      invariant(is_function(fn), `Section argument to Parameter need to be function ${type(fn)} given`);
      this.__fn__ = fn;
    }
    this._p_name = name;
  }

  get __name__(): string | null {
    return this._p_name;
  }

  set __name__(name: string | null) {
    this._p_name = name;
    if (this.__fn__ && name) {
      this.__fn__.__name__ = `fn-${name}`;
    }
  }

  invoke(): T {
    if (is_function(this.__fn__)) {
      return this.__fn__(this.__value__);
    }
    return this.__value__;
  }

  inherit(value: T): Parameter<T> {
    return new Parameter(value, this.__fn__, this.__name__);
  }
}
