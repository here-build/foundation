// Ramda functions exposed to LIPS environment
import * as R from "ramda";
import * as RA from "ramda-adjunct";

import { env as globalEnv, nil, Pair } from "./lips";

type Fn = (...args: any[]) => any;

// Helper: Check if value is LIPS Pair
const isLipsPair = (x: any): boolean => x && typeof x === "object" && "car" in x && "cdr" in x;

// Polymorphic map - works with LIPS Pairs, FL entities, and JS arrays
function polymorphicMap(fn: Fn, collection: any): any {
  // Fantasy Land compatible entity
  if (collection && typeof collection === "object" && typeof collection["fantasy-land/map"] === "function") {
    return collection["fantasy-land/map"](fn);
  }
  // todo actually the smartest thing we can do is to add "fantasy-land/map" behavior to Pair, nil and others
  if (isLipsPair(collection)) {
    return Pair(fn(collection.car), polymorphicMap(fn, collection.cdr));
  }

  if (collection === nil) {
    return nil;
  }

  return collection[Symbol.iterator] ? R.map((value) => polymorphicMap(fn, value), collection) : fn(collection);
}

const catchEither = (fn: () => any) => {
  try {
    return Pair(fn(), nil);
  } catch (error: any) {
    return Pair(nil, error?.message ?? error);
  }
};

const isSafeNumber = (val: number | bigint) => Number.isSafeInteger(val) || !Number.isFinite(val) || Number.isNaN(val);

