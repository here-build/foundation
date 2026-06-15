// ----------------------------------------------------------------------
// :: Parser macros transformers
// ----------------------------------------------------------------------

import { SchemeSymbol } from "./SchemeSymbol.js";

export const LITERAL = Symbol.for("literal");
export const SPLICE = Symbol.for("splice");
export const SYMBOL = Symbol.for("symbol");
export function names() {
  return Object.keys(__list__);
}
export function type(name) {
  try {
    return get(name).type;
  } catch (error) {
    console.log({ name });
    console.log(error);
    return null;
  }
}
export function get(name) {
  return __list__[name];
}
// events are used in Lexer dynamic rules
export function off(name: string | string[], fn: Function | null = null) {
  if (Array.isArray(name)) {
    name.forEach((n) => off(n, fn));
  } else if (fn === null) {
    delete __events__[name];
  } else if (__events__[name]) {
    __events__[name] = __events__[name].filter((test) => test !== fn);
  }
}
export function on(name, fn) {
  if (Array.isArray(name)) {
    name.forEach((name) => on(name, fn));
  } else if (__events__[name]) {
    __events__[name].push(fn);
  } else {
    __events__[name] = [fn];
  }
}
export function trigger(name, ...args) {
  if (__events__[name]) {
    for (const fn of __events__[name]) fn(...args);
  }
}
export function remove(name) {
  delete __list__[name];
  trigger("remove");
}
export function append(name, value, type) {
  __list__[name] = {
    seq: name,
    symbol: value,
    type,
  };
  trigger("append");
}
export let __events__: Record<string, Function[]> = {};
export const __list__ = {};

const defined_specials = [
  ["'", new SchemeSymbol("quote"), LITERAL],
  ["`", new SchemeSymbol("quasiquote"), LITERAL],
  [",@", new SchemeSymbol("unquote-splicing"), LITERAL],
  [",", new SchemeSymbol("unquote"), LITERAL],
  ["'>", new SchemeSymbol("quote-promise"), LITERAL],
  ["#(", new SchemeSymbol("vector"), LITERAL],
  ["#u8(", new SchemeSymbol("bytevector"), LITERAL],
];

export const __builtins__ = Object.freeze(defined_specials.map((arr) => arr[0]));

for (const [seq, symbol, type] of defined_specials) {
  append(seq, symbol, type);
}
