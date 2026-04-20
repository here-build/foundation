/**
 * Core Scheme types extracted from lips.ts
 * These are the fundamental data types for the Scheme implementation.
 */
import invariant from "tiny-invariant";

// SchemeValue is the generic type for any Scheme value
// Scheme is inherently dynamic - uses `any` for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemeValue = any;

// -------------------------------------------------------------------------
// :: SchemeStringLike interface - duck-typing for SchemeString class
// :: Placed first because other types reference it
// -------------------------------------------------------------------------
export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

// SchemeString type guard - works with both interface and actual class
export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

// Combined string check
export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// -------------------------------------------------------------------------
// :: Nil - the empty list singleton
// -------------------------------------------------------------------------

// Forward declaration for Pair (implemented in lips.ts)
// This allows Nil.append to return the right type without circular dependency
export interface PairLike<Car = unknown, Cdr = unknown> {
  car: Car;
  cdr: Cdr;
}

// Pair constructor type - will be set by lips.ts
let PairConstructor: new (car: unknown, cdr: unknown) => PairLike;

export function setPairConstructor(ctor: new (car: unknown, cdr: unknown) => PairLike) {
  PairConstructor = ctor;
}

export class Nil {
  static __class__ = "nil";

  toString(): string {
    return "()";
  }

  valueOf(): undefined {
    return undefined;
  }

  serialize(): 0 {
    return 0;
  }

  to_object(): Record<string, never> {
    return {};
  }

  append(x: unknown): PairLike {
    return new PairConstructor(x, nil);
  }

  to_array(): [] {
    return [];
  }
}

export const nil = new Nil();

// -------------------------------------------------------------------------
// :: SchemeCharacter - Scheme character type
// -------------------------------------------------------------------------
const characters: Record<string, string> = {
  alarm: "\u0007",
  backspace: "\u0008",
  delete: "\u007F",
  escape: "\u001B",
  newline: "\n",
  null: "\u0000",
  return: "\r",
  space: " ",
  tab: "\t",
  // new symbols from ASCII table in SRFI-175
  dle: "\u0010",
  soh: "\u0001",
  dc1: "\u0011",
  stx: "\u0002",
  dc2: "\u0012",
  etx: "\u0003",
  dc3: "\u0013",
  eot: "\u0004",
  dc4: "\u0014",
  enq: "\u0005",
  nak: "\u0015",
  ack: "\u0006",
  syn: "\u0016",
  bel: "\u0007",
  etb: "\u0017",
  bs: "\u0008",
  can: "\u0018",
  ht: "\u0009",
  em: "\u0019",
  lf: "\u000A",
  sub: "\u001A",
  vt: "\u000B",
  fs: "\u001C",
  ff: "\u000C",
  gs: "\u001D",
  cr: "\u000D",
  rs: "\u001E",
  so: "\u000E",
  us: "\u001F",
  si: "\u000F",
  esc: "\u001B",
  del: "\u007F",
};

export { characters };

export class SchemeCharacter {
  static __class__ = "character";
  // Named character mappings
  static readonly __names__: Record<string, string> = characters;
  static readonly __rev_names__: Record<string, string> = (() => {
    const rev: Record<string, string> = {};
    for (const key of Object.keys(characters)) {
      rev[characters[key]] = key;
    }
    return rev;
  })();
  readonly __char__: string;
  readonly __name__?: string;

  constructor(char: string | SchemeStringLike) {
    let charValue = isSchemeString(char) ? char.valueOf() : char;
    let name: string | undefined;

    if ([...charValue].length > 1) {
      // this is a named character
      charValue = charValue.toLowerCase();
      // this should never happen - parser doesn't allow undefined named characters
      invariant(SchemeCharacter.__names__[charValue], "Internal: Unknown named character");
      name = charValue;
      charValue = SchemeCharacter.__names__[charValue];
    } else {
      name = SchemeCharacter.__rev_names__[charValue];
    }

    this.__char__ = charValue;
    if (name) {
      this.__name__ = name;
    }
  }

  toUpperCase(): SchemeCharacter {
    return new SchemeCharacter(this.__char__.toUpperCase());
  }

  toLowerCase(): SchemeCharacter {
    return new SchemeCharacter(this.__char__.toLowerCase());
  }

  toString(): string {
    return `#\\${this.__name__ || this.__char__}`;
  }

  valueOf(): string {
    return this.__char__;
  }

  serialize(): string {
    return this.__char__;
  }
}
