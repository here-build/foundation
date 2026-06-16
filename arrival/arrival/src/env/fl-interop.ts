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
import { AValue, unionProvenance } from "../values/AValue.js";

// ── FL protocol surface ──────────────────────────────────────────────────────
// Fantasy-Land structures are opaque carriers — we only ever touch their FL
// methods, never their internals. Model them as that minimal interface, not `any`.
interface FantasyLand {
  "fantasy-land/reduce"<A>(f: (acc: A, val: unknown) => A, init: A): A;
  "fantasy-land/map"(f: (val: unknown) => unknown): unknown;
  "fantasy-land/filter"(p: (val: unknown) => unknown): unknown;
}

type Callable = (...args: unknown[]) => unknown;

// ── Lazy builtin capture ────────────────────────────────────────────────────
// Read once on first use, after bootstrap, when global_env is fully assembled.
let builtinCar: Callable | undefined;
let builtinCdr: Callable | undefined;
let builtinFilter: Callable | undefined;
let builtinMap: Callable | undefined;
let builtinReduce: Callable | undefined;

// Comparison builtins — bridged Operators (=/</>/<=/>=). Captured lazily for the
// nil-tolerant overrides below (the operator membrane throws on a nil operand at
// codec-match time, before the op body runs; we intercept that one case).
let builtinNumEq: Callable | undefined;
let builtinLt: Callable | undefined;
let builtinGt: Callable | undefined;
let builtinLte: Callable | undefined;
let builtinGte: Callable | undefined;

function captureBuiltins(): void {
  if (builtinCar !== undefined) return;
  builtinCar = global_env.get("car", { throwError: false }) as Callable;
  builtinCdr = global_env.get("cdr", { throwError: false }) as Callable;
  builtinFilter = global_env.get("filter", { throwError: false }) as Callable;
  builtinMap = global_env.get("map", { throwError: false }) as Callable;
  builtinReduce = global_env.get("reduce", { throwError: false }) as Callable;
  builtinNumEq = global_env.get("=", { throwError: false }) as Callable;
  builtinLt = global_env.get("<", { throwError: false }) as Callable;
  builtinGt = global_env.get(">", { throwError: false }) as Callable;
  builtinLte = global_env.get("<=", { throwError: false }) as Callable;
  builtinGte = global_env.get(">=", { throwError: false }) as Callable;
}

// nil/'() is truthy in Scheme, so `is_false` does NOT catch it — a nil operand must
// be detected structurally. A null/undefined JS value or a Scheme Nil counts as the
// "absent value" that should compare to #f rather than crash the whole proof.
function isNilOperand(v: unknown): boolean {
  return v == null || (v as { constructor?: { name?: string } })?.constructor?.name === "Nil";
}

// ── FL async-dispatch helpers (module-private) ───────────────────────────────

/**
 * Collect all leaf values from an FL Foldable using fantasy-land/reduce.
 * Returns values in traversal order (same order as map visits them).
 */
function flCollectValues(structure: FantasyLand): unknown[] {
  const values: unknown[] = [];
  structure["fantasy-land/reduce"]((acc: null, val: unknown) => { values.push(val); return acc; }, null);
  return values;
}

/**
 * Unwrap LIPS internal types to JS equivalents for FL interop.
 * When LIPS lambdas produce SchemeExact/SchemeString/etc, FL structures
 * should store JS-native values, not LIPS internals.
 */
