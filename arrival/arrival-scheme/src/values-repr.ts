// Value / symbol representation helpers — shared by the stdlib forms, the
// genMacroWrapper bridge, and the macro engine (syntax-rules.ts:
// macro_expand / extract_patterns / transform_syntax).
//
// Extracted from the original monolith (the since-split lips.ts) so the macro
// engine imports them from this sibling LEAF rather than back-edging into the
// stdlib — the cycle the module split exists to prevent. syntax-rules.ts now
// imports directly from here.
//
// `is_promise` comes from guards.ts (a *false leaf*: it carries a pre-existing
// transitive path to Environment), which is type-only at the values-repr edge,
// so no runtime cycle. Promoting is_promise into the value-guards true-leaf is
// a separate task — it would drag QuotedPromise → guards into the leaf until
// QuotedPromise is itself repointed.
// ----------------------------------------------------------------------
import { is_promise } from "./guards.js";
import { SchemeString } from "./values/SchemeString.js";
import { SchemeSymbol } from "./values/SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "./values/numbers.js";
import { __data__ } from "./values/primitives.js";
import { SchemeCharacter } from "./values/types.js";
import type { SchemeValue } from "./values/types.js";
import { is_nil, is_pair } from "./values/value-guards.js";

/** Non-enumerable, non-writable Symbol-keyed slot — used for metadata that must
 *  not surface in enumeration or be clobbered (e.g. a gensym's `__literal__`). */
export function hidden_prop(obj: SchemeValue, name: string, value: SchemeValue): void {
  Object.defineProperty(obj, Symbol.for(name), {
    get: () => value,
    set: () => {},
    configurable: false,
    enumerable: false,
  });
}

/** Gensym JS symbols are recognized by the `#:` name prefix — the marker
 *  `gensym` stamps below. (Mirrors SchemeSymbol.is_gensym.) */
export function is_gensym(symbol: SchemeValue): boolean {
  if (typeof symbol === "symbol") {
    return !!/^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

/** Mint a hygienic SchemeSymbol backed by a unique ES6 Symbol (uniqueness is
 *  what guarantees no capture in macro expansion). Idempotent on an already-gensym
 *  input — avoids double-gensym in nested syntax-rules. */
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
