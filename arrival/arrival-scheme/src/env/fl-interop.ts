/**
 * FL / array-interop overlay — the genuine interop members of the inference-plane
 * base env (`inferenceEnv`), carved out of the hand-built overlay in
 * `inference-env.ts`. These are the members with NO equivalent in the assembled
 * base: the SchemeJSArray-aware `car`/`cdr` and the Fantasy-Land-dispatching,
 * nil-tolerant `filter`/`map`/`reduce`.
 *
 * Why a separate capability and not an inline spread: this overlay is a real pack
 * that bridges two impedance mismatches the base env does NOT —
 *   1. Lazy JS-array wrappers (`SchemeJSArray`) that must unwrap before LIPS car/cdr.
 *   2. External Fantasy-Land structures whose FL methods are SYNC while LIPS lambdas
 *      are ASYNC (the asyncFL* helpers bridge collect→apply→reconstruct).
 *
 * LAZY BUILTIN CAPTURE (load-order discipline): the `car`/`cdr`/`filter`/`map`/
 * `reduce` it overrides delegate to the assembled base versions (`builtinCar` …).
 * Those are read from `global_env` LAZILY — at first symbol invocation, never
 * eagerly at module top-level. Eager `global_env.get("car")` at module load races
 * the async assembly of the value-domain clusters onto global_env: a load-order
 * miss captures `undefined` (the exact bug a prior `SAFE_BUILTINS` eager snapshot
 * hit). At call time global_env is fully assembled, so the read is safe — and this
 * pack is assembled onto inferenceEnv only AFTER global_env's native assembly + the
 * base packs, so the builtins are live before any symbol here can fire.
 */

import { EnvCapability } from "./capability.js";
import { global_env } from "../stdlib.js";
import { nil } from "../values/types.js";
import { SchemeJSArray } from "../membrane.js";
import { is_false } from "../eval/guards.js";
import { Pair } from "../values/Pair.js";

// ── Lazy builtin capture ────────────────────────────────────────────────────
// Read once on first use, after bootstrap, when global_env is fully assembled.
let builtinCar: Function | undefined;
let builtinCdr: Function | undefined;
let builtinFilter: Function | undefined;
let builtinMap: Function | undefined;
let builtinReduce: Function | undefined;

function captureBuiltins(): void {
  if (builtinCar !== undefined) return;
  builtinCar = global_env.get("car", { throwError: false }) as Function;
  builtinCdr = global_env.get("cdr", { throwError: false }) as Function;
  builtinFilter = global_env.get("filter", { throwError: false }) as Function;
  builtinMap = global_env.get("map", { throwError: false }) as Function;
  builtinReduce = global_env.get("reduce", { throwError: false }) as Function;
}

// ── FL async-dispatch helpers (module-private) ───────────────────────────────

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
  return structure["fantasy-land/filter"]((v: any) => !is_false(cache.get(v)));
}

async function asyncFLReduce(fn: Function, init: any, structure: any): Promise<any> {
  const values = flCollectValues(structure);
  let acc = init;
  for (const val of values) {
    acc = await fn(acc, val);
  }
  return acc;
}

// ── The interop overlay symbols ──────────────────────────────────────────────

export const FL_INTEROP_OPS = {
  // SchemeJSArray-aware car/cdr — unwrap lazy array wrappers, delegate pairs to LIPS
  car: (list: any) => {
    captureBuiltins();
    return list instanceof SchemeJSArray ? list.at(0) : builtinCar!(list);
  },
  cdr: (list: any) => {
    captureBuiltins();
    return list instanceof SchemeJSArray
      ? (list.length <= 1 ? nil : new SchemeJSArray(list.source.slice(1)))
      : builtinCdr!(list);
  },
  // FL-dispatch: external Fantasy Land entities → async-aware FL helpers, LIPS types → Scheme
  // LIPS Pairs implement FL but must use scheme filter/map (FL impl inverts results)
  // LIPS lambdas are async; FL methods are sync. asyncFL* bridges this gap.
  filter: function filter(this: any, arg: any, list: any) {
    captureBuiltins();
    // Nil-tolerant: a `(first? …)`/`(if …)` that yielded #f or void flowing into a
    // filter resolves to the empty list, not a crash — so a multi-leaf proof can still
    // ground its OTHER leaves instead of losing the whole program to one absent read.
    // (Matches the `@` accessor, which already returns nil for a null object. nil/'()
    // is NOT caught here — it passes through to builtinFilter as a valid empty list.)
    if (list == null || is_false(list)) return nil;
    if (list && typeof list === "object" && !(list instanceof Pair) && list["fantasy-land/filter"]) {
      return asyncFLFilter(arg, list);
    }
    return builtinFilter!.call(this, arg, list);
  },
  map: function map(this: any, fn: any, ...lists: any[]) {
    captureBuiltins();
    if (lists.length === 1 && (lists[0] == null || is_false(lists[0]))) return nil; // nil-tolerant (see filter)
    if (lists.length === 1 && !(lists[0] instanceof Pair) && lists[0]?.["fantasy-land/map"]) {
      return asyncFLMap(fn, lists[0]);
    }
    return builtinMap!.call(this, fn, ...lists);
  },
  reduce: function reduce(this: any, fn: any, init: any, collection: any) {
    captureBuiltins();
    if (collection && typeof collection === "object" && !(collection instanceof Pair) && collection["fantasy-land/reduce"]) {
      return asyncFLReduce(fn, init, collection);
    }
    return builtinReduce!.call(this, fn, init, collection);
  },

  // ── Array-aware list accessors ───────────────────────────────────────────────
  // Nil-tolerant accessors that work over both JS arrays (what `@`/SchemeJSArray
  // hand the inference plane) and LIPS pairs. Self-contained — no builtin capture.

  // ── List aliases (models expect these) ──
  first: (list: any) => list?.car ?? (Array.isArray(list) ? list[0] : nil),
  last: (list: any) => {
    if (Array.isArray(list)) return list[list.length - 1] ?? nil;
    let current = list;
    while (current?.cdr?.constructor?.name !== "Nil" && current?.cdr != null) {
      current = current.cdr;
    }
    return current?.car ?? nil;
  },
  second: (list: any) => list?.cdr?.car ?? (Array.isArray(list) ? list[1] : nil),
  third: (list: any) => list?.cdr?.cdr?.car ?? (Array.isArray(list) ? list[2] : nil),

  // ── Association lists ──
  assoc: (key: any, alist: any) => {
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
  sort: (list: any, comparator?: any) => {
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
};

export default new EnvCapability("scheme/fl-interop", {
  symbols: Object.fromEntries(Object.entries(FL_INTEROP_OPS).map(([k, v]) => [k, { value: v }])),
});
