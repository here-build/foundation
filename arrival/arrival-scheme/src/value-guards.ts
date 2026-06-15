// Leaf value-kernel predicates.
//
// These four type guards depend ONLY on the value kernel (Pair, Nil, the
// native scalar wrappers) — never on Environment / Macro / Continuation /
// Syntax. They were carved out of guards.ts so that Pair.ts can import the
// predicates it needs without transitively dragging the entire evaluator
// world into the value kernel (guards.ts is a *false leaf*: it imports
// Environment, Macro, Continuation, …).
//
// guards.ts re-exports all four for backward compatibility — every existing
// call site that imports them from "./guards.js" keeps working unchanged.
//
// The residual Pair <-> value-guards 2-cycle is intentional and harmless:
// both live inside the future @arrival/values package, so the *cross-package*
// dependency graph stays acyclic. ESM resolves it because instanceof is
// evaluated at call time, never at module-init.
// ----------------------------------------------------------------------
import { SchemeString } from "./SchemeString.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { Pair } from "./Pair.js";
import { Nil, SchemeCharacter } from "./types.js";

// ----------------------------------------------------------------------
export function is_plain_object(object: unknown): object is Record<string, unknown> {
  return object !== null && typeof object === "object" && object.constructor === Object;
}

// ----------------------------------------------------------------------
/**
 * `nil` is the module-load singleton with empty provenance. Once `Nil` extends
 * AValue, `nil.withProvenance(p)` mints a FRESH Nil so the singleton's empty
 * provenance set is preserved (see types.ts:87 — withProvenance returns
 * `new Nil(p)`). `restrictControlFlowProvenance` (evaluator.ts:627) does
 * exactly this when a control-flow arm resolves to nil while the predicate
 * carries non-empty provenance, so `=== nil` would silently report false on
 * those clones and cascade through `length` / `null?` / `car` / `cdr`
 * typechecks. Match by class instead — every Nil clone IS a Nil regardless of
 * which provenance set it's carrying. Spec §5.3 + the doc comment over
 * `restrictControlFlowProvenance` explain the mechanism.
 */
export function is_nil(value: unknown): value is Nil {
  return value instanceof Nil;
}

// ----------------------------------------------------------------------
export function is_pair(o: unknown): o is Pair {
  return o instanceof Pair;
}

// ----------------------------------------------------------------------
export const is_native = (obj: unknown): obj is SchemeString | SchemeCharacter | SchemeExact | SchemeInexact =>
  obj instanceof SchemeString ||
  obj instanceof SchemeCharacter ||
  obj instanceof SchemeExact ||
  obj instanceof SchemeInexact;

// ----------------------------------------------------------------------
// Pure structural predicates (no value-kernel deps at all). They live here
// rather than in guards.ts so leaf utilities (e.g. utils/typecheck.ts) can
// import them without reaching guards.ts and, through it, Environment/Macro.
// ----------------------------------------------------------------------
export function is_function(o: unknown): o is Function {
  return typeof o === "function" && "bind" in o && typeof o.bind === "function";
}

// ----------------------------------------------------------------------
export function is_instance(obj: unknown): boolean {
  if (!obj) {
    return false;
  }
  if (typeof obj !== "object") {
    return false;
  }
  // __instance__ is read only for instances
  const o = obj as { __instance__?: boolean };
  if (o.__instance__) {
    o.__instance__ = false;
    return o.__instance__;
  }
  return false;
}

// ----------------------------------------------------------------------
export const has_own_symbol = (obj: unknown, symbol: symbol): boolean =>
  obj !== null && typeof obj === "object" ? Object.hasOwn(obj, symbol) : false;

// ----------------------------------------------------------------------
export function is_iterator(obj: unknown, symbol: symbol): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (has_own_symbol(obj, symbol) || has_own_symbol(Object.getPrototypeOf(obj), symbol)) {
    return is_function((obj as Record<symbol, unknown>)[symbol]);
  }
  return false;
}
