/**
 * Rosetta Environment Extension
 *
 * Extends LIPS Environment with automatic LIPS ↔ JS conversion for seamless interop.
 * Provides Environment.defineRosetta() for declarative function wrapping.
 */

import invariant from "tiny-invariant";

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./AValue.js";
import { SchemeBool } from "./LBool.js";
import { SchemeJSArray, SchemeJSObject } from "./membrane.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { Nil, nil } from "./types.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
  /**
   * When true, calls to this rosetta become provenance points — the result's
   * provenance is `{ inv.id }` rather than the union of input provenances.
   * Implies `withContext: true`: the wrapper needs `ctx.currentInvocation` to
   * read the id, and explicit opt-out is rejected via invariant so the failure
   * mode is loud (vs silently losing provenance-point marking).
   *
   * Marked by flipping `isProvenancePoint` on the currentInvocation — the
   * trace-side exit-tap reads this flag in computeProvenance (see
   * arrival-chain/trace.ts). The flag is the contract. We prefer the
   * invocation's own `markProvenancePoint()` method when present (the real
   * Invocation is a MobX observable; the method is an action, so the write is
   * legal under strict-mode), falling back to a direct set for plain POJOs.
   * Structural duck-typing on `{ id; isProvenancePoint?; markProvenancePoint?() }`
   * keeps the cycle one-way — no import of arrival-chain or MobX from here.
   */
  provenancePoint?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
  /**
   * When true, the rosetta receives the current EvalContext as its LAST
   * argument (after all scheme args, post-lipsToJs conversion). The
   * evaluator detects this via a `__withCtx` flag on the produced wrapper
   * and appends `ctx` at call time. Off by default — back-compat.
   */
  withContext?: boolean;
}

/**
 * Structural shape of EvalContext.currentInvocation that this module relies
 * on. The full Invocation type lives in arrival-chain/trace.ts (and the
 * evaluator treats it as `unknown`); we duck-type here to avoid pulling in
 * a circular dependency.
 */
interface InvocationLike {
  id: number;
  isProvenancePoint?: boolean;
  /**
   * arrival-chain's Invocation provides this as a MobX action; a plain test POJO
   * doesn't. Preferred over a raw `isProvenancePoint` write so the flag flips
   * inside an action — MobX strict-mode (on in the studio) forbids the bare write.
   */
  markProvenancePoint?(): void;
  /**
   * Bind arbitrary node metadata (e.g. a `.prompt`'s file / model / inputs — the
   * card's display story), called directly by the rosetta fn at call time. Same
   * action-vs-POJO story as `markProvenancePoint`. The metadata is trace-side only
   * (read by the render) — it never crosses back into scheme.
   */
  setMetadata?(meta: unknown): void;
}

interface CtxWithInvocation {
  currentInvocation?: InvocationLike;
}

const isLipsPair = (x: any): boolean => x && typeof x === "object" && "car" in x && "cdr" in x;

