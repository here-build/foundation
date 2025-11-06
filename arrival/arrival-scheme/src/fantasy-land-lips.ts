/**
 * Fantasy Land Monkey-Patching for LIPS Classes
 *
 * Makes LIPS data structures (Pair, LString, etc.) Fantasy Land compatible
 * so Ramda functions work seamlessly with LIPS classes.
 *
 * Implements Fantasy Land protocols:
 * - Functor (map)
 * - Filterable (filter)
 * - Foldable (reduce)
 * - Traversable (traverse)
 */

import { env as lipsGlobalEnv, LString, nil, Pair } from "./lips";

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
  concat: "fantasy-land/concat"
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
    }
  });

  Pair[FL.of] = function of(value: any) {
    return Pair(value, nil);
  };
}

/**
 * Patch LString class with Fantasy Land protocols
 */
function patchLStringClass(): void {
  LString.prototype[FL.map] = function (f: Fn) {
    return LString([...this.valueOf()].map(f).join(""));
  };

  // Add static of method
  LString[FL.of] = function (value: any) {
    return LString(String(value));
  };
}

function mapPair(f: Fn, pair: any): any {
  if (!pair || pair === nil) return nil;
  return Pair(f(pair.car), mapPair(f, pair.cdr));
}

function filterPair(predicate: Fn, pair: any): any {
  if (!pair || pair === nil) return nil;

  const restFiltered = filterPair(predicate, pair.cdr);

  return predicate(pair.car) ? Pair(pair.car, restFiltered) : restFiltered;
}

function reducePair(f: Fn, initial: any, pair: any): any {
  if (!pair || pair === nil) return initial;

  return reducePair(f, f(initial, pair.car), pair.cdr);
}

function traversePair(of: Fn, f: Fn, pair: any): any {
  if (!pair || pair === nil) return of(nil);

  const mappedCar = f(pair.car);
  const mappedCdr = traversePair(of, f, pair.cdr);

  return mappedCar?.[FL.ap] ? mappedCar[FL.ap](mappedCdr) : of(Pair(mappedCar, mappedCdr));
}

function chainPair(f: Fn, pair: any): any {
  const concat = lipsGlobalEnv.get("append", { throwError: false });

  if (!pair || pair === nil) return nil;

  const mapped = f(pair.car);
  const chained = chainPair(f, pair.cdr);

  return concat ? concat(mapped, chained) : mapped;
}
