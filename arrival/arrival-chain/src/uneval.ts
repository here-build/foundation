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
// the theorem that makes the least slice exist and be sound). This file ships the SELECTOR step +
// the container; the minimal inlining slice (substitute defines over the homoiconic AST) is the
// next increment — for now `program` is the runnable original-source + selector (correct, re-runs
// to V), plus the provenance points so a renderer can minimize it.

import { execGeneratorExpr as execExpr, parseGenerator as parse, AValue, lipsToJs, type Environment } from "@here.build/arrival-scheme";
import type { EvalTrace } from "./trace.js";

/** One reverse-chain answer: the effective value the selector produced, the origin reads it
 *  traces to, and a re-runnable Scheme program that re-derives it. */
export interface Uneval {
  /** The effective value the selector picked out (peeled to plain JS). */
  value: unknown;
  /** The origin-IDs the value traces to — the provenance-point invocations (the evidence reads /
   *  marked derivations). Empty if the selector produced a non-provenanced value. */
  provenance: number[];
  /** A re-runnable Scheme program re-deriving the value. v1: the original program source followed
   *  by the selector (correct + re-runnable). The MINIMAL slice (only V's derivation) is the next
   *  increment — `provenance` is the seed for it. */
  program: string;
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
 *  final value as a raw AValue (provenance intact — NOT lipsToJs-peeled); `env` is the post-run
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
  const { env, result, trace, source } = opts;
  return {
    result: lipsToJs(result, {}),
    meta: { forms: opts.forms.length },
    uneval: async (selector: string): Promise<Uneval> => {
      // Bind the run's output as `result`, then evaluate the selector as ONE more tapped step —
      // the effective value is produced by the SAME pure evaluator, so it carries provenance and
      // becomes a trace node, exactly like any value the program itself computed.
      env.set("result", result as never);
      const sel = await parse(selector, env);
      let v: unknown = await execExpr(sel[sel.length - 1], { env, tap: trace });
      if (v != null && typeof (v as { then?: unknown }).then === "function") v = await (v as Promise<unknown>);
      const provenance = v instanceof AValue ? [...v.provenance] : [];
      // v1 program: the original derivation + the selector — re-runnable, reproduces V. The
      // minimal inlining slice (substitute the defines V depends on over the homoiconic AST,
      // bottoming out at the reads) is the next increment, seeded by `provenance`.
      const program = `${source.trim()}\n${selector.trim()}`;
      return { value: lipsToJs(v, {}), provenance, program };
    },
  };
}