// our goal here is to make enough of redundancy to make basically every intent variation possible.
// like "totalic functions" but more of totalic environment - better to handle each variation of intent possible,
// rather than forcing it into the spec; that's why all variations - lisp, scheme, clojure, haskell, etc - are kinda supported
export const RAMDA_FUNCTIONS = {
  map: polymorphicMap,
  fmap: R.map,
  traverse: R.traverse,
  // Fantasy Land Applicative
  "apply-to": R.ap,
  "lift-a2": (R as any).liftN(2),
  "lift-a3": (R as any).liftN(3),
  // Fantasy Land Monad (chain/flatMap)
  chain: R.chain,
  "flat-map": R.chain,
  flatten: R.flatten,
  // Core functional combinators (multiple traditions)
  compose: R.compose,
  comp: R.compose, // Short form
  "∘": R.compose, // Mathematical symbol

  pipe: R.pipe,
  thread: R.pipe, // Threading mental model
  "|>": R.pipe, // Pipe operator style
  flow: R.pipe, // Flow-based thinking

  curry: R.curry,
  partial: R.partial,
  flip: R.flip,
  identity: R.identity,
  id: R.identity, // Short form
  always: R.always,
  constant: R.always, // Alternative naming

  // List operations that preserve mathematical structure
  head: R.head,
  first: R.head, // Alternative naming
  "safe-head": (list: any[]) => R.head(list || []),

  // LIPS compatibility - car/cdr that work with both LIPS lists and JS arrays
  car: (collection: any) => {
    // LIPS Pair
    if (collection && typeof collection === "object" && "car" in collection) {
      return collection.car;
    }
    // JS Array or other iterable
    return R.head(collection);
  },

  cdr: (collection: any) => {
    // LIPS Pair
    if (collection && typeof collection === "object" && "cdr" in collection) {
      return collection.cdr;
    }
    // JS Array
    return R.tail(collection);
  },

  tail: R.tail,
  rest: R.tail, // Alternative naming
  "safe-tail": (list: any[]) => R.tail(list || []),

  init: R.init,
  last: R.last,
  "safe-last": (list: any[]) => R.last(list || []),

  // Length function with LIPS compatibility
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
    return R.length(collection || []);
  },

  take: R.take,
  drop: R.drop,
  slice: R.slice,
  append: R.append,
  prepend: R.prepend,
  concat: R.concat,
  join: R.join,

  // Type coercion resilience
  "ensure-array": (x: any) => (Array.isArray(x) ? x : [x]),
  "ensure-string": (x: any) => String(x || ""),
  "to-number": (x: any) => Number(x) || 0,
  "to-int": (x: any) => Number.parseInt(String(x), 10) || 0,

  // Predicates and filtering (multiple mental models)
  all: R.all,
  every: R.all,
  any: R.any,
  some: R.any,
  none: R.none,

  // Polymorphic filter - works with LIPS Pairs, FL entities, and JS arrays
  filter: function filter(predicate: Fn, collection: any) {
    if (collection && typeof collection === "object" && collection["fantasy-land/filter"]) {
      return collection["fantasy-land/filter"](predicate);
    }
    // LIPS Pair - recursively filter
    if (isLipsPair(collection)) {
      if (collection.cdr === nil && collection.car === undefined) {
        // Empty list
        return collection;
      }

      const restFiltered = filter(predicate, collection.cdr);

      return predicate(collection.car) ? Pair(collection.car, restFiltered) : restFiltered;
    }

    if (collection === nil) {
      return collection;
    }

    // JS arrays and other Ramda-compatible collections
    return R.filter(predicate as any, collection);
  },

  // Explicit versions for when you want specific behavior
  "r-filter": R.filter, // Ramda filter for JS arrays
  "lips-filter": null, // Will be set to LIPS filter if available
  select: R.filter, // SQL-style
  where: R.filter, // Query-style
  keep: R.filter, // Retention mental model

  reject: R.reject,
  remove: R.reject,
  exclude: R.reject,

  partition: R.partition,
  "split-by": R.partition,

  find: R.find,
  locate: R.find,
  search: R.find,
  "find-index": R.findIndex,
  "find-last": R.findLast,
  "find-last-index": R.findLastIndex,

  // Polymorphic reduce - works with LIPS Pairs, FL entities, and JS arrays
  reduce: (fn: Fn, initial: any, collection: any): any => {
    // Fantasy Land compatible entity
    if (collection && typeof collection === "object" && collection["fantasy-land/reduce"]) {
      return collection["fantasy-land/reduce"](fn, initial);
    }
    // LIPS Pair - recursively reduce
    if (isLipsPair(collection)) {
      if (collection.cdr === nil && collection.car === undefined) {
        // Empty list
        return initial;
      }

      const accumulated = fn(initial, collection.car);
      return RAMDA_FUNCTIONS.reduce(fn, accumulated, collection.cdr);
    }

    if (collection === nil) {
      return initial;
    }

    // JS arrays and other Ramda-compatible collections
    return R.reduce(fn as any, initial, collection);
  },

  // Transformation and reduction (multiple paradigms)
  fold: (fn: Fn, initial: any, collection: any) => RAMDA_FUNCTIONS.reduce(fn, initial, collection), // Haskell tradition
  accumulate: (fn: Fn, initial: any, collection: any) => RAMDA_FUNCTIONS.reduce(fn, initial, collection), // Descriptive
  aggregate: (fn: Fn, initial: any, collection: any) => RAMDA_FUNCTIONS.reduce(fn, initial, collection), // SQL-style

  "reduce-right": R.reduceRight,
  "fold-right": R.reduceRight,

  "reduce-by": R.reduceBy,
  "group-by": R.groupBy,
  classify: R.groupBy, // Categorization mental model
  "count-by": R.countBy,
  tally: R.countBy,

  sort: R.sort,
  order: R.sort,
  "sort-by": R.sortBy,
  "order-by": R.sortBy,
  "sort-with": R.sortWith,

  // Object operations (for component/style manipulation)
  // Property access - multiple mental models
  prop: R.prop,
  get: R.prop,
  access: R.prop,
  fetch: R.prop,

  // Path navigation - different conceptual frameworks
  path: R.path,
  "get-in": R.path,
  navigate: R.path,
  dig: R.path,

  // Safe property access (resilience patterns)
  "prop-or": R.propOr,
  "path-or": R.pathOr,
  "safe-prop": (key: string, obj: any) => R.prop(key, obj || {}),
  "safe-path": (path: (string | number)[], obj: any) => R.path(path, obj || {}),

  // Existence checking - various philosophical approaches
  has: R.has,
  contains: R.has,
  "exists?": R.has,
  "present?": R.has,
  "has-path": R.hasPath,

  props: R.props,
  paths: R.paths,
  pick: R.pick,
  omit: R.omit,
  keys: R.keys,
  values: R.values,
  toPairs: R.toPairs,
  fromPairs: R.fromPairs,

  // Logic and predicates
  equals: R.equals,
  is: R.is,
  "is-nil": R.isNil,
  "is-empty": R.isEmpty,
  "default-to": R.defaultTo,
  cond: R.cond,
  when: R.when,
  unless: R.unless,
  "if-else": R.ifElse,

  // String operations
  split: R.split,
  match: R.match,
  test: R.test,
  replace: R.replace,
  "to-lower": R.toLower,
  "to-upper": R.toUpper,
  trim: R.trim,

  // Math operations
  add: (a, b) => {
    if (typeof a === "number" && typeof b === "number" && isSafeNumber(Number(a) + Number(b))) {
      return a + b;
    }
    if (["bigint", "number"].includes(typeof a) && ["bigint", "number"].includes(typeof b)) {
      return BigInt(a) + BigInt(b);
    }
    return globalEnv.get("+")(a, b);
  },
  subtract: (a, b) => {
    if (typeof a === "number" && typeof b === "number" && isSafeNumber(Number(a) - Number(b))) {
      return a - b;
    }
    if (["bigint", "number"].includes(typeof a) && ["bigint", "number"].includes(typeof b)) {
      return BigInt(a) - BigInt(b);
    }
    return globalEnv.get("-")(a, b);
  },
  multiply: (a, b) => {
    if (typeof a === "number" && typeof b === "number" && isSafeNumber(Number(a) * Number(b))) {
      return a * b;
    }
    if (["bigint", "number"].includes(typeof a) && ["bigint", "number"].includes(typeof b)) {
      return BigInt(a) * BigInt(b);
    }
    return globalEnv.get("*")(a, b);
  },
  divide: (a, b) => {
    if (typeof a === "number" && typeof b === "number" && isSafeNumber(Number(a) / Number(b))) {
      return a / b;
    }
    if (["bigint", "number"].includes(typeof a) && ["bigint", "number"].includes(typeof b)) {
      return BigInt(a) / BigInt(b);
    }
    return globalEnv.get("/")(a, b);
  },
  modulo: (a, b) => {
    if (typeof a === "number" && typeof b === "number" && isSafeNumber(Number(a) % Number(b))) {
      return a % b;
    }
    if (["bigint", "number"].includes(typeof a) && ["bigint", "number"].includes(typeof b)) {
      return BigInt(a) % BigInt(b);
    }
    return globalEnv.get("%")(a, b);
  },
  negate: (a) => {
    if (typeof a === "number" && isSafeNumber(-Number(a))) {
      return -a;
    }
    if (["bigint", "number"].includes(typeof a)) {
      return -BigInt(a);
    }
    return globalEnv.get("-")(a);
  },
  // todo rewrite other math functions like above
  min: R.min,
  max: R.max,
  clamp: R.clamp,

  // Comparison
  gt: R.gt,
  gte: R.gte,
  lt: R.lt,
  lte: R.lte,
  // todo needs review
  // // Ramda-adjunct type checks and utilities (Fantasy Land compatible)
  // // Dual naming for maximum compatibility
  // "is-function": RA.isFunction,
  // "is-function?": RA.isFunction,
  // "function?": RA.isFunction,
  //
  // "is-array": RA.isArray,
  // "is-array?": RA.isArray,
  // "array?": RA.isArray,
  //
  // "is-object": RA.isObject,
  // "is-object?": RA.isObject,
  // "object?": RA.isObject,
  //
  // "is-string": RA.isString,
  // "is-string?": RA.isString,
  // "string?": RA.isString,
  //
  // "is-number": RA.isNumber,
  // "is-number?": RA.isNumber,
  // "number?": RA.isNumber,
  //
  // "is-boolean": RA.isBoolean,
  // "is-boolean?": RA.isBoolean,
  // "boolean?": RA.isBoolean,
  //
  // "is-non-empty": RA.isNonEmptyArray,
  // "is-non-empty?": RA.isNonEmptyArray,
  // "non-empty?": RA.isNonEmptyArray,
  //
  // "is-not-nil": RA.isNotNil,
  // "is-not-nil?": RA.isNotNil,
  // "not-nil?": RA.isNotNil,
  //
  // "nil?": R.isNil,
  //
  // "empty?": R.isEmpty,

  compact: RA.compact,

  // Error boundary patterns (resilience for S-expression evaluation). Either-style return
  "try-prop": (key: string, obj: any) => catchEither(() => R.prop(key, obj)),
  "try-path": (path: (string | number)[], obj: any) => catchEither(() => R.path(path, obj)),
  "try-apply": (fn: Fn, ...args: any[]) => catchEither(() => fn(...args)),

  // Safe operations that return null instead of throwing
  "maybe-prop": (key: string, obj: any) => {
    try {
      return R.prop(key, obj);
    } catch {
      return null;
    }
  },

  "maybe-path": (path: (string | number)[], obj: any) => {
    try {
      return R.path(path, obj);
    } catch {
      return null;
    }
  }
};
