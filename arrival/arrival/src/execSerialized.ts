import { exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { toSExprString } from "@here.build/arrival-serializer";

// Total serialized-output budget for one MCP tool result (~10k tokens). Motivated by the
// 158k-char "exceeds maximum allowed tokens" drop: the serializer streams per-element caps
// and shrinks them to fit this budget rather than emitting an oversized payload the client
// rejects. Split across the result elements so the SUM stays bounded.
const MCP_OUTPUT_BUDGET = 40_000;
const perElementBudget = (count: number): number => Math.max(2_000, Math.floor(MCP_OUTPUT_BUDGET / Math.max(1, count)));

/**
 * Execute LIPS expressions and return serialized string results.
 *
 * This wrapper:
 * 1. Takes the same arguments as exec()
 * 2. Wraps the input expression in (list ...)
 * 3. Executes with LIPS
 * 4. Converts each result element to a serialized string
 *
 * @param expr - The LIPS expression/expressions to execute
 * @param options - Same options as exec() (environment, etc.)
 * @returns Array of serialized string results
 */
export async function execSerialized(expr: string, options?: any): Promise<string[]> {
  const result = await exec(`(list ${expr})`, {
    env: options?.env?.__env__ ? options?.env : sandboxedEnv.inherit("sandbox", options?.env),
    // Thread through the eval bounds (previously dropped) so callers can budget/cancel a run.
    budgetMs: options?.budgetMs,
    signal: options?.signal,
  });

  // The result should be an array with one element (the list)
  // Extract the list contents and serialize each element
  if (Array.isArray(result) && result.length > 0) {
    const listResult = result[0];

    // If it's a LIPS Pair (list), convert to array and serialize each element
    if (listResult && typeof listResult === "object" && listResult.constructor?.name === "Pair") {
      const elements = convertPairToArray(listResult);
      const per = perElementBudget(elements.length);
      return elements.map((element) => toSExprString(element, { maxTotalChars: per }));
    }

    // If it's already an array, serialize each element
    if (Array.isArray(listResult)) {
      const per = perElementBudget(listResult.length);
      return listResult.map((element) => toSExprString(element, { maxTotalChars: per }));
    }

    // If it's a single value, return it as a single-element array
    return [toSExprString(listResult, { maxTotalChars: MCP_OUTPUT_BUDGET })];
  }

  // Fallback: serialize the whole result
  return [toSExprString(result, { maxTotalChars: MCP_OUTPUT_BUDGET })];
}

/**
 * Convert a LIPS Pair (linked list) to a JavaScript array
 */
function convertPairToArray(pair: any): any[] {
  const result: any[] = [];
  let current = pair;

  while (current && current.constructor?.name === "Pair") {
    result.push(current.car);
    current = current.cdr;
  }

  // Handle improper lists (rare)
  if (
    current &&
    current.constructor?.name !== "Nil" &&
    !(current.constructor?.name === "Object" && Object.keys(current).length === 0)
  ) {
    result.push(current);
  }

  return result;
}
