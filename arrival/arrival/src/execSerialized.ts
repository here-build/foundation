import { Environment, exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { toSExprString } from "@here.build/arrival-serializer";

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
    env: options?.env?.__env__ ? options?.env : sandboxedEnv.inherit("sandbox", options?.env)
  });

  // The result should be an array with one element (the list)
  // Extract the list contents and serialize each element
  if (Array.isArray(result) && result.length > 0) {
    const listResult = result[0];

    // If it's a LIPS Pair (list), convert to array and serialize each element
    if (listResult && typeof listResult === "object" && listResult.constructor?.name === "Pair") {
      const elements = convertPairToArray(listResult);
      return elements.map((element) => toSExprString(element));
    }

    // If it's already an array, serialize each element
    if (Array.isArray(listResult)) {
      return listResult.map((element) => toSExprString(element));
    }

    // If it's a single value, return it as a single-element array
    return [toSExprString(listResult)];
  }

  // Fallback: serialize the whole result
  return [toSExprString(result)];
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
