// -------------------------------------------------------------------------
// :: Promise utilities for handling async values in the interpreter
// -------------------------------------------------------------------------
import { is_plain_object, is_promise } from "../guards.js";
import { QuotedPromise } from "../QuotedPromise.js";
import { Value } from "../Value.js";

// ----------------------------------------------------------------------
// wrapper over Promise.all that ignores quoted promises
// ----------------------------------------------------------------------
export function promise_all(arg: unknown[]): Promise<unknown[]> | unknown[] {
  if (Array.isArray(arg)) {
    return Promise.all(escape_quoted_promises(arg)).then(unescape_quoted_promises);
  }
  return arg;
}

// ----------------------------------------------------------------------
export function escape_quoted_promises(array: unknown[]): unknown[] {
  // using loops for performance
  const escaped: unknown[] = Array.from({ length: array.length });
  let i = array.length;
  while (i--) {
    const value = array[i];
    escaped[i] = value instanceof QuotedPromise ? new Value(value) : value;
  }
  return escaped;
}

// ----------------------------------------------------------------------
export function unescape_quoted_promises(array: unknown[]): unknown[] {
  const unescaped: unknown[] = Array.from({ length: array.length });
  let i = array.length;
  while (i--) {
    const value = array[i];
    unescaped[i] = value instanceof Value ? value.valueOf() : value;
  }
  return unescaped;
}

// ----------------------------------------------------------------------
export function unpromise(
  value: unknown,
  fn: (x: unknown) => unknown = (x) => x,
  error: ((e: unknown) => void) | null = null,
): unknown {
  if (is_promise(value)) {
    const ret = (value as Promise<unknown>).then(fn);
    return error === null ? ret : ret.catch(error);
  }
  if (Array.isArray(value)) {
    return unpromise_array(value, fn, error);
  }
  if (is_plain_object(value)) {
    return unpromise_object(value as Record<string, unknown>, fn, error);
  }
  return fn(value);
}

// ----------------------------------------------------------------------
export function unpromise_array(
  array: unknown[],
  fn: (x: unknown) => unknown,
  error: ((e: unknown) => void) | null,
): unknown {
  return array.some(is_promise)
    ? unpromise(
        promise_all(array),
        (arr) => {
          if (Object.isFrozen(array)) {
            Object.freeze(arr);
          }
          return fn(arr);
        },
        error,
      )
    : fn(array);
}

// ----------------------------------------------------------------------
export function unpromise_object(
  object: Record<string, unknown>,
  fn: (x: unknown) => unknown,
  error: ((e: unknown) => void) | null,
): unknown {
  const keys = Object.keys(object);
  const values: unknown[] = [];
  const anyPromise: Promise<unknown>[] = [];
  let i = keys.length;
  while (i--) {
    const key = keys[i];
    const value = object[key];
    values[i] = value;
    if (is_promise(value)) {
      anyPromise.push(value as Promise<unknown>);
    }
  }
  if (anyPromise.length > 0) {
    return unpromise(
      promise_all(values),
      (resolvedValues) => {
        const result: Record<string, unknown> = {};
        for (const [i, value] of (resolvedValues as unknown[]).entries()) {
          const key = keys[i];
          result[key] = value;
        }
        if (Object.isFrozen(object)) {
          Object.freeze(result);
        }
        return result;
      },
      error,
    );
  }
  return fn(object);
}
