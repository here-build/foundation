/**
 * Debug the sandboxed environment to understand what's happening
 */

import { describe, it } from "vitest";
import { env as lipsGlobalEnv, exec, nil, sandboxedEnv } from "@here.build/arrival-scheme";

describe("Debug Environment", () => {
  it("should debug sandboxed environment contents", () => {
    console.log("=== SANDBOXED ENVIRONMENT DEBUG ===");

    // Check if Ramda functions are available
    const testFunctions = ["map", "filter", "reduce", "car", "cdr", "inc", "add"];
    for (const fn of testFunctions) {
      const value = sandboxedEnv.get(fn, { throwError: false });
      console.log(`${fn}:`, typeof value, value ? "✓" : "✗");
    }
  });

  it("should debug LIPS environment structure", () => {
    console.log("=== LIPS ENVIRONMENT DEBUG ===");

    // Check global environment
    const globalMap = lipsGlobalEnv.get("map", { throwError: false });
    console.log("Global map:", typeof globalMap);

    // Check cons function
    const cons = lipsGlobalEnv.get("cons", { throwError: false });
    console.log("Global cons:", typeof cons, cons ? "✓" : "✗");

    // Test creating a pair
    if (cons) {
      const pair = cons(1, cons(2, cons(3, nil)));
      console.log("Created pair:", pair);
      console.log("Pair constructor:", pair.constructor.name);
      console.log("Pair car:", pair.car);
      console.log("Pair cdr:", pair.cdr);
    }
  });

  it("should test exec function behavior", async () => {
    console.log("=== EXEC FUNCTION DEBUG ===");

    // Test basic exec
    const result1 = await exec("(+ 1 2)");
    console.log("exec (+ 1 2):", result1, "Type:", typeof result1);

    // Test with environment
    const result2 = await exec("(+ 1 2)", { env: sandboxedEnv });
    console.log("exec with sandboxedEnv:", result2, "Type:", typeof result2);

    // Test list creation
    const result3 = await exec("(list 1 2 3)", { env: sandboxedEnv });
    console.log("exec (list 1 2 3):", result3, "Type:", typeof result3);

    // Check if it's an array
    if (Array.isArray(result3)) {
      console.log("Result is array, length:", result3.length);
      console.log("First element:", result3[0]);
      console.log("First element type:", typeof result3[0]);
      console.log("First element constructor:", result3[0]?.constructor?.name);
    }
  });

  it("should test Fantasy Land patching", () => {
    console.log("=== FANTASY LAND PATCHING DEBUG ===");

    // Try to get Pair class
    const cons = lipsGlobalEnv.get("cons", { throwError: false });
    if (cons) {
      const testPair = cons(1, nil);
      console.log("Test pair created:", testPair);
      console.log("Test pair constructor:", testPair.constructor.name);

      // Check for Fantasy Land methods
      const flMap = testPair["fantasy-land/map"];
      const flFilter = testPair["fantasy-land/filter"];
      const flReduce = testPair["fantasy-land/reduce"];

      console.log("fantasy-land/map:", typeof flMap, flMap ? "✓" : "✗");
      console.log("fantasy-land/filter:", typeof flFilter, flFilter ? "✓" : "✗");
      console.log("fantasy-land/reduce:", typeof flReduce, flReduce ? "✓" : "✗");

      // List all properties
      console.log("All properties:", Object.getOwnPropertyNames(testPair));
      console.log("All symbols:", Object.getOwnPropertySymbols(testPair));

      // Check prototype
      console.log("Prototype properties:", Object.getOwnPropertyNames(testPair.__proto__));
    }
  });

  it("should test simple Ramda function", async () => {
    console.log("=== SIMPLE RAMDA TEST ===");

    // Try to use inc directly
    const inc = sandboxedEnv.get("inc", { throwError: false });
    if (inc) {
      console.log("inc function:", typeof inc);
      const result = inc(5);
      console.log("inc(5):", result);
    }

    // Try simple expression
    try {
      const result = await exec("(inc 5)", { env: sandboxedEnv });
      console.log("(inc 5) result:", result);
    } catch (error) {
      console.log("(inc 5) error:", error.message);
    }
  });
});
