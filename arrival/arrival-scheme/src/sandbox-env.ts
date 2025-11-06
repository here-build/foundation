import {
  env as lipsGlobalEnv,
  Environment,
  LBigInteger,
  LCharacter,
  LComplex,
  LFloat,
  LNumber,
  LRational,
  LString,
  LSymbol,
  nil
} from "./lips";
import { RAMDA_FUNCTIONS } from "./ramda-functions";
import { SAFE_BUILTINS } from "./safe_builtins";

export const sandboxedEnv = new Environment(
  {
    ...Object.fromEntries(SAFE_BUILTINS.map((name) => [name, lipsGlobalEnv.get(name, { throwError: false })])),
    ...RAMDA_FUNCTIONS,
    nil,
    "@": (obj: any, key: any) => {
      if (obj == null) return nil;

      // Handle LIPS types (LSymbol, LString) - use valueOf() to get actual value
      // LSymbol and LString have valueOf() that returns the string value
      const rawKeyStr = key.valueOf?.() ?? key;
      if (rawKeyStr == null || rawKeyStr === nil) {
        return nil;
      }
      const keyStr = String(rawKeyStr).startsWith(":") ? String(rawKeyStr).replace(":", "") : String(rawKeyStr);
      let target = obj;
      while (![null, Object.prototype].includes(target)) {
        if (
          [LSymbol, LString, LNumber, LBigInteger, LCharacter, LComplex, LFloat, LRational, Environment].includes(
            target.constructor
          )
        ) {
          return nil;
        }
        if (Object.hasOwn(target, keyStr)) {
          return obj[keyStr] ?? nil;
        }
        target = target.constructor.prototype;
      }

      return nil;
    },
    tap: (fn: (x: any) => void) => (x: any) => {
      fn(x);
      return x;
    },
    length: (collection: any) => {
      // LIPS lists have their own length calculation
      if (collection && typeof collection === "object" && "car" in collection) {
        // Count LIPS list elements manually
        let count = 0;
        let current = collection;
        while (current?.constructor && current.constructor.name !== "Nil") {
          count++;
          current = current.cdr;
        }
        return count;
      }
      // JS arrays and other collections
      return Array.isArray(collection) ? collection.length : 0;
    }
  },
  null,
  "sandbox"
);