export function lipsToJs(value: any, options: RosettaOptions = {}): any {
  // Handle null/undefined
  // `instanceof Nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)`
  // mints fresh Nil clones (types.ts:87) — reference-equality misses them and would
  // leak the clone back into the JS caller. Mirrors guards.ts:is_nil (the Tier-1 fix
  // in 5f7f9e46a) which adopted the same class-based check.
  if (value == null || value instanceof Nil) return value;

  // Handle JS arrays (convert elements recursively)
  if (Array.isArray(value)) {
    return value.map((record) => lipsToJs(record, options));
  }

  // Handle ExactNumber and InexactNumber
  if (value instanceof SchemeExact) {
    const val = value.valueOf();
    if (options.forceBigInt) {
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    // For exact integers, return number if safe
    if (value.denom === 1n) {
      if (value.num >= BigInt(Number.MIN_SAFE_INTEGER) && value.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value.num);
      }
      return value.num; // Return bigint for large numbers
    }
    // For rationals, return the float value
    return val;
  }

  if (value instanceof SchemeInexact) {
    // InexactNumber is always a JS float, just return real part (or complex handling if needed)
    if (value.imag !== 0) {
      // For complex numbers, return as object or just real part depending on use case
      return { real: value.real, imag: value.imag };
    }
    return value.real;
  }

  // Unwrap SchemeJSObject to source object
  if (value instanceof SchemeJSObject) {
    return lipsToJs(value.source, options);
  }

  // Unwrap SchemeJSArray to JS array
  if (value instanceof SchemeJSArray) {
    return value.source.map((el: any) => lipsToJs(el, options));
  }

  // Unwrap SchemeBool to JS primitive
  if (value instanceof SchemeBool) {
    return value.value;
  }

  // Handle SchemeString and Pair
  if (value && typeof value === "object") {
    if ("__string__" in value && typeof value.__string__ === "string") {
      return value.__string__;
    }
    // since for lisp empty list and nil is same entity, we specifically handle this scenario as
    // "if eventually cdr is nil, and we're materializing the array, it's array tail"
    if (isLipsPair(value)) {
      const head = lipsToJs(value.car, options);
      const tail = lipsToJs(value.cdr, options) ?? [];
      if (Array.isArray(tail)) {
        return [head, ...tail];
      } else if (tail instanceof Nil) {
        // Class check, not `=== nil`: a provenance-bearing Nil clone (see Nil import note above)
        // must still terminate the list — otherwise the tail leaks as `[head, <Nil-clone>]`.
        return [head];
      } else {
        return [head, tail];
      }
    }
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, lipsToJs(value, options)]));
    }
    // Check for Fantasy Land entities BEFORE converting to plain objects
    if (
      value["fantasy-land/map"] !== undefined ||
      value["fantasy-land/filter"] !== undefined ||
      value["fantasy-land/reduce"] !== undefined
    ) {
      // Preserve Fantasy Land entities as-is
      return value;
    }

    // todo traverse enumerable fields?
  }

  if (typeof value === "number" && options.forceBigInt) {
    return BigInt(value);
  }

  return value;
}

/**
 * JS → scheme deep-stamping membrane. Single pass: every AValue constructed
 * on the way down inherits the supplied `provenance` set, so downstream
 * extractors (`car`, `cdr`, `dict-ref`, `@`) see element-only lineage that
 * already carries the rosetta's origin id (spec §5.3 Interpretation A).
 *
 * War story: pre-deep-stamp, jsToLips constructed a Pair-chain whose outer
 * Pair received provenance via `result.withProvenance(...)` at the wrapper,
 * but every spine cons + every leaf inside stayed empty. The Tier-1 audit's
 * car/cdr "element-only" landing (lips.ts:2162) — correct per spec — then
 * exposed this gap: `(car (infer …))` returned a SchemeString carrying nothing,
 * and the v0 chain `(string-append "h" greeting)` lost the upstream infer id.
 * Pushing the stamp INTO `jsToLips` reaches every constructed value in one
 * pass; no per-builtin re-stamp; symmetric with the membrane discipline
 * already applied at the AValue.fromJs entry.
 *
 * Plain JS objects → `SchemeJSObject` (was raw passthrough — closes the
 * cross-package audit's "jsToLips doesn't consult boxer registry" finding).
 * Their entries box lazily on `.get(key)` so the wrapper's cache amortises
 * the cost without paying the full traversal on construction.
 *
 * `seen: WeakSet` terminates cycles on the JS-input side. If the source has a
 * cycle, the inner reference is returned as-is — the caller's outer Pair (or
 * SchemeJSObject) already carries the provenance, and the cycle re-enters
 * that wrapper rather than allocating an infinite spine.
 */