function unwrapLipsValue(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const box = v as { constructor?: { name?: string }; valueOf(): unknown; __string__?: unknown; __name__?: unknown };
  const name = box.constructor?.name;
  if (name === "SchemeExact" || name === "SchemeInexact") return box.valueOf();
  if (name === "SchemeString") return box.__string__;
  if (name === "SchemeSymbol") return String(box.__name__);
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
async function asyncFLMap(fn: (v: unknown) => unknown, structure: FantasyLand): Promise<unknown> {
  const values = flCollectValues(structure);
  const cache = new Map<unknown, unknown>();
  await Promise.all(values.map(async (v) => {
    if (!cache.has(v)) {
      cache.set(v, unwrapLipsValue(await fn(v)));
    }
  }));
  return structure["fantasy-land/map"]((v: unknown) => cache.get(v));
}

async function asyncFLFilter(pred: (v: unknown) => unknown, structure: FantasyLand): Promise<unknown> {
  const values = flCollectValues(structure);
  const cache = new Map<unknown, unknown>();
  await Promise.all(values.map(async (v) => {
    if (!cache.has(v)) {
      cache.set(v, await pred(v));
    }
  }));
  return structure["fantasy-land/filter"]((v: unknown) => !is_false(cache.get(v)));
}

async function asyncFLReduce(fn: (acc: unknown, val: unknown) => unknown, init: unknown, structure: FantasyLand): Promise<unknown> {
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
  car: (list: unknown) => {
    captureBuiltins();
    return list instanceof SchemeJSArray ? list.at(0) : builtinCar!(list);
  },
  cdr: (list: unknown) => {
    captureBuiltins();
    return list instanceof SchemeJSArray
      ? (list.length <= 1 ? nil : new SchemeJSArray(list.source.slice(1)))
      : builtinCdr!(list);
  },
  // FL-dispatch: external Fantasy Land entities → async-aware FL helpers, LIPS types → Scheme
  // LIPS Pairs implement FL but must use scheme filter/map (FL impl inverts results)
  // LIPS lambdas are async; FL methods are sync. asyncFL* bridges this gap.
  filter: function filter(this: unknown, arg: (v: unknown) => unknown, list: unknown) {
    captureBuiltins();
    // Nil-tolerant: a `(first? …)`/`(if …)` that yielded #f or void flowing into a
    // filter resolves to the empty list, not a crash — so a multi-leaf proof can still
    // ground its OTHER leaves instead of losing the whole program to one absent read.
    // (Matches the `@` accessor, which already returns nil for a null object. nil/'()
    // is NOT caught here — it passes through to builtinFilter as a valid empty list.)
    if (list == null || is_false(list)) return nil;
    if (list && typeof list === "object" && !(list instanceof Pair) && (list as Partial<FantasyLand>)["fantasy-land/filter"]) {
      return asyncFLFilter(arg, list as FantasyLand);
    }
    return builtinFilter!.call(this, arg, list);
  },
  map: function map(this: unknown, fn: (v: unknown) => unknown, ...lists: unknown[]) {
    captureBuiltins();
    if (lists.length === 1 && (lists[0] == null || is_false(lists[0]))) return nil; // nil-tolerant (see filter)
    if (lists.length === 1 && !(lists[0] instanceof Pair) && (lists[0] as Partial<FantasyLand> | undefined)?.["fantasy-land/map"]) {
      return asyncFLMap(fn, lists[0] as FantasyLand);
    }
    return builtinMap!.call(this, fn, ...lists);
  },
  reduce: function reduce(this: unknown, fn: (acc: unknown, val: unknown) => unknown, init: unknown, collection: unknown) {
    captureBuiltins();
    if (collection && typeof collection === "object" && !(collection instanceof Pair) && (collection as Partial<FantasyLand>)["fantasy-land/reduce"]) {
      return asyncFLReduce(fn, init, collection as FantasyLand);
    }
    return builtinReduce!.call(this, fn, init, collection);
  },

  // ── Nil-tolerant comparisons (plane-local) ──────────────────────────────────
  // The operator membrane rejects a nil operand at codec-match time (the `=`/`<`/…
  // Operators declare `in: [SchemeNum]`), so a comparison against an absent value
  // (a nil PID, an unmatched lookup) throws before the body runs — forcing models
  // to write defensive `(if (nil? x) … (= x …))` guards. Completing the plane's
  // existing nil-tolerance grain (see filter/map): a nil operand resolves the
  // comparison to #f rather than crashing the proof. Non-nil operands delegate to
  // the bridged builtin unchanged (provenance flows through the operator path).
  "=": function numEq(...args: unknown[]) {
    captureBuiltins();
    if (args.some(isNilOperand)) return false;
    return builtinNumEq!(...args);
  },
  "<": function lt(...args: unknown[]) {
    captureBuiltins();
    if (args.some(isNilOperand)) return false;
    return builtinLt!(...args);
  },
  ">": function gt(...args: unknown[]) {
    captureBuiltins();
    if (args.some(isNilOperand)) return false;
    return builtinGt!(...args);
  },
  "<=": function lte(...args: unknown[]) {
    captureBuiltins();
    if (args.some(isNilOperand)) return false;
    return builtinLte!(...args);
  },
  ">=": function gte(...args: unknown[]) {
    captureBuiltins();
    if (args.some(isNilOperand)) return false;
    return builtinGte!(...args);
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
    // Return a Scheme LIST, not a raw JS array — a Lisp `sort` whose result the sibling
    // `map`/`filter` reject ("Expecting pair or nil, got array") is an inconsistency. The elements
    // are already Scheme values (we just reordered them), so build the list shallow (no re-boxing);
    // an empty result is nil.
    return Pair.fromArray(arr, false);
  },

  length: (collection: any) => {
    // Collect elements so the count can carry their provenance (V: "provenance
    // everything; exclusion should not be possible in teleological mode"). A
    // `(count …)`/`(length …)` the seal can't sign — even though every row that
    // produced it was grounded — is exactly the hole the teleological seal forbids.
    const elements: unknown[] = [];
    if (collection && typeof collection === "object" && "car" in collection) {
      // LIPS list — walk the spine.
      let current = collection;
      while (current?.constructor && current.constructor.name !== "Nil") {
        elements.push(current.car);
        current = current.cdr;
      }
    } else if (collection instanceof SchemeJSArray) {
      // Lazy JS-array wrapper (what `@`/the membrane hand the inference plane).
      // `.source` is raw JS — its elements carry no provenance — but the count
      // is still correct (the old code returned 0 here, a latent miscount).
      elements.push(...collection.source);
    } else if (Array.isArray(collection)) {
      elements.push(...collection);
    }
    const count = elements.length;
    const inputs = elements.filter((e): e is AValue => e instanceof AValue);
    if (inputs.length === 0) return count;
    const prov = unionProvenance(inputs);
    return prov.size === 0 ? count : AValue.fromJs(count, prov);
  },
};

export default new EnvCapability("scheme/fl-interop", {
  symbols: Object.fromEntries(Object.entries(FL_INTEROP_OPS).map(([k, v]) => [k, { value: v }])),
});
