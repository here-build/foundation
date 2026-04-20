/**
 * Fantasy Land Monkey-Patching for LIPS Classes
 *
 * Makes LIPS data structures (Pair, SchemeString, etc.) Fantasy Land compatible
 * so Ramda functions work seamlessly with LIPS classes.
 *
 * Implements Fantasy Land protocols:
 * - Functor (map)
 * - Filterable (filter)
 * - Foldable (reduce)
 * - Traversable (traverse)
 */

// Import directly from source files to avoid circular dependency with lips.ts
import { SchemeString } from "./LString.js";
import { Pair } from "./Pair.js";
import { nil } from "./types.js";

// Lazy getter for lipsGlobalEnv to avoid circular dependency
// Only called at runtime in chainPair, not during module initialization
function getLipsEnv() {
  // Dynamic require at runtime - lips.ts should be fully loaded by now
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./lips").global_env;
  } catch {
    return;
  }
}

type Fn = (...args: any[]) => any;

// Fantasy Land method names
const FL = {
  map: "fantasy-land/map",
  filter: "fantasy-land/filter",
  reduce: "fantasy-land/reduce",
  traverse: "fantasy-land/traverse",
  of: "fantasy-land/of",
  ap: "fantasy-land/ap",
  chain: "fantasy-land/chain",
  concat: "fantasy-land/concat",
};

export function applyFantasyLandPatches(): void {
  patchPairClass();
  patchLStringClass();
}

function patchPairClass(): void {
  Object.assign(Pair.prototype, {
    [FL.map](f: Fn) {
      return mapPair(f, this);
    },
    [FL.filter](predicate: Fn) {
      return filterPair(predicate, this);
    },
    [FL.reduce](f: Fn, initial: any) {
      return reducePair(f, initial, this);
    },
    [FL.traverse](of: Fn, f: Fn) {
      return traversePair(of, f, this);
    },
    [FL.chain](f: Fn) {
      return chainPair(f, this);
    },
  });

  Pair[FL.of] = function of(value: any) {
    return new Pair(value, nil);
  };
}

/**
 * Patch SchemeString class with Fantasy Land protocols
 */
function patchLStringClass(): void {
  (SchemeString.prototype as any)[FL.map] = function (this: SchemeString, f: Fn) {
    return new SchemeString([...this.valueOf()].map(f).join(""));
  };

  // Add static of method
  (SchemeString as any)[FL.of] = function (value: any) {
    return new SchemeString(String(value));
  };
}

function mapPair(f: Fn, pair: any): any {
  if (!pair || pair === nil) return nil;
  return new Pair(f(pair.car), mapPair(f, pair.cdr));
}

function filterPair(predicate: Fn, pair: any): any {
  if (!pair || pair === nil) return nil;

  const restFiltered = filterPair(predicate, pair.cdr);

  return predicate(pair.car) ? new Pair(pair.car, restFiltered) : restFiltered;
}

function reducePair(f: Fn, initial: any, pair: any): any {
  if (!pair || pair === nil) return initial;

  return reducePair(f, f(initial, pair.car), pair.cdr);
}

function traversePair(of: Fn, f: Fn, pair: any): any {
  if (!pair || pair === nil) return of(nil);

  const mappedCar = f(pair.car);
  const mappedCdr = traversePair(of, f, pair.cdr);

  return mappedCar?.[FL.ap] ? mappedCar[FL.ap](mappedCdr) : of(new Pair(mappedCar, mappedCdr));
}

function chainPair(f: Fn, pair: any): any {
  const lipsEnv = getLipsEnv();
  const concat = lipsEnv?.get("append", { throwError: false });

  if (!pair || pair === nil) return nil;

  const mapped = f(pair.car);
  const chained = chainPair(f, pair.cdr);

  return concat ? concat(mapped, chained) : mapped;
}
