// -------------------------------------------------------------------------
// :: String wrapper that handles copy and in-place change
// -------------------------------------------------------------------------
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import type { SchemeNumeric } from "./numbers.js";
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
    return this.__string__.length;
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
      configurable: true,
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
    // Rebuild string with character at idx replaced
    const before = idx > 0 ? this.__string__.slice(0, idx) : "";
    const after = idx < this.__string__.length - 1 ? this.__string__.slice(idx + 1) : "";
    this.__string__ = before + charValue + after;
  }

  clone(): SchemeString {
    return new SchemeString(this.valueOf());
  }

  fill(char: CharLike): void {
    typecheck("SchemeString::fill", char, ["string", "character"]);
    const charValue = char instanceof SchemeCharacter ? char.valueOf() : char.valueOf();
    const len = this.__string__.length;
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