export function jsToLips(
  value: any,
  options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): any {
  if (value === null || value === undefined) {
    return provenance === EMPTY_PROVENANCE ? nil : new Nil(provenance);
  }

  // Cycle in JS-side input — return as-is. The caller's outer wrapper already
  // carries the stamp; this prevents the recursion from looping forever.
  if (typeof value === "object" && seen.has(value)) return value;
  if (typeof value === "object") seen.add(value);

  // Already-AValue input. Same-provenance fast-path preserves identity; Pair
  // recurses so children share the new lineage; leaves go through wrapper-
  // level `withProvenance` (entries of SchemeJSObject stay lazy via `.get`).
  if (value instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === value.provenance) return value;
    if (value instanceof Pair) {
      return new Pair(
        jsToLips(value.car, options, provenance, seen),
        jsToLips(value.cdr, options, provenance, seen),
        provenance,
      );
    }
    return value.withProvenance(provenance);
  }

  // JS array → Pair-chain, each cons + each leaf stamped on the way down.
  if (Array.isArray(value)) {
    let list: AValue = provenance === EMPTY_PROVENANCE ? nil : new Nil(provenance);
    for (let i = value.length - 1; i >= 0; i--) {
      list = new Pair(jsToLips(value[i], options, provenance, seen), list, provenance);
    }
    return list;
  }

  // Plain JS object → SchemeJSObject (lazy entries via .get cache).
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return new SchemeJSObject(value as object, provenance);
  }

  // JS primitives → AValue.fromJs (boxer registry handles bool/number/string/bigint).
  const tag = typeof value;
  if (tag === "string" || tag === "number" || tag === "boolean" || tag === "bigint") {
    return AValue.fromJs(value, provenance);
  }

  // Functions, exotic objects (Promise, Buffer, …): the caller's responsibility.
  return value;
}

export const createRosettaWrapper = ({ fn, options = {}, withContext = false }: RosettaFunction) => {
  // provenancePoint can't reach ctx.currentInvocation without withContext —
  // throw rather than silently degrade. The doc on RosettaOptions explains why.
  invariant(
    !options.provenancePoint || withContext !== false,
    "createRosettaWrapper: options.provenancePoint requires withContext: true (cannot reach ctx.currentInvocation otherwise)",
  );
  const effectiveWithContext = withContext || options.provenancePoint === true;

  const rosettaWrapper = async function rosettaWrapper(...args: any[]) {
    // When withContext, the evaluator appends EvalContext as the final arg.
    // We strip it off, then pass it to the user fn FIRST (so variadic scheme
    // args don't shift ctx around when called with fewer than max arity).
    let ctx: unknown = undefined;
    let schemeArgs = args;
    if (effectiveWithContext) {
      ctx = args[args.length - 1];
      schemeArgs = args.slice(0, -1);
    }

    // Collect provenance from AValue inputs BEFORE lipsToJs runs — that pass
    // unwraps SchemeString/SchemeBool/SchemeJSObject down to JS primitives
    // and records, stripping the AValue identity (and the provenance field
    // along with it). The union is computed against the original schemeArgs.
    const inputAValues = schemeArgs.filter((a): a is AValue => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    const jsArgs = schemeArgs.map((arg) => lipsToJs(arg, options));
    const callArgs = effectiveWithContext ? [ctx, ...jsArgs] : jsArgs;

    try {
      const rawResult = await fn(...callArgs);

      const inv = (ctx as CtxWithInvocation | undefined)?.currentInvocation;

      // Decide the output provenance BEFORE jsToLips so the deep-stamp pass
      // reaches every constructed AValue in one traversal (spec §5.3 — every
      // element returned by a rosetta carries its origin from the moment it
      // crosses the boundary, not after a separate `withProvenance` walk on
      // the top-level container). Provenance-point overrides inputs.
      //
      // No invocation in ctx: silent. The rosetta is being called from a path the
      // tap doesn't reach (e.g., direct JS invocation in tests); there's no node to
      // mark, fall back to input provenance.
      //
      // Node metadata (the card's display story) is bound separately and directly
      // by the rosetta fn via `ctx.currentInvocation.setMetadata(…)` at call time —
      // it's known up front, so it doesn't ride the result back through here.
      let resultProvenance = inputProvenance;
      if (options.provenancePoint === true && inv && typeof inv.id === "number") {
        // The real Invocation is a MobX observable — flip the flag through its
        // own action so this is safe under strict-mode (the studio enables it).
        // A plain POJO (direct-JS tests) has no method → set it directly.
        if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
        else inv.isProvenancePoint = true;
        resultProvenance = pointProvenance(inv.id);
      }

      const result = jsToLips(rawResult, options, resultProvenance);
      return options.returnEither ? [result, nil] : result;
    } catch (error) {
      console.error("Rosetta function error:", error);
      if (options.returnEither) {
        return [nil, error];
      } else {
        throw error;
      }
    }
  };
  if (effectiveWithContext) {
    (rosettaWrapper as { __withCtx?: boolean }).__withCtx = true;
  }
  return rosettaWrapper;
};

declare module "@here.build/arrival-scheme" {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}
