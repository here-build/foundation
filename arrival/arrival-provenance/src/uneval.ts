// uneval.ts — the `{result, meta, uneval}` container + the selector-eval step.
//
// V's design (no new entity): a traced run yields a container whose `uneval` is NOT special
// trickery — `uneval("(car result)")` evaluates the selector as ONE MORE tapped step (with the
// program's output bound to `result`, so the effective value carries provenance intact), then
// reverse-slices the trace by that effective value's provenance into a re-runnable Scheme program
// that re-derives exactly it.
//
// Why this is sound (and why arrival was made pure): the language is pure dataflow with on-value
// provenance, so the effective value's origin set IS its dependency set, and a program restricted
// to that derivation reproduces the value (the Galois-slicing `uneval` of Perera–Cheney; purity is
// the theorem that makes the least slice exist and be sound). The container's `program` is the
// real SLICE (via `buildSlice`): only the top-level forms the effective value depends on, plus
// the selector. Intra-form minimal slicing (sub-form re-synthesis) is the deferred increment.

import {
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  AValue,
  schemeToJs,
  type Environment,
} from "@here.build/arrival-scheme";

import { buildSlice, writeForm, defineNameOf, lastTopLevelForm } from "./slice.js";
import type { EvalTrace } from "./trace.js";

/** One reverse-chain answer: the effective value the selector produced, the origin reads it
 *  traces to, and a re-runnable Scheme program that re-derives it. */
export interface Uneval {
  /** The effective value the selector picked out (peeled to plain JS). */
  value: unknown;
  /** The origin-IDs the value traces to — the provenance-point invocations (the evidence reads /
   *  marked derivations). Empty if the selector produced a non-provenanced value. */
  provenance: number[];
  /** A re-runnable Scheme program re-deriving the value: the SLICE — only the top-level forms the
   *  effective value depends on (the backward dependence cone), followed by the selector that
   *  picks it out. Unrelated forms are pruned; referenced literal defines are kept. */
  program: string;
  /** The dynamic point-cone — the provenance-point ids the value depends on (the evidence reads
   *  / derivations). The per-leaf→read join key; also a UI source-highlight seed. */
  points: number[];
  /** `scopeId` of each kept form (stable source-location keys, for UI highlighting). */
  scopeIds: string[];
}

/** A traced run's return value, as V's design wants it: the answer, run metadata, and `uneval`. */
export interface UnevalContainer {
  /** The program's output value (peeled to plain JS). */
  result: unknown;
  meta: { forms: number };
  /** Evaluate a selector ("(car result)", "(:PID (car result))") as one more tapped step and
   *  reverse-slice the trace by the effective value's provenance. */
  uneval: (selector: string) => Promise<Uneval>;
}

/** Build the `{result, meta, uneval}` container from a finished traced run. `result` is the run's
 *  final value as a raw AValue (provenance intact — NOT schemeToJs-peeled); `env` is the post-run
 *  scope (so the selector evaluates with `result` bound); `trace` is the run's EvalTrace (so the
 *  selector's step records, and the slice can read the whole lineage). `source` is the original
 *  program text (the v1 program render). */
export function buildUneval(opts: {
  env: Environment;
  result: unknown;
  trace: EvalTrace;
  source: string;
  forms: readonly unknown[];
}): UnevalContainer {
  const { env, result, trace, forms } = opts;
  // The run's OUTPUT expression (the last top-level form) is what produces `result`. The slice is
  // anchored on the symbols IT references, so the derivation of `result` is reproduced in full;
  // we then bind `result` to it and append the selector — the selector picks the effective value
  // out of the reproduced output. Anchoring on the output form (not the value's provenance cone)
  // is what makes the slice CLOSED: its binding form + whole consumer chain are kept by reference.
  // The run's OUTPUT form — explicit `forms` if threaded, else the trace's last top-level form
  // (captured HERE, before any selector eval pollutes the trace with its own top-level form).
  const outputForm = forms.length > 0 ? forms.at(-1) : lastTopLevelForm(trace);
  const outputName = outputForm === undefined ? null : defineNameOf(outputForm);
  // `result` re-expressed in the slice's terms: the output's name if it's a define, else the
  // output expression rendered back to source.
  const resultExpr = outputForm === undefined ? "result" : (outputName ?? writeForm(outputForm));

  return {
    result: schemeToJs(result, {}),
    meta: { forms: forms.length },
    uneval: async (selector: string): Promise<Uneval> => {
      // Bind the run's output as `result`, then evaluate the selector as ONE more tapped step —
      // the effective value is produced by the SAME pure evaluator, so it carries provenance and
      // becomes a trace node, exactly like any value the program itself computed.
      env.set("result", result as never);
      const sel = await parse(selector, env);
      let v: unknown = await execExpr(sel.at(-1), { env, tap: trace });
      if (v != null && typeof (v as { then?: unknown }).then === "function") v = await (v as Promise<unknown>);
      const provenance = v instanceof AValue ? [...v.provenance] : [];
      // The SLICE: the reachable derivation of the run's output (static backward reference-closure
      // from the output's symbols), then a LET that binds `result` to the reproduced output and
      // evaluates the selector against it. A `let` (not a top-level `(define result …)`) avoids a
      // collision when the program's own output binding is itself named `result` (which produced a
      // degenerate `(define result result)`). Closed + re-runnable by construction.
      const slice = buildSlice(trace, outputForm);
      const tail = `(let ((result ${resultExpr})) ${selector.trim()})`;
      const program = slice.program ? `${slice.program}\n${tail}` : tail;
      return { value: schemeToJs(v, {}), provenance, program, points: slice.points, scopeIds: slice.scopeIds };
    },
  };
}
