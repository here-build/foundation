// Re-export all LIPS interpreter functionality
import { initBridge } from "./bridge.js";
import { applyFantasyLandPatches } from "./fantasy-land-lips.js";

export * from "./lips.js";
export * from "./safe_builtins.js";
export { sandboxedEnv as sandboxedEnv } from "./sandbox-env.js";
export {
  lipsToJs as lipsToJs,
  jsToLips as jsToLips,
  createRosettaWrapper,
  type RosettaFunction,
} from "./rosetta.js";

// Runtime value hierarchy. Provenance algebra: docs/spec/arrival-chain.md §5.
export {
  type AKind,
  AValue,
  EMPTY_PROVENANCE,
  pointProvenance,
  unionProvenance,
} from "./AValue.js";

// A* aliases for arrival-chain compatibility — both spellings work until L4
// deletes the draft AValue there. Re-exports live here (not in AValue.ts) to
// preserve the no-subtype-imports invariant — see the cycle note in AValue.ts.
export {
  SchemeBool as ABool,
  SchemeBool,
  schemeFalse as AFalse,
  schemeFalse,
  schemeTrue as ATrue,
  schemeTrue,
} from "./LBool.js";
export { SchemeJSFunction as AProc, SchemeJSObject as AObject } from "./membrane.js";
export { SchemeString as AString } from "./LString.js";
export { SchemeSymbol as ASymbol } from "./LSymbol.js";
export { Pair as APair } from "./Pair.js";
export { Nil as ANil, SchemeCharacter as AChar } from "./types.js";

// Canonical core-type re-exports. These used to ride the `export * from
// "./lips.js"` barrel via a re-export block at the bottom of lips.ts; that
// block was removed (barrel-ectomy) so these names are re-surfaced from their
// real home modules to keep the public API identical.
export { nil, Nil, characters, SchemeCharacter } from "./types.js";
export { SchemeSymbol } from "./LSymbol.js";
export { SchemeString } from "./LString.js";
export { Pair } from "./Pair.js";

// Scheme namespace - canonical API for Scheme types
// Usage: import { Scheme } from 'arrival-scheme'
//        const s = new Scheme.String("hello")
//        const n = new Scheme.Exact(42n)
export * as Scheme from "./Scheme.js";

applyFantasyLandPatches();
void initBridge();

// Classes that may be needed for type checking or extension
export { Continuation as Continuation } from "./Continuation.js";
export { EOF as EOF } from "./EOF.js";
export { Environment as Environment } from "./Environment.js";

// Number system - SchemeExact (rationals) and SchemeInexact (floats/complex)
export {
  SchemeExact as SchemeExact,
  SchemeInexact as SchemeInexact,
  type SchemeNumeric as SchemeNumeric,
  RosettaConfig as RosettaConfig,
  schemeNumbers as schemeNumbers,
  rosettaNumbers as rosettaNumbers,
  makeNumber as makeNumber,
  parseNumber as parseNumber,
} from "./numbers.js";

// Membrane (Codec-based boundary crossing)
export {
  AnyNum as AnyNum,
  Int as Int,
  Real as Real,
  Num as Num,
  Bool as Bool,
  Str as Str,
  Operator as Operator,
} from "./membrane.js";

// Operators
export * from "./operators/index.js";

// Bridge (LIPS ↔ new types conversion)
export {
  fromLIPS as fromLIPS,
  wrapOperator as wrapOperator,
  wrappedOps as wrappedOps,
  initBridge as initBridge,
} from "./bridge.js";

// Generator-based Evaluator (alternative to main evaluate function)
// Uses flat trampoline for true stack safety and better performance
export {
  evaluate as evaluateGenerator,
  exec as execGenerator,
  SchemeError,
  SchemePromise,
  is_scheme_promise,
  type EvalContext,
  type EvalGenerator,
  type EvalTap,
  type Invocation,
  type StackFrame,
} from "./evaluator.js";
export { default as runGenerator } from "./evaluator.js";

// Generator Exec Entry Point (LIPS parser + generator evaluator)
// Use this for string-to-value evaluation with the generator evaluator
export {
  exec as execGeneratorFromString,
  parse as parseGenerator,
  execExpr as execGeneratorExpr,
  type ExecOptions,
} from "./generator-exec.js";

// LX (audit Action 4): the PUBLIC bare `exec`/`parse` resolve to the stack-safe,
// budget-bounded GENERATOR path — not the legacy lips.ts evaluator. These explicit
// named re-exports shadow the `exec`/`parse` that ride `export * from "./lips.js"`
// (ESM: an explicit export wins over a star-exported name of the same name). The
// generator `ExecOptions` is a strict superset of the legacy options
// ({env, dynamic_env, use_dynamic} shared, + signal/budgetMs/tap), so existing
// bare-`exec` callers are source-compatible — they just gain a killable, bounded
// evaluator. The legacy evaluator stays internal lips.ts machinery (its own special
// forms still call it) until the syntax-rules/HOF drain removes its last users; at
// that point legacy exec/evaluate/call_function get deleted (the rest of LX/LD).
export { exec, parse } from "./generator-exec.js";
