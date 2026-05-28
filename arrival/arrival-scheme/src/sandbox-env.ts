import { wrappedOps } from "./bridge.js";
import { Environment } from "./Environment.js";
import { global_env as lipsGlobalEnv, Nil, nil } from "./lips.js";
import { RAMDA_FUNCTIONS } from "./ramda-functions.js";
import { SAFE_BUILTINS } from "./safe_builtins.js";
import { sandboxedAccess, sandboxedHas, sandboxedKeys, NOT_FOUND, SandboxViolationError } from "./sandbox-boundary.js";
import { fromJS, SchemeJSArray, SchemeJSObject } from "./membrane.js";
import { Pair } from "./Pair.js";

const lipsCar = lipsGlobalEnv.get("car", { throwError: false }) as Function;
const lipsCdr = lipsGlobalEnv.get("cdr", { throwError: false }) as Function;
const lipsFilter = lipsGlobalEnv.get("filter", { throwError: false }) as Function;
const lipsMap = lipsGlobalEnv.get("map", { throwError: false }) as Function;
const lipsReduce = lipsGlobalEnv.get("reduce", { throwError: false }) as Function;

/**
 * Collect all leaf values from an FL Foldable using fantasy-land/reduce.
 * Returns values in traversal order (same order as map visits them).
 */
function flCollectValues(structure: any): any[] {
  const values: any[] = [];
  structure["fantasy-land/reduce"]((acc: any, val: any) => { values.push(val); return acc; }, null);
  return values;
}

/**
 * Unwrap LIPS internal types to JS equivalents for FL interop.
 * When LIPS lambdas produce SchemeExact/SchemeString/etc, FL structures
 * should store JS-native values, not LIPS internals.
 */
function unwrapLipsValue(v: any): any {
  if (v == null || typeof v !== "object") return v;
  const name = v.constructor?.name;
  if (name === "SchemeExact" || name === "SchemeInexact") return v.valueOf();
  if (name === "SchemeString") return v.__string__;
  if (name === "SchemeSymbol") return String(v.__name__);
  if (name === "Nil") return null;
  return v;
}

/**
 * FL dispatch helpers for async LIPS lambdas.
 *
 * LIPS lambdas always return Promises. FL methods are synchronous.
 * Strategy: collect values via FL reduce, apply async fn, cache results
 * by value identity, then reconstruct via FL method using cached lookups.
 * Value-based caching is order-independent (filter visits bottom-up,
 * reduce visits top-down — both get correct results from cache).
 */
async function asyncFLMap(fn: Function, structure: any): Promise<any> {
  const values = flCollectValues(structure);
  const cache = new Map<any, any>();
  await Promise.all(values.map(async (v) => {
    if (!cache.has(v)) {
      cache.set(v, unwrapLipsValue(await fn(v)));
    }
  }));
  return structure["fantasy-land/map"]((v: any) => cache.get(v));
}

async function asyncFLFilter(pred: Function, structure: any): Promise<any> {
  const values = flCollectValues(structure);
  const cache = new Map<any, any>();
  await Promise.all(values.map(async (v) => {
    if (!cache.has(v)) {
      cache.set(v, await pred(v));
    }
  }));
  return structure["fantasy-land/filter"]((v: any) => cache.get(v));
}

async function asyncFLReduce(fn: Function, init: any, structure: any): Promise<any> {
  const values = flCollectValues(structure);
  let acc = init;
  for (const val of values) {
    acc = await fn(acc, val);
  }
  return acc;
}

