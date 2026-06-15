// ----------------------------------------------------------------------
// Helper to parse integer string with radix to BigInt
import { is_undef } from "./guards.js";
import { SchemeString } from "./SchemeString.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { SchemeCharacter, nil } from "./types.js";

export function parseBigInt(str: string, radix: number = 10): bigint {
  str = str.trim();
  const negative = str.startsWith("-");
  if (negative || str.startsWith("+")) {
    str = str.slice(1);
  }
  let result = 0n;
  const base = BigInt(radix);
  for (const char of str.toLowerCase()) {
    const digit = Number.parseInt(char, radix);
    TypeError.invariant(!Number.isNaN(digit), `Invalid digit '${char}' for radix ${radix}`);
    result = result * base + BigInt(digit);
  }
  return negative ? -result : result;
}

// -------------------------------------------------------------------------
// :: Serialization
// -------------------------------------------------------------------------
// Use getters to defer access to SchemeString and SchemeCharacter, avoiding circular dependency issues
const serialization_map = {
  pair: ([car, cdr]) => new Pair(car, cdr),
  number(value) {
    if (SchemeString.isString(value)) {
      // Parse number string
      return new SchemeExact(parseBigInt(value.valueOf(), 10));
    }
    if (typeof value === "bigint") {
      return new SchemeExact(value);
    }
    if (typeof value === "number") {
      return Number.isSafeInteger(value) ? new SchemeExact(BigInt(value)) : new SchemeInexact(value);
    }
    // For already-wrapped numbers, return as-is
    return value;
  },
  regex([pattern, flag]) {
    return new RegExp(pattern, flag);
  },
  nil() {
    return nil;
  },
  symbol(value) {
    if (SchemeString.isString(value)) {
      return new SchemeSymbol(value);
    } else if (Array.isArray(value)) {
      return new SchemeSymbol(Symbol.for(value[0]));
    }
  },
  get string() {
    return SchemeString;
  },
  get character() {
    return SchemeCharacter;
  },
};
// -------------------------------------------------------------------------
// class mapping to create smaller JSON
export const available_class = Object.keys(serialization_map);
export const class_map = {};

function resolve_name(i) {
  return available_class[i];
}

// -------------------------------------------------------------------------
export function unserialize(string) {
  return JSON.parse(string, (_, object) => {
    if (object && typeof object === "object" && !is_undef(object["@"])) {
      const cls = resolve_name(object["@"]);
      if (serialization_map[cls]) {
        return serialization_map[cls](object["#"]);
      }
    }
    return object;
  });
}
