import { wrappedOps } from "./bridge.js";
import { Environment } from "./Environment.js";
import { global_env, registerCxrResolver } from "./stdlib.js";
import { nil } from "./types.js";
import { SAFE_BUILTINS } from "./safe_builtins.js";
import { SchemeJSArray, readMember, hasMember, memberKeys, keywordAccessorResolver } from "./membrane.js";
import { is_false } from "./guards.js";
import { Pair } from "./Pair.js";
import { AValue } from "./AValue.js";
import { SchemeString } from "./SchemeString.js";
import { structuralEqual } from "./structural-equal.js";

const builtinCar = global_env.get("car", { throwError: false }) as Function;
const builtinCdr = global_env.get("cdr", { throwError: false }) as Function;
const builtinFilter = global_env.get("filter", { throwError: false }) as Function;
const builtinMap = global_env.get("map", { throwError: false }) as Function;
const builtinReduce = global_env.get("reduce", { throwError: false }) as Function;
const builtinJoin = global_env.get("join", { throwError: false }) as Function;

/**
 * Provenance taint for value-collapsing string combinators.
 *
 * `string-append`/`join` fold their AValue args down to a fresh JS string, which
 * drops the `.provenance` the producing inference stamped onto each input. That
 * breaks field-to-field wiring in the trace: a prompt template hole fed by
 * `(string-append "known:\n" (lines (cons seed acc)))` shows no edge back to
 * `seed`, because the collapsed string carries no point. Structure-PRESERVING ops
 * (`cons`/`list`) keep taint for free — the AValue stays a walkable member — so
 * only the collapsing ops need this. We union the EXISTING point ids of any AValue
 * reachable in the inputs (deep-walking list spines), never minting fresh ids, so
 * this stays idempotent under loop accumulation (cf. the fieldPoint O(n²) fix).
 */
function deepStringProvenance(...vals: unknown[]): Set<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) for (const p of v.provenance) acc.add(p);
    if (v instanceof Pair) {
      walk(v.car);
      walk(v.cdr);
    } else if (v instanceof SchemeJSArray) {
      for (const el of v.source) walk(el);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    }
  };
  for (const v of vals) walk(v);
  return acc;
}

/** Re-stamp a collapsed string result with provenance, only when there's taint to carry. */
function taintString(result: string, prov: Set<number>): string | SchemeString {
  return prov.size > 0 ? new SchemeString(result, prov) : result;
}

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

