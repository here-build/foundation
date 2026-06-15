import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "./interop-access.js";
import type { SchemeStringLike } from "./types.js";
import { isSchemeString, isString } from "./types.js";

type SchemeSymbolName = string | symbol;

/**
 * Provenance × interning invariant: `SchemeSymbol.list[name]` is the canonical
 * empty-provenance instance shared by every reader. `withProvenance` must NOT
 * replace it (that would stamp every other reader with one call-site's
 * provenance); instead it mints a fresh uninterned copy via this sentinel.
 * Safe because `SchemeSymbol.is` compares `__name__`, not reference.
 */
const UNINTERNED = Symbol("UNINTERNED");

export class SchemeSymbol extends AValue {
  static __class__ = "symbol";
  readonly kind = "symbol" as const;
  // Interning table for string-named symbols.
  // `Object.create(null)` (NOT `{}`): a plain object inherits Object.prototype,
  // so `(string->symbol "__proto__")` — string->symbol is inference-exposed —
  // would assign through the inherited setter and pollute Object.prototype.
  // A null-prototype map has no inherited keys/setters to walk into.
  static readonly list: Record<string, SchemeSymbol> = Object.create(null);
  // Note: gensyms store their literal name at this[SchemeSymbol.literal]
  // We can't declare the index signature with esbuild
  // Special symbol markers
  static readonly literal = Symbol.for("__literal__");
  static readonly object = Symbol.for("__object__");
  declare __name__: SchemeSymbolName;

  constructor(
    name: SchemeSymbolName | SchemeStringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    intern: symbol | true = true,
  ) {
    super(provenance);
    // Unwrap SchemeStringLike to plain string
    const unwrapped: SchemeSymbolName = isSchemeString(name) ? name.valueOf() : name;

    if (intern !== UNINTERNED && typeof unwrapped === "string" && SchemeSymbol.list[unwrapped] instanceof SchemeSymbol) {
      return SchemeSymbol.list[unwrapped];
    }

    this.__name__ = unwrapped;

    if (intern !== UNINTERNED && typeof unwrapped === "string") {
      SchemeSymbol.list[unwrapped] = this;
    }
  }

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

  // Setoid (Fantasy Land). Symbol ≡ symbol with the same `__name__` — `===`
  // works for both string names and gensym ES6 symbols (interned identity).
  // Mirrors `SchemeSymbol.is` (which compares `__name__`), preserving
  // structuralEqual / equal? behavior. (algebras-in-entities migration.)
  ["fantasy-land/equals"](other: unknown): boolean {
    return other instanceof SchemeSymbol && this.__name__ === other.__name__;
  }

  // Ord (Fantasy Land, extends Setoid). Lexicographic over STRING names.
  // A gensym's `__name__` is an ES6 symbol with no meaningful order — falling
  // back to `String(...)` gives a STABLE total order within a run (Symbol
  // toString is stable), so totality/antisymmetry/transitivity still hold.
  ["fantasy-land/lte"](other: unknown): boolean {
    return other instanceof SchemeSymbol && String(this.__name__) <= String(other.__name__);
  }

  is_gensym(): boolean {
    return is_gensym(this.__name__);
  }

  toJs(): string {
    // Apostrophe-prefix indicates "this is a scheme symbol, not a string."
    return `'${isString(this.__name__) ? this.__name__ : symbol_to_string(this.__name__ as symbol)}`;
  }

  /** See UNINTERNED sentinel doc. */
  withProvenance(p: ReadonlySet<number>): SchemeSymbol {
    return new SchemeSymbol(this.__name__, p, UNINTERNED);
  }
}

// ── Symbol helpers ──
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

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): SchemeSymbol carries a process-global intern
// table (`SchemeSymbol.list`) and tracks gensym/literal metadata via well-known
// symbols (`SchemeSymbol.literal`, `SchemeSymbol.object`). Symbol-to-field
// auto-resolution exposes any class-level or prototype-level property to
// inference-plane scheme — including the static `list` (read-write, would let inference-plane reads
// poison the intern table) and the literal/object metadata symbols.
// Marking the boundary blocks inherited-property access on instances; static
// access via `(.AValue.list)` is already blocked separately by the AValue
// non-export policy (see registry-poisoning tests in sandbox-escape.test.ts).
// ============================================================================
markInteropBoundary(SchemeSymbol);
