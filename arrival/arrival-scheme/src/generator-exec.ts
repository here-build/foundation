/**
 * Generator-Based Exec Entry Point
 *
 * This module bridges the LIPS parser with the generator-based evaluator,
 * providing an API compatible with the existing LIPS exec function.
 *
 * Usage:
 *   import { exec } from "./generator-exec.js";
 *   const results = await exec("(+ 1 2 3)");  // Returns [6]
 *   const results = await exec("(+ 1 2)", { env: myEnv });
 */

import type { Environment } from "./Environment.js";
import run, { evaluate, type EvalTap } from "./evaluator.js";
import { is_pair } from "./guards.js";
import type { Pair } from "./Pair.js";
import type { SchemeValue } from "./types.js";

// Lazy import to avoid circular dependency during module initialization
let _lips: typeof import("./lips.js") | null = null;
let _bridgeInitialized = false;

async function getLips() {
  if (!_lips) {
    _lips = await import("./lips.js");
    // Ensure bridge is initialized (adds numeric operations to global_env)
    if (!_bridgeInitialized) {
      _bridgeInitialized = true;
      const { initBridge } = await import("./bridge.js");
      await initBridge();
    }
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
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal }: ExecOptions = {},
): Promise<SchemeValue[]> {
  const lips = await getLips();

  // Resolve environment - lips.env is the user_env (global_env.inherit("user-env"))
  const actualEnv = env ?? lips.env;

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

  // Evaluate each expression in sequence
  const results: SchemeValue[] = [];
  for (const expr of parsed) {
    const result = await run(
      evaluate(expr, {
        env: actualEnv,
        dynamic_env,
        use_dynamic,
        tap,
        nodeFilter,
        signal,
      }),
      { signal },
    );
    results.push(result);
  }

  return results;
}

/**
 * Parse Scheme code without evaluating.
 * Re-exported from LIPS for convenience.
 */
export async function parse(code: string, env?: Environment): Promise<SchemeValue[]> {
  const lips = await getLips();
  return lips.parse(code, env);
}

/**
 * Execute a single pre-parsed expression.
 * Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal }: ExecOptions = {},
): Promise<SchemeValue> {
  const lips = await getLips();
  const actualEnv = env ?? lips.env;

  return run(
    evaluate(expr, {
      env: actualEnv,
      dynamic_env,
      use_dynamic,
      tap,
      nodeFilter,
      signal,
    }),
    { signal },
  );
}
