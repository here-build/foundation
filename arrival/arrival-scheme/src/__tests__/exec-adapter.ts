/**
 * Test Adapter: Switches between LIPS and Generator evaluators
 *
 * Usage:
 *   import { exec, env, execGenerator } from "./exec-adapter";
 *
 * Environment variable control:
 *   USE_GENERATOR=1 - Use generator-based evaluator
 *   (default) - Use LIPS evaluator
 *
 * This adapter enables A/B testing of the generator evaluator
 * against the full test suite.
 */

import type { Environment } from "../Environment";
import type { SchemeValue } from "../types";

// Import both evaluator implementations
import * as lips from "../lips";
import { exec as generatorExec, ExecOptions } from "../generator-exec";

// Check environment variable at module load time
const USE_GENERATOR = process.env.USE_GENERATOR === "1";

/**
 * Execute Scheme code using the selected evaluator.
 *
 * In generator mode, uses the flat trampoline evaluator.
 * In LIPS mode (default), uses the original promise-based evaluator.
 */
export async function exec(
  code: string | SchemeValue,
  options: { env?: Environment; dynamic_env?: Environment; use_dynamic?: boolean } = {},
): Promise<SchemeValue[]> {
  if (USE_GENERATOR) {
    return generatorExec(code, options);
  } else {
    // LIPS exec returns Promise<SchemeValue[]>
    return lips.exec(code, options);
  }
}

/**
 * Direct access to the generator exec (for tests that want to compare)
 */
export { generatorExec as execGenerator };

/**
 * Direct access to LIPS exec (for tests that need it)
 */
export { lips as lips };

/**
 * Default environment - LIPS user_env
 */
export const env = lips.env;

/**
 * Flag indicating which evaluator is active
 */
export const usingGenerator = USE_GENERATOR;

/**
 * Log which evaluator is being used (call once at test setup)
 */
export function logEvaluatorMode(): void {
  if (USE_GENERATOR) {
    console.log("[exec-adapter] Using generator-based evaluator");
  } else {
    console.log("[exec-adapter] Using LIPS evaluator");
  }
}
