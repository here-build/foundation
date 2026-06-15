import { is_undef } from "./guards.js";
import { SchemeString } from "./values/SchemeString.js";
import { SchemeSymbol } from "./values/SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "./values/numbers.js";
import { Pair } from "./values/Pair.js";
import { SchemeCharacter, nil } from "./values/types.js";

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

// ── Deserialization revivers, keyed by class tag ──
// SchemeString/SchemeCharacter are reached through getters so the live binding is read lazily —
// referencing them eagerly here would form a module-init cycle with the types modules.
const serialization_map = {
  pair: ([car, cdr]) => new Pair(car, cdr),
  number(value) {
    if (SchemeString.isString(value)) {
      return new SchemeExact(parseBigInt(value.valueOf(), 10));
    }
    if (typeof value === "bigint") {
      return new SchemeExact(value);
    }
    if (typeof value === "number") {
      // Safe-integer JS numbers round-trip exactly as bigint; anything else stays inexact float.
      return Number.isSafeInteger(value) ? new SchemeExact(BigInt(value)) : new SchemeInexact(value);
    }
    return value; // already a wrapped number
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
// Serialized tags are the class's INDEX into this array, not its name — a small-integer `@` keeps the
// JSON compact. Index assignment is therefore positional: never reorder `serialization_map`.
export const available_class = Object.keys(serialization_map);
export const class_map = {};

function resolve_name(i) {
  return available_class[i];
}

// Revives the compact form: `{"@": classIndex, "#": payload}` → the corresponding Scheme value.
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
