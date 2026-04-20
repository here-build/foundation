// -------------------------------------------------------------------------
// :: SchemeSymbol - Lisp symbol type
// -------------------------------------------------------------------------
import type { SchemeStringLike } from "./types.js";
import { isSchemeString, isString } from "./types.js";

type SchemeSymbolName = string | symbol;

export class SchemeSymbol {
  static __class__ = "symbol";
  // Interning table for string-named symbols
  static readonly list: Record<string, SchemeSymbol> = {};
  // Note: gensyms store their literal name at this[SchemeSymbol.literal]
  // We can't declare the index signature with esbuild
  // Special symbol markers
  static readonly literal = Symbol.for("__literal__");
  static readonly object = Symbol.for("__object__");
  declare __name__: SchemeSymbolName;

  constructor(name: SchemeSymbolName | SchemeStringLike) {
    // Unwrap SchemeStringLike to plain string
    const unwrapped: SchemeSymbolName = isSchemeString(name) ? name.valueOf() : name;

    // Return interned symbol if exists (for string names only)
    if (typeof unwrapped === "string" && SchemeSymbol.list[unwrapped] instanceof SchemeSymbol) {
      return SchemeSymbol.list[unwrapped];
    }

    this.__name__ = unwrapped;

    // Intern string-named symbols
    if (typeof unwrapped === "string") {
      SchemeSymbol.list[unwrapped] = this;
    }
  }

  // Check if symbol matches a name (string, SchemeSymbol, or RegExp)
  static is(symbol: unknown, name: string | SchemeSymbol | RegExp): boolean {
    return (
      symbol instanceof SchemeSymbol &&
      ((name instanceof SchemeSymbol && symbol.__name__ === name.__name__) ||
        (typeof name === "string" && symbol.__name__ === name) ||
        (name instanceof RegExp && typeof symbol.__name__ === "string" && name.test(symbol.__name__)))
    );
  }

  toString(quote?: boolean): string {
    if (isSymbol(this.__name__)) {
      return symbol_to_string(this.__name__);
    }
    const str = this.valueOf();
    // those special characters can be normal symbol when printed
    if (quote && typeof str === "string" && /(^;|[\s()[\]'])/.test(str)) {
      return `|${str}|`;
    }
    return String(str);
  }

  literal(): string {
    if (this.is_gensym()) {
      return (this as unknown as Record<symbol, string>)[SchemeSymbol.literal];
    }
    // Non-gensyms always have string names
    return this.__name__ as string;
  }

  /** Get dot-notation object parts for syntax-rules gensyms */
  objectParts(): string[] | undefined {
    return (this as unknown as Record<symbol, string[] | undefined>)[SchemeSymbol.object];
  }

  serialize(): SchemeSymbolName | [string] {
    if (isString(this.__name__)) {
      return this.__name__;
    }
    return [symbol_to_string(this.__name__ as symbol)];
  }

  valueOf(): SchemeSymbolName {
    // For symbols, return the symbol itself (used as environment keys)
    // For strings, return the string
    return this.__name__;
  }

  is_gensym(): boolean {
    return is_gensym(this.__name__);
  }
}

// -------------------------------------------------------------------------
// :: Helper functions for symbols
// -------------------------------------------------------------------------
function isSymbol(x: unknown): x is symbol {
  return typeof x === "symbol" || (typeof x === "object" && Object.prototype.toString.call(x) === "[object Symbol]");
}

function symbol_to_string(obj: symbol): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

function is_gensym(symbol: unknown): boolean {
  if (typeof symbol === "symbol") {
    return /^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}
