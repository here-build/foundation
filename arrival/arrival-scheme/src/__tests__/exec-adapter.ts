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
import type { SchemeValue } from "../values/types";

// Import both evaluator implementations
import { env as lipsEnv, exec as lipsExec } from "../stdlib";
import { exec as generatorExec } from "../generator-exec";

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
    return lipsExec(code, options);
  }
}

/**
 * Direct access to the generator exec (for tests that want to compare)
 */
export { generatorExec as execGenerator };

/**
 * Default environment - LIPS user_env
 */
export const env = lipsEnv;
