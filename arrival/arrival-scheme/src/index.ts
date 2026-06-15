// Re-export all LIPS interpreter functionality
import { initBridge } from "./bridge.js";

export * from "./stdlib.js";
export * from "./safe_builtins.js";
export { sandboxedEnv as sandboxedEnv } from "./sandbox-env.js";
// Sandbox-boundary sealing — `@arrival.private` (+ the underlying markAsSandboxBoundary), the
// correct, exported way to mark a host class opaque to Scheme. Previously unexported, which forced
// consumers to forge the wrong (registry-global, forgeable) boundary symbol — see the decorator doc.
export { arrival, markSandboxPrivate, markAsSandboxBoundary } from "./sandbox-boundary.js";
export {
  schemeToJs,
  jsToScheme,
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
} from "./SchemeBool.js";
export { SchemeJSFunction as AProc, SchemeJSObject as AObject } from "./membrane.js";
export { SchemeString as AString } from "./SchemeString.js";
export { SchemeSymbol as ASymbol } from "./SchemeSymbol.js";
export { Pair as APair } from "./Pair.js";
export { Nil as ANil, SchemeCharacter as AChar } from "./types.js";

// Canonical core-type re-exports. These used to ride the `export * from
// "./stdlib.js"` barrel via a re-export block at the bottom of lips.ts; that
// block was removed (barrel-ectomy) so these names are re-surfaced from their
// real home modules to keep the public API identical.
export { nil, Nil, characters, SchemeCharacter } from "./types.js";
export { SchemeSymbol } from "./SchemeSymbol.js";
export { SchemeString } from "./SchemeString.js";
export { Pair } from "./Pair.js";

// Scheme namespace - canonical API for Scheme types
// Usage: import { Scheme } from 'arrival-scheme'
//        const s = new Scheme.String("hello")
//        const n = new Scheme.Exact(42n)
export * as Scheme from "./Scheme.js";

void initBridge();

// Classes that may be needed for type checking or extension
export { Continuation as Continuation } from "./Continuation.js";
export { EOF as EOF } from "./EOF.js";
export { Environment as Environment, KEYWORD_ACCESSOR_FIELD } from "./Environment.js";

// Number system - SchemeExact (rationals) and SchemeInexact (floats/complex)
export {
  SchemeExact as SchemeExact,
  SchemeInexact as SchemeInexact,
  type SchemeNumeric as SchemeNumeric,
  RosettaConfig as RosettaConfig,
  parseNumber as parseNumber,
} from "./numbers.js";

// Membrane (Codec-based boundary crossing)
export {
  AnyNum as AnyNum,
  Real as Real,
  Num as Num,
  Bool as Bool,
  Str as Str,
  Operator as Operator,
} from "./membrane.js";

// Operators
export * from "./operators/index.js";

// Bridge (numeric coercion + wrapped operators)
export {
  coerceNumeric,
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

// Generator Exec Entry Point (LIPS parser + generator evaluator)
// Use this for string-to-value evaluation with the generator evaluator
export {
  exec as execGeneratorFromString,
  parse as parseGenerator,
  execExpr as execGeneratorExpr,
  type ExecOptions,
} from "./generator-exec.js";

// The ONE way to make an env allocation-bounded — every eval loop that owns an env (Project.run, the
// studio kernel) installs the meter through this, so "bounded" is a single named act, not ad-hoc.
export { installHeapMeter, findHeapMeter, type HeapMeter } from "./heap-budget.js";

// LX (audit Action 4): the PUBLIC bare `exec`/`parse` resolve to the stack-safe,
// budget-bounded GENERATOR path. These explicit named re-exports shadow the
// `exec`/`parse` that ride `export * from "./stdlib.js"` (ESM: an explicit export
// wins over a star-exported name of the same name). The generator `ExecOptions` is
// a strict superset of stdlib's exec options ({env, dynamic_env, use_dynamic}
// shared, + signal/budgetMs/tap), so bare-`exec` callers gain a killable, bounded
// evaluator. The legacy `evaluate` is DELETED — stdlib.ts's own `exec` now also
// delegates to the generator, so the two paths agree.
export { exec, parse } from "./generator-exec.js";
