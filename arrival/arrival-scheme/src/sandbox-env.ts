import { wrappedOps } from "./bridge.js";
import { Environment } from "./Environment.js";
import { global_env, registerCxrResolver } from "./stdlib.js";
import { Nil, nil } from "./types.js";
import { RAMDA_FUNCTIONS } from "./ramda-functions.js";
import { SAFE_BUILTINS } from "./safe_builtins.js";
import { sandboxedAccess, sandboxedHas, sandboxedKeys, NOT_FOUND, SandboxViolationError } from "./sandbox-boundary.js";
import { fromJS, SchemeJSArray, SchemeJSObject } from "./membrane.js";
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

// ============================================================================
// FORBIDDEN_IN_SANDBOX — direct-spread defense (task #43)
// ============================================================================
// War story (2026-05-28 audit): the sandbox had TWO surfaces leaking forbidden
// names into user code.
//
//   (1) Allowlist path: `PURE_SCHEME_BINDINGS` in modules/pure-scheme.ts. Task
//       #39 banned `eval` from that allowlist — see the "INTENTIONALLY OMITTED"
//       block at pure-scheme.ts:251-266. Closed.
//
//   (2) Direct-spread path: THIS file. `sandboxedEnv` was constructed by
//       spreading `...wrappedOps` directly (bridge.ts:327 export). `wrappedOps`
//       includes `eval` (bridge.ts:1430 — `eval(expr, env?) { evaluate(expr,
//       { env: env || global_env }) }`). Sandbox code calling `(eval x)`
//       with no second argument fell back to `global_env` — the FULLY
//       UNSANDBOXED global env containing every LIPS bootstrap entry. From
//       there, `(eval (quote +))` returned an unwrapped JS function;
//       `(eval (quote set-obj!))` handed the sandbox arbitrary host-property-
//       write capability. Task #43 (this fix) closes that path by stripping
//       `eval` from the spread.
//
// Defense in depth: even though only `eval` is currently in `wrappedOps`,
// future wrappedOps additions could re-expose other escape vectors. The set
// below is the canonical block list — each entry's specific escape vector
// is documented inline.
// The SINGLE, enforced block list (S8-CORE unification). Exported so the public
// sandbox entry point (sandbox.ts via modules/pure-scheme.ts) re-exports THIS
// Set rather than maintaining a parallel advisory array that nothing consulted.
// Adding/removing a name here is the one lever that changes what the sandbox
// strips from `wrappedOps`.
export const FORBIDDEN_IN_SANDBOX = new Set([
  // The primary escape vector this fix closes. With `env || global_env`
  // fallback, `(eval (quote name))` reaches any global LIPS binding —
  // including `+`, `load`, `set-obj!`, the whole surface. Eval-with-explicit-
  // env still works for non-sandbox callers; sandbox callers no longer have
  // `eval` at all.
  "eval",
  // Loads + evaluates source from a file/URL. If ever added to wrappedOps,
  // it's a direct path to arbitrary code execution outside the sandbox.
  "load",
  // Mutates arbitrary properties on arbitrary JS objects. Combined with any
  // path to a host object reference, this is direct host-state mutation.
  "set-obj!",
  // Constructs Special-form bindings in the host environment. Lets sandbox
  // code install host-level macros that intercept future evaluation.
  "set-special!",
  // `(new Cls args...)` reflectively constructs JS classes. Combined with
  // any object reference, lets sandbox code instantiate arbitrary host
  // constructors (Function, Worker, fetch handlers, etc.).
  "new",
  // `(instanceof obj Cls)` exposes host prototype identity. Information
  // disclosure on its own; combined with `new`, enables type-confusion
  // attacks against host membrane checks.
  "instanceof",
]);

const safeWrappedOps = Object.fromEntries(
  Object.entries(wrappedOps).filter(([k]) => !FORBIDDEN_IN_SANDBOX.has(k)),
);

export const sandboxedEnv = new Environment(
  "sandbox",
  {
    ...RAMDA_FUNCTIONS,
    ...Object.fromEntries(SAFE_BUILTINS.map((name) => [name, global_env.get(name, { throwError: false })])),
    ...safeWrappedOps,
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
        // SchemeJSObject is the membrane wrapper — route through its `.get`
        // so the cached, provenance-stamped entry surfaces (spec §5.3:
        // `(@ obj "key")` carries the key's tag, which after Option C deep-
        // stamping at the rosetta boundary IS the wrapper's provenance).
        // Identity is stable: `(eq? (@ x :a) (@ x :a))` returns #t.
        if (obj instanceof SchemeJSObject) {
          return obj.get(keyStr);
        }
        // SchemeJSArray + raw JS objects fall through to inline access —
        // arrays don't carry provenance through indexed access today; raw
        // JS objects are escaped from the sandbox path (rosetta-emitted
        // values are always SchemeJSObject post-deep-stamp).
        const rawObj = obj instanceof SchemeJSArray ? obj.source : obj;
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