export const sandboxedEnv = new Environment(
  "sandbox",
  {
    ...RAMDA_FUNCTIONS,
    ...Object.fromEntries(SAFE_BUILTINS.map((name) => [name, lipsGlobalEnv.get(name, { throwError: false })])),
    ...wrappedOps,
    nil,
    // SchemeJSArray-aware car/cdr — unwrap lazy array wrappers, delegate pairs to LIPS
    car: (list: any) => list instanceof SchemeJSArray ? list.at(0) : lipsCar(list),
    cdr: (list: any) => list instanceof SchemeJSArray
      ? (list.length <= 1 ? nil : new SchemeJSArray(list.source.slice(1)))
      : lipsCdr(list),
    // FL-dispatch: external Fantasy Land entities → async-aware FL helpers, LIPS types → Scheme
    // LIPS Pairs implement FL but must use scheme filter/map (FL impl inverts results)
    // LIPS lambdas are async; FL methods are sync. asyncFL* bridges this gap.
    filter: function filter(this: any, arg: any, list: any) {
      if (list && typeof list === "object" && !(list instanceof Pair) && list["fantasy-land/filter"]) {
        return asyncFLFilter(arg, list);
      }
      return lipsFilter.call(this, arg, list);
    },
    map: function map(this: any, fn: any, ...lists: any[]) {
      if (lists.length === 1 && !(lists[0] instanceof Pair) && lists[0]?.["fantasy-land/map"]) {
        return asyncFLMap(fn, lists[0]);
      }
      return lipsMap.call(this, fn, ...lists);
    },
    reduce: function reduce(this: any, fn: any, init: any, collection: any) {
      if (collection && typeof collection === "object" && !(collection instanceof Pair) && collection["fantasy-land/reduce"]) {
        return asyncFLReduce(fn, init, collection);
      }
      return lipsReduce.call(this, fn, init, collection);
    },
    /**
     * Sandboxed field accessor.
     * Uses the sandbox boundary security model - blocks prototype chain escapes.
     */
    "@": (obj: any, key: any) => {
      if (obj == null) return nil;

      // Handle LIPS types (SchemeSymbol, SchemeString) - use valueOf() to get actual value
      const rawKeyStr = key.valueOf?.() ?? key;
      // `instanceof Nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)`
      // mints fresh Nil clones (types.ts:87). Reference-equality misses them, so a
      // Nil-valued key would skip this guard and end up String()-cast at line 128,
      // yielding "[object Object]" as the lookup key. Mirrors guards.ts:is_nil
      // (Tier-1 fix in 5f7f9e46a).
      if (rawKeyStr == null || rawKeyStr instanceof Nil) {
        return nil;
      }

      // Strip leading colon for keyword-style access
      const keyStr = String(rawKeyStr).startsWith(":") ? String(rawKeyStr).slice(1) : String(rawKeyStr);

      // Block _-prefixed internals
      if (keyStr.startsWith("_")) return nil;

      try {
        // Unwrap membrane wrappers — properties live on .source, not the wrapper
        const rawObj = obj instanceof SchemeJSObject ? obj.source
          : obj instanceof SchemeJSArray ? obj.source
          : obj;
        const result = sandboxedAccess(rawObj, keyStr);
        if (result === NOT_FOUND) {
          return nil;
        }
        // Wrap JS arrays as SchemeJSArray so car/cdr work on property access results
        if (Array.isArray(result)) {
          return new SchemeJSArray(result);
        }
        return fromJS(result);
      } catch (e) {
        if (e instanceof SandboxViolationError) {
          // Security violation - return nil instead of exposing error details
          return nil;
        }
        throw e;
      }
    },

    /**
     * Check if object has a property (sandboxed).
     */
    "@?": (obj: any, key: any) => {
      if (obj == null) return false;

      const rawKeyStr = key.valueOf?.() ?? key;
      // `instanceof Nil`: see "@" above — Nil-valued keys must short-circuit before
      // String()-cast leaks "[object Object]" into the host's property lookup.
      if (rawKeyStr == null || rawKeyStr instanceof Nil) {
        return false;
      }

      const keyStr = String(rawKeyStr).startsWith(":") ? String(rawKeyStr).slice(1) : String(rawKeyStr);
      const rawObj = obj instanceof SchemeJSObject ? obj.source : obj;
      return sandboxedHas(rawObj, keyStr);
    },

    /**
     * Get object's own keys (sandboxed).
     */
    "@keys": (obj: any) => {
      if (obj == null) return [];
      const rawObj = obj instanceof SchemeJSObject ? obj.source : obj;
      return sandboxedKeys(rawObj);
    },
    // ── Type conversion (R7RS standard, models expect these) ──
    "symbol->string": (sym: any) => {
      if (sym && typeof sym === "object" && "__name__" in sym) {
        const name = sym.__name__;
        return typeof name === "string" ? name : String(name);
      }
      return String(sym);
    },
    "string->symbol": (str: any) => {
      const s = typeof str === "string" ? str : str?.__string__ ?? String(str);
      return lipsGlobalEnv.get("string->symbol", { throwError: false })
        ? lipsGlobalEnv.get("string->symbol")(s)
        : Symbol.for(s);
    },

    // ── Numeric predicates ──
    "zero?": (n: any) => n === 0 || n?.valueOf?.() === 0,
    "positive?": (n: any) => (n?.valueOf?.() ?? n) > 0,
    "negative?": (n: any) => (n?.valueOf?.() ?? n) < 0,
    "max": (...args: any[]) => Math.max(...args.map((a: any) => a?.valueOf?.() ?? a)),
    "min": (...args: any[]) => Math.min(...args.map((a: any) => a?.valueOf?.() ?? a)),
    "modulo": (a: any, b: any) => (a?.valueOf?.() ?? a) % (b?.valueOf?.() ?? b),

    // ── String operations ──
    "string-length": (s: any) => (s?.__string__ ?? String(s)).length,
    "string-upcase": (s: any) => (s?.__string__ ?? String(s)).toUpperCase(),
    "string-downcase": (s: any) => (s?.__string__ ?? String(s)).toLowerCase(),
    "string-append": (...args: any[]) => args.map((a: any) => a?.__string__ ?? String(a)).join(""),
    "string-contains": (haystack: any, needle: any) =>
      (haystack?.__string__ ?? String(haystack)).includes(needle?.__string__ ?? String(needle)),
    "string-ref": (s: any, i: any) => (s?.__string__ ?? String(s))[i?.valueOf?.() ?? i] ?? nil,

    // ── Deep equality ──
    "equal?": (a: any, b: any) => {
      if (a === b) return true;
      if (a?.valueOf?.() === b?.valueOf?.()) return true;
      if (a?.__string__ != null && b?.__string__ != null) return a.__string__ === b.__string__;
      return JSON.stringify(a) === JSON.stringify(b);
    },

    // ── List aliases (models expect these) ──
    "first": (list: any) => list?.car ?? (Array.isArray(list) ? list[0] : nil),
    "last": (list: any) => {
      if (Array.isArray(list)) return list[list.length - 1] ?? nil;
      let current = list;
      while (current?.cdr?.constructor?.name !== "Nil" && current?.cdr != null) {
        current = current.cdr;
      }
      return current?.car ?? nil;
    },
    "second": (list: any) => list?.cdr?.car ?? (Array.isArray(list) ? list[1] : nil),
    "third": (list: any) => list?.cdr?.cdr?.car ?? (Array.isArray(list) ? list[2] : nil),

    // ── Control flow (R7RS) ──
    "when": function when(this: any, ...args: any[]) {
      // (when test expr ...) — if test is truthy, evaluate exprs, return last
      // This needs to be a macro but we can approximate for sandbox use
      const [test, ...body] = args;
      return test ? body[body.length - 1] : nil;
    },
    "unless": function unless(this: any, ...args: any[]) {
      const [test, ...body] = args;
      return !test ? body[body.length - 1] : nil;
    },

    // ── Association lists ──
    "assoc": (key: any, alist: any) => {
      if (!alist) return nil;
      const items = Array.isArray(alist) ? alist : [];
      // Convert LIPS pairs to traversable
      if (!Array.isArray(alist) && alist?.car) {
        let current = alist;
        while (current?.car) {
          const pair = current.car;
          if (pair?.car?.valueOf?.() === key?.valueOf?.() || pair?.car === key) return pair;
          current = current.cdr;
        }
        return nil;
      }
      return items.find((pair: any) => pair?.[0] === key || pair?.car === key) ?? nil;
    },

    // ── Sort ──
    "sort": (list: any, comparator?: any) => {
      const arr = Array.isArray(list) ? [...list] : [];
      if (!Array.isArray(list) && list?.car) {
        let current = list;
        while (current?.car) {
          arr.push(current.car);
          current = current.cdr;
        }
      }
      if (comparator) {
        arr.sort((a: any, b: any) => comparator(a, b));
      } else {
        arr.sort();
      }
      return arr;
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
    },
  },
  null,
);
