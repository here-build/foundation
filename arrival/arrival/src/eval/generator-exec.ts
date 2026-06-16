/**
 * Public `exec`/`parse` entry point: bridges the parser (in stdlib.ts, the
 * upstream-LIPS-derived reader) to the generator-based evaluator. Self-bootstraps
 * the runtime on first use, then drives each top-level form through `run()`.
 *
 * Usage:
 *   import { exec } from "./generator-exec.js";
 *   const results = await exec("(+ 1 2 3)");  // Returns [6]
 *   const results = await exec("(+ 1 2)", { env: myEnv });
 */

import { whenBootstrapComplete } from "../boot.js";
import type { Environment } from "../Environment.js";
import run, { evaluate, type EvalTap } from "./evaluator.js";
import { is_pair } from "./guards.js";
import type { Pair } from "../values/Pair.js";
import type { SchemeValue } from "../values/types.js";

// Lazy import to avoid circular dependency during module initialization
let _lips: typeof import("../stdlib.js") | null = null;

async function getLips() {
  if (!_lips) {
    _lips = await import("../stdlib.js");
  }
  return _lips;
}

export interface ExecOptions {
  env?: Environment;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  /** Tap for tracing per-form evaluation enter/exit. See EvalTap. */
  tap?: EvalTap;
  /** Predicate to suppress tap firing for specific nodes (atoms always skipped). */
  nodeFilter?: (node: Pair) => boolean;
  /**
   * Execution-budget signal. When the signal aborts, the trampoline throws
   * `signal.reason ?? DOMException("aborted", "AbortError")` at the next
   * iteration boundary. See `EvalContext.signal` in evaluator.ts for the
   * full war story; the short version is that the 5ms event-loop yield
   * prevents UI freeze but does NOT bound CPU, so `(define (loop) (loop))`
   * needs an external bound for sandbox use.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget in milliseconds. Unlike `signal` (which needs
   * an external controller to fire), this is an INTERNAL bound: the trampoline
   * throws a `SchemeError(/budget/)` once `budgetMs` of wall-clock elapses,
   * checked at the same iteration boundary that yields to the event loop. This
   * is the bound sandbox / agent code needs so `(let loop () (loop))` can't hang
   * the host. Composable with `signal` — whichever fires first wins.
   */
  budgetMs?: number;
  /**
   * Per-run ALLOCATION budget — the memory analogue of `budgetMs`. Caps the cumulative number of list
   * cells materialized through `to_array` (the choke point every collection op funnels through). The
   * wall-clock budget is checked at trampoline TICKs, which a single native list pass (`filter`/
   * `append` over a large list) never hits — so an O(K²)-churn loop runs uninterruptibly until it
   * stack-overflows. This bound IS checked inside that loop. Undefined ⇒ unbounded (the default; only
   * sandbox / agent runs opt in). Composable with `budgetMs`/`signal` — whichever fires first wins.
   */
  heapBudget?: number;
  /**
   * Opt into Tier-2 speculative evaluation (latency-only; Scheme-invisible).
   * When true, producers (filter/map) may emit a lazy `HalfBaked` carrier so
   * control-flow over a still-filling promise fan can collapse early. With the
   * flag off, evaluation is byte-identical to the eager path. See
   * docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md.
   */
  speculate?: boolean;
}

/**
 * Parse and execute Scheme code using the generator-based evaluator.
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns Promise<SchemeValue[]> - Array of evaluation results (one per expression)
 *
 * @example
 * ```typescript
 * // Simple arithmetic
 * const [result] = await exec("(+ 1 2 3)");  // result = 6
 *
 * // Multiple expressions
 * const results = await exec("(define x 10) (+ x 5)");  // results = [undefined, 15]
 *
 * // With custom environment
 * const env = new Environment("my-env", { x: 42 });
 * const [result] = await exec("x", { env });  // result = 42
 * ```
 */
export async function exec(
  code: string | SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, heapBudget, speculate }: ExecOptions = {},
): Promise<SchemeValue[]> {
  const lips = await getLips();

  // Resolve environment - lips.env is the user_env (global_env.inherit("user-env"))
  const actualEnv = env ?? lips.env;

  // Self-initialize the runtime bootstrap (TS builtins + Scheme prelude) lazily, so
  // embedders never call initBridge() manually. If the bootstrap has already STARTED
  // (e.g. index.ts's fire-and-forget `void initBridge()`), await its COMPLETION
  // promise — the pack assembly is async, so the started-flag alone would let a racing
  // exec observe a half-assembled env. Bootstrap's own prelude evals use stdlib's
  // gate-free `exec`, so this await is never re-entrant (no deadlock).
  if (!actualEnv.initialized) await actualEnv.init();
  else await (whenBootstrapComplete() ?? actualEnv.init());

  // Parse if string, otherwise wrap single value in array
  let parsed: SchemeValue[];
  if (typeof code === "string") {
    parsed = await lips.parse(code, actualEnv);
  } else if (is_pair(code)) {
    // Single expression - evaluate directly
    parsed = [code];
  } else {
    // Atom - evaluate directly
    parsed = [code];
  }

  // Evaluate each expression in sequence. The budget spans the WHOLE exec call
  // (all top-level forms share one deadline) — a sandbox program that splits a
  // hang across several forms is still bounded. Recompute the remaining budget
  // per form from a single start so we don't reset the clock between forms.
  // Install the per-run allocation meter on the run's top env AFTER parse/init (so bootstrap + parse
  // allocations don't count against the user program), spanning the WHOLE exec like the wall-clock
  // budget. Save/restore the prior meter so a nested exec on the same env can't clobber the outer
  // one. `to_array` finds it by walking the parent chain from the calling scope.
  const priorMeter = actualEnv.__heapMeter__;
  if (heapBudget !== undefined) actualEnv.__heapMeter__ = { used: 0, max: heapBudget };

  const results: SchemeValue[] = [];
  const start = budgetMs === undefined ? 0 : performance.now();
  try {
    for (const expr of parsed) {
      const remaining =
        budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      const result = await run(
        evaluate(expr, {
          env: actualEnv,
          dynamic_env,
          use_dynamic,
          tap,
          nodeFilter,
          signal,
          speculate,
        }),
        { signal, budgetMs: remaining },
      );
      results.push(result);
    }
  } finally {
    if (heapBudget !== undefined) actualEnv.__heapMeter__ = priorMeter;
  }

  return results;
}

/**
 * Parse Scheme code without evaluating (delegates to stdlib's reader).
 * `source` (a filename / module path) is
 * stamped onto every produced location, so frames built from these forms read as
 * `file:line` — used by `(require …)` to attribute a module's throws to its file.
 */
export async function parse(code: string, env?: Environment, source?: string): Promise<SchemeValue[]> {
  const lips = await getLips();
  return lips.parse(code, env, source);
}

/**
 * Execute a single pre-parsed expression.
 * Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, speculate }: ExecOptions = {},
): Promise<SchemeValue> {
  const lips = await getLips();
  const actualEnv = env ?? lips.env;

  // See exec() above: await bootstrap COMPLETION, not just the started-flag.
  if (!actualEnv.initialized) await actualEnv.init();
  else await (whenBootstrapComplete() ?? actualEnv.init());

  return run(
    evaluate(expr, {
      env: actualEnv,
      dynamic_env,
      use_dynamic,
      tap,
      nodeFilter,
      signal,
      speculate,
    }),
    { signal, budgetMs },
  );
}