// `wrappedOps` is spread directly: the host-language verbs a block list once
// stripped (eval / load / set-obj! / set-special! / new / instanceof) no longer
// EXIST — the host-language sweep deleted them at the source rather than fencing
// them per-env. Non-existence is a stronger guarantee than a filter, and it
// removes the "two construction paths must agree on one block list" hazard the
// 2026-05-28 escape audit was built around. Safety is structural: the only host
// door is the always-on membrane (`@` / `@?` / `@keys` + sandboxedAccess).
export const sandboxedEnv = new Environment(
  "sandbox",
  {
    ...Object.fromEntries(SAFE_BUILTINS.map((name) => [name, global_env.get(name, { throwError: false })])),
    ...wrappedOps,
    nil,
    // SchemeJSArray-aware car/cdr — unwrap lazy array wrappers, delegate pairs to LIPS
    car: (list: any) => list instanceof SchemeJSArray ? list.at(0) : builtinCar(list),
    cdr: (list: any) => list instanceof SchemeJSArray
      ? (list.length <= 1 ? nil : new SchemeJSArray(list.source.slice(1)))
      : builtinCdr(list),
    // FL-dispatch: external Fantasy Land entities → async-aware FL helpers, LIPS types → Scheme
    // LIPS Pairs implement FL but must use scheme filter/map (FL impl inverts results)
    // LIPS lambdas are async; FL methods are sync. asyncFL* bridges this gap.
    filter: function filter(this: any, arg: any, list: any) {
      // Nil-tolerant: a `(first? …)`/`(if …)` that yielded #f or void flowing into a
      // filter resolves to the empty list, not a crash — so a multi-leaf proof can still
      // ground its OTHER leaves instead of losing the whole program to one absent read.
      // (Matches the `@` accessor, which already returns nil for a null object. nil/'()
      // is NOT caught here — it passes through to builtinFilter as a valid empty list.)
      if (list == null || is_false(list)) return nil;
      if (list && typeof list === "object" && !(list instanceof Pair) && list["fantasy-land/filter"]) {
        return asyncFLFilter(arg, list);
      }
      return builtinFilter.call(this, arg, list);
    },
    map: function map(this: any, fn: any, ...lists: any[]) {
      if (lists.length === 1 && (lists[0] == null || is_false(lists[0]))) return nil; // nil-tolerant (see filter)
      if (lists.length === 1 && !(lists[0] instanceof Pair) && lists[0]?.["fantasy-land/map"]) {
        return asyncFLMap(fn, lists[0]);
      }
      return builtinMap.call(this, fn, ...lists);
    },
    reduce: function reduce(this: any, fn: any, init: any, collection: any) {
      if (collection && typeof collection === "object" && !(collection instanceof Pair) && collection["fantasy-land/reduce"]) {
        return asyncFLReduce(fn, init, collection);
      }
      return builtinReduce.call(this, fn, init, collection);
    },
    // Polyglot member access — `@` / `@?` / `@keys` are the read/has/keys surface
    // of the interop protocol (Graal `InteropLibrary`). The implementation lives
    // in membrane.ts (`readMember`/`hasMember`/`memberKeys`), shared verbatim with
    // the `:key` keyword accessor — one protocol, two syntaxes. Origin-agnostic:
    // it reads a dict, a membrane-exposed foreign value, or an array uniformly.
    "@": readMember,
    "@?": hasMember,
    "@keys": memberKeys,
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
      return global_env.get("string->symbol", { throwError: false })
        ? global_env.get("string->symbol")(s)
        : Symbol.for(s);
    },

    // ── Numeric predicates ──
    "zero?": (n: any) => n === 0 || n?.valueOf?.() === 0,
    "positive?": (n: any) => (n?.valueOf?.() ?? n) > 0,
    "negative?": (n: any) => (n?.valueOf?.() ?? n) < 0,
    "max": (...args: any[]) => Math.max(...args.map((a: any) => a?.valueOf?.() ?? a)),
    "min": (...args: any[]) => Math.min(...args.map((a: any) => a?.valueOf?.() ?? a)),

    // ── String operations ──
    "string-length": (s: any) => (s?.__string__ ?? String(s)).length,
    "string-upcase": (s: any) => (s?.__string__ ?? String(s)).toUpperCase(),
    "string-downcase": (s: any) => (s?.__string__ ?? String(s)).toLowerCase(),
    "string-append": (...args: any[]) =>
      taintString(args.map((a: any) => a?.__string__ ?? String(a)).join(""), deepStringProvenance(...args)),
    // join collapses a list to one string — taint with the list elements' points
    // so `(join sep (cons seed …))` keeps wiring back to `seed`. Delegates the
    // actual joining to the LIPS builtin (handles list->array, separators, etc.).
    join: (separator: any, list: any) =>
      taintString(String(builtinJoin(separator, list)), deepStringProvenance(list)),
    "string-contains": (haystack: any, needle: any) =>
      (haystack?.__string__ ?? String(haystack)).includes(needle?.__string__ ?? String(needle)),
    "string-ref": (s: any, i: any) => (s?.__string__ ?? String(s))[i?.valueOf?.() ?? i] ?? nil,

    // ── Deep equality ──
    // Structural walk with an occurs-check (see structuralEqual) — replaces the
    // old JSON.stringify fallback that threw a native "circular structure" error
    // on cyclic input. Always returns a boolean.
    "equal?": (a: any, b: any) => structuralEqual(a, b, new Map()),

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
      return !is_false(test) ? body[body.length - 1] : nil;
    },
    "unless": function unless(this: any, ...args: any[]) {
      const [test, ...body] = args;
      return is_false(test) ? body[body.length - 1] : nil;
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

// The unbounded `c[ad]+r` catchall. SAFE_BUILTINS copies only a hand-maintained
// (and incomplete) slice of the family above; the resolver makes ANY accessor
// word the sweet lens can fuse resolve — without inheriting it (null parent).
registerCxrResolver(sandboxedEnv);
// The `:key` keyword accessor catchall (sibling to c[ad]+r). On the null-parent
// sandbox base too, so a `:`-prefixed symbol resolves to its `@`-alias pluck.
sandboxedEnv.registerResolver(keywordAccessorResolver);
