// -------------------------------------------------------------------------
// :: String wrapper that handles copy and in-place change
// -------------------------------------------------------------------------
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import type { SchemeNumeric } from "./numbers.js";
import { markAsSandboxBoundary } from "./sandbox-boundary.js";
import { SchemeCharacter } from "./types.js";
import { typecheck } from "./utils/typecheck.js";

/**
 * Types that can be converted to a string value.
 */
type StringLike = string | SchemeString | { valueOf(): string };

/**
 * Types that can be used as numeric indices.
 */
type NumberLike = number | SchemeNumeric | { valueOf(): number };

/**
 * Types that can be used as characters.
 */
type CharLike = string | SchemeCharacter | { valueOf(): string };

export class SchemeString extends AValue {
  static __class__ = "string";
  readonly kind = "string" as const;

  __string__: string;

  constructor(
    string: SchemeCharacter[] | StringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
    this.__string__ = Array.isArray(string)
      ? string
          .map((x, i) => {
            typecheck("SchemeString", x, "character", i + 1);
            return x.toString();
          })
          .join("")
      : string.valueOf();
  }

  get length(): number {
    // R7RS strings are sequences of Unicode code points, not UTF-16 code units.
    // Spread iterates by code point so astral chars (emoji, U+10000+) count once.
    return [...this.__string__].length;
  }

  static isString(x: unknown): x is SchemeString | string {
    return x instanceof SchemeString || typeof x === "string";
  }

  *[Symbol.iterator]() {
    const chars = [...this.__string__];
    for (const char of chars) {
      yield new SchemeCharacter(char);
    }
  }

  serialize(): string {
    return this.valueOf();
  }

  freeze(): void {
    const string = this.__string__;
    delete (this as Partial<SchemeString>).__string__;
    Object.defineProperty(this, "__string__", {
      value: string,
      // Non-configurable + non-writable so a later re-defineProperty or
      // assignment can't defeat the freeze — frozen string literals are
      // immutable per R7RS § 6.7 (string-set!/string-fill! on a literal is an
      // error). `configurable: true` previously left the door open.
      configurable: false,
      writable: false,
      enumerable: true,
    });
  }

  get(n: NumberLike): string {
    typecheck("SchemeString::get", n, "number");
    return [...this.__string__][typeof n === "number" ? n : n.valueOf()];
  }

  cmp(string: StringLike): number {
    typecheck("SchemeString::cmp", string, "string");
    const a = this.valueOf();
    const b = string.valueOf();
    if (a < b) {
      return -1;
    } else if (a === b) {
      return 0;
    } else {
      return 1;
    }
  }

  // Setoid (Fantasy Land). REPRESENTATION-BLIND value equality: a boxed SchemeString equals BOTH
  // another SchemeString of the same content AND the same value UNBOXED (a plain JS string). A string
  // has no exact/inexact-style grade, so its identity is purely its characters — and the chain plane
  // boxes inconsistently (provenance-carrying op → boxed; literal/rosetta-unwrap → plain), so equal?
  // routinely meets a boxed string against a plain one. Comparing only `instanceof SchemeString` made
  // `(equal? boxed "x")` ⇒ #f, silently breaking every dedup/`member?` over derived strings (the
  // sift/closure.scm browser hang). `this.__string__ === other` lets a plain-string `other` match by
  // content and a non-string `other` (number/object) fall through to #f. structuralEqual consults the
  // Setoid before its valueOf check, so this is THE place string equality is decided.
  ["fantasy-land/equals"](other: unknown): boolean {
    return this.__string__ === (other instanceof SchemeString ? other.__string__ : other);
  }

  // Ord (Fantasy Land, extends Setoid). Lexicographic via JS `<=`, a total
  // code-unit order (totality/antisymmetry/transitivity/consistency-with-equals
  // all hold against the Setoid above). Non-SchemeString → false.
  ["fantasy-land/lte"](other: unknown): boolean {
    return other instanceof SchemeString && this.__string__ <= other.__string__;
  }

  // Functor (Fantasy Land) — map over the characters. Iterates by code point
  // (spread), so astral chars map as single graphemes. `f` receives and returns
  // a string char; the result is the joined string. (Migrated from the
  // fantasy-land-lips.ts monkey-patch — plan-2026-06-10-algebras-in-entities.md
  // wave 2.)
  ["fantasy-land/map"](f: (char: string) => string): SchemeString {
    return new SchemeString([...this.__string__].map(f).join(""));
  }

