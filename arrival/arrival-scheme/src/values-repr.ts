// ----------------------------------------------------------------------
// Value / symbol representation helpers — shared by the stdlib literal, the
// genMacroWrapper bridge, and the macro engine (syntax-rules).
//
// These were module-private to lips.ts but are referenced from BOTH the macro
// engine (`macro_expand` / `extract_patterns` / `transform_syntax`) and the
// rest of lips.ts (genMacroWrapper, the stdlib forms). Extracting them here
// lets the macro engine — once it moves to its own `syntax-rules.ts` — import
// them from a sibling leaf instead of forming a back-edge to lips.ts. That
// back-edge is exactly the cycle the keystone drain must avoid.
//
// `is_promise` is sourced from guards.ts (it carries a pre-existing transitive
// path to Environment); that does NOT create a lips <-> values-repr runtime
// cycle (the guards -> Environment -> lips edge is type-only). Promoting
// is_promise into the value-guards true-leaf is a separate P1-residual task
// (it would drag QuotedPromise -> guards into the leaf until QuotedPromise is
// itself repointed).
// ----------------------------------------------------------------------
import { is_promise } from "./guards.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { __data__ } from "./primitives.js";
import { SchemeCharacter } from "./types.js";
import type { SchemeValue } from "./types.js";
import { is_nil, is_pair } from "./value-guards.js";

// ----------------------------------------------------------------------
// :: defines a non-enumerable, read-only Symbol-keyed property
// ----------------------------------------------------------------------
export function hidden_prop(obj: SchemeValue, name: string, value: SchemeValue): void {
  Object.defineProperty(obj, Symbol.for(name), {
    get: () => value,
    set: () => {},
    configurable: false,
    enumerable: false,
  });
}

// ----------------------------------------------------------------------
// :: true if a JS symbol was minted by gensym (name shape `#:...`)
// ----------------------------------------------------------------------
export function is_gensym(symbol: SchemeValue): boolean {
  if (typeof symbol === "symbol") {
    return !!/^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

// ----------------------------------------------------------------------
// :: mint a hygienic SchemeSymbol backed by a unique ES6 Symbol
// ----------------------------------------------------------------------
export const gensym = (function () {
  let count = 0;

  function with_props(name: SchemeValue, sym: symbol) {
    const symbol = new SchemeSymbol(sym);
    hidden_prop(symbol, "__literal__", name);
    return symbol;
  }

  return function (name: SchemeValue = null) {
    if (name instanceof SchemeSymbol) {
      if (name.is_gensym()) {
        return name;
      }
      name = name.valueOf();
    }
    if (is_gensym(name)) {
      // don't do double gynsyms in nested syntax-rules
      return new SchemeSymbol(name);
    }
    // use ES6 symbol as name for lips symbol (they are unique)
    if (name !== null) {
      return with_props(name, Symbol(`#:${name}`));
    }
    count++;
    return with_props(count, Symbol(`#:g${count}`));
  };
})();

// ----------------------------------------------------------------------
// :: mark a value as quoted data so the evaluator won't re-evaluate it.
// :: Pairs/symbols carry the __data__ flag; promises thread through.
// ----------------------------------------------------------------------
export function quote(value: SchemeValue): SchemeValue {
  if (is_promise(value)) {
    return value.then(quote);
  }
  if (is_pair(value) || value instanceof SchemeSymbol) {
    (value as SchemeValue)[__data__] = true;
  }
  return value;
}

// ----------------------------------------------------------------------
// :: an atom is any self-evaluating leaf (symbol, string, nil, char,
// :: number, boolean) — i.e., not a compound pair/structure.
// ----------------------------------------------------------------------
export function is_atom(obj: SchemeValue): boolean {
  return (
    obj instanceof SchemeSymbol ||
    SchemeString.isString(obj) ||
    is_nil(obj) ||
    obj === null ||
    obj instanceof SchemeCharacter ||
    obj instanceof SchemeExact ||
    obj instanceof SchemeInexact ||
    obj === true ||
    obj === false
  );
}
