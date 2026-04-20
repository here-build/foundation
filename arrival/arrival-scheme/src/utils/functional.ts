// -------------------------------------------------------------------------
// :: Functional programming utilities
// -------------------------------------------------------------------------
import { is_null } from "../guards.js";
import { SchemeExact, SchemeInexact } from "../numbers.js";
import { typecheck } from "./typecheck.js";

type AnyFunction = (...args: unknown[]) => unknown;

// -------------------------------------------------------------------------
export function guard_math_call(fn: AnyFunction, ...args: unknown[]): unknown {
  for (const arg of args) {
    typecheck("", arg, "number");
  }
  return fn(...args);
}

// ----------------------------------------------------------------------
export function pipe(...fns: AnyFunction[]): AnyFunction {
  for (const [i, fn] of fns.entries()) {
    typecheck("pipe", fn, "function", i + 1);
  }
  return function (this: unknown, ...args: unknown[]): unknown {
    return fns.reduce((currentArgs, f) => {
      return [f.apply(this, currentArgs as unknown[])];
    }, args)[0];
  };
}

// -------------------------------------------------------------------------
export function compose(...fns: AnyFunction[]): AnyFunction {
  for (const [i, fn] of fns.entries()) {
    typecheck("compose", fn, "function", i + 1);
  }
  return pipe(...fns.reverse());
}

// -------------------------------------------------------------------------
// :: fold functions generator
// -------------------------------------------------------------------------
export function fold(
  this: unknown,
  name: string,
  foldFn: (this: unknown, recur: AnyFunction, fn: AnyFunction, init: unknown, ...lists: unknown[]) => unknown,
): AnyFunction {
  const self = this;
  const recur = function (fn: AnyFunction, init: unknown, ...lists: unknown[]): unknown {
    typecheck(name, fn, "function");
    if (lists.some(is_null)) {
      if (typeof init === "number") {
        return Number.isSafeInteger(init) ? new SchemeExact(BigInt(init)) : new SchemeInexact(init);
      }
      if (typeof init === "bigint") {
        return new SchemeExact(init);
      }
      return init;
    } else {
      return foldFn.call(self, recur as AnyFunction, fn, init, ...lists);
    }
  };
  return recur as AnyFunction;
}

// -------------------------------------------------------------------------
export function limit_math_op(n: number, fn: AnyFunction): AnyFunction {
  // + 1 so it includes function in guard_math_call
  return limit(n + 1, curry(guard_math_call as AnyFunction, fn));
}

// -------------------------------------------------------------------------
// :: some functional magic
// -------------------------------------------------------------------------
export const single_math_op = curry(limit_math_op as AnyFunction, 1);
export const binary_math_op = curry(limit_math_op as AnyFunction, 2);

// -------------------------------------------------------------------------
export function reduce_math_op(fn: AnyFunction, init: unknown = null): AnyFunction {
  return function (...args: unknown[]): unknown {
    if (init !== null) {
      args = [init, ...args];
    }
    return args.reduce(binary_math_op(fn) as (acc: unknown, val: unknown) => unknown);
  };
}

// -------------------------------------------------------------------------
export function curry(fn: AnyFunction, ...init_args: unknown[]): AnyFunction {
  typecheck("curry", fn, "function");
  const len = fn.length;
  return function (...call_args: unknown[]): unknown {
    const args = [...init_args];
    // HACK: we use IIFE here to get rid of the name of the function.
    // The JavaScript is smart and add name property to a function
    // if it's assigned to a variable, with IIFE we can get rid of it.
    // we need this so the curried function display as #<procedure>
    const curried: AnyFunction = (() => {
      return (...more_args: unknown[]): unknown => {
        const fullArgs = [...args, ...more_args];
        return fullArgs.length >= len ? fn(...fullArgs) : curried(...[]);
      };
    })();
    return curried(...call_args);
  };
}

// -------------------------------------------------------------------------
// return function with limited number of arguments
export function limit(n: number, fn: AnyFunction): AnyFunction {
  typecheck("limit", fn, "function", 2);
  return function (...args: unknown[]): unknown {
    return fn(...args.slice(0, n));
  };
}