  // Semigroup (Fantasy Land) — string append. `this ⋄ other` concatenates the
  // two underlying strings. Associative; equality via the Setoid above.
  ["fantasy-land/concat"](other: SchemeString): SchemeString {
    return new SchemeString(this.__string__ + other.valueOf());
  }

  // Monoid (Fantasy Land) — the empty string is the identity for append.
  static ["fantasy-land/empty"](): SchemeString {
    return new SchemeString("");
  }

  // Applicative (Fantasy Land) — lift a value into a SchemeString.
  static ["fantasy-land/of"](value: unknown): SchemeString {
    return new SchemeString(String(value));
  }

  lower(): SchemeString {
    return new SchemeString(this.__string__.toLowerCase());
  }

  upper(): SchemeString {
    return new SchemeString(this.__string__.toUpperCase());
  }

  set(n: NumberLike, char: CharLike): void {
    typecheck("SchemeString::set", n, "number");
    typecheck("SchemeString::set", char, ["string", "character"]);
    const idx = typeof n === "number" ? n : n.valueOf();
    const charValue = char instanceof SchemeCharacter ? char.__char__ : char.valueOf();
    // Rebuild by code point, not UTF-16 unit, so replacing index k in a string
    // containing astral chars doesn't split a surrogate pair (R7RS § 6.7).
    const codepoints = [...this.__string__];
    codepoints[idx] = charValue;
    this.__string__ = codepoints.join("");
  }

  clone(): SchemeString {
    return new SchemeString(this.valueOf());
  }

  fill(char: CharLike): void {
    typecheck("SchemeString::fill", char, ["string", "character"]);
    const charValue = char instanceof SchemeCharacter ? char.valueOf() : char.valueOf();
    // Fill must preserve the code-point length, not the UTF-16 unit length —
    // a string of N astral chars stays N chars after string-fill! (R7RS § 6.7).
    const len = [...this.__string__].length;
    this.__string__ = charValue.repeat(len);
  }

  valueOf(): string {
    return this.__string__;
  }

  toString(): string {
    return this.__string__;
  }

  toJs(): string {
    return this.__string__;
  }

  withProvenance(p: ReadonlySet<number>): SchemeString {
    return new SchemeString(this.__string__, p);
  }
}

AValue.registerBoxer("string", (v, p) => new SchemeString(v as string, p));

// Dynamically wrap all String.prototype methods
{
  const ignore = new Set(["length", "constructor"]);
  const _keys = Object.getOwnPropertyNames(String.prototype).filter((name) => {
    return !ignore.has(name);
  });
  const wrap = (fn: (...args: unknown[]) => unknown) =>
    function (this: SchemeString, ...args: unknown[]) {
      return fn.apply(this.__string__, args);
    };
  for (const key of _keys) {
    const proto = SchemeString.prototype as unknown as Record<string, unknown>;
    const strProto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    proto[key] = wrap(strProto[key]);
  }
}

// ============================================================================
// SANDBOX BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): the loop above grafts EVERY method from
// `String.prototype` onto `SchemeString.prototype` as OWN enumerable
// properties — `.replace`, `.match`, `.split`, `.concat`, the entire surface.
// Because they're OWN (not inherited), the fast-path in `sandboxedAccess`
// returns them without checking any boundary. Symbol-to-field auto-resolution
// means a sandbox holding a SchemeString can reach every one of these via
// scheme property access. The methods themselves are harmless on the string
// payload, but the surface area is unaudited — any future graft (e.g. a
// method that returns the underlying object) becomes an exfiltration vector.
//
// Marking the class as a boundary lets `isSandboxBoundary(proto)` return true
// when the prototype-chain walk in `sandboxedAccess` reaches the SchemeString
// prototype, blocking the inherited surface. Own properties remain accessible
// (the fast path is untouched) — this is correct because grafted methods are
// own, so the boundary only blocks future inherited additions, not the
// current intended API. Defense-in-depth via the AValue base marker.
// ============================================================================
markAsSandboxBoundary(SchemeString);
