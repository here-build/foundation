/**
 * Simple Fantasy Land test - minimal debugging
 */

import { describe, expect, it } from "vitest";
import { env as lipsGlobalEnv, nil, sandboxedEnv } from "@here.build/arrival-scheme";

describe("Simple Fantasy Land Test", () => {
  it("should test basic Pair creation and Fantasy Land methods", async () => {
    console.log("=== TESTING BASIC PAIR CREATION ===");

    // Test if nil is available in sandboxed env
    console.log("nil in sandboxedEnv:", nil, typeof nil);

    // Test if nil is available in global env
    const globalNil = lipsGlobalEnv.get("nil", { throwError: false });
    console.log("nil in globalEnv:", globalNil, typeof globalNil);

    // Test cons
    const cons = sandboxedEnv.get("cons", { throwError: false });
    console.log("cons in sandboxedEnv:", cons, typeof cons);

    if (cons && nil) {
      // Create a pair manually
      const pair = cons(42, nil);
      console.log("Created pair:", pair);
      console.log("Pair constructor:", pair.constructor.name);

      // Check Fantasy Land methods
      console.log("FL map method:", typeof pair["fantasy-land/map"]);
      console.log("FL filter method:", typeof pair["fantasy-land/filter"]);
      console.log("FL reduce method:", typeof pair["fantasy-land/reduce"]);

      // Test calling FL method directly
      if (pair["fantasy-land/map"]) {
        try {
          const mapped = pair["fantasy-land/map"]((x: any) => x * 2);
          console.log("FL map result:", mapped);
        } catch (error) {
          console.log("FL map error:", error.message);
        }
      }
    }

    expect(nil).toBeDefined();
  });

  it("should test if our intelligent filter works", async () => {
    console.log("=== TESTING INTELLIGENT FILTER ===");

    // Get the filter function
    const filter = sandboxedEnv.get("filter", { throwError: false });
    console.log("Filter function:", typeof filter);

    // Create a test list
    const cons = sandboxedEnv.get("cons", { throwError: false });

    if (cons && nil && filter) {
      const list = cons(1, cons(2, cons(3, cons(4, cons(5, nil)))));
      console.log("Test list:", list);

      // Test the filter function directly
      try {
        const result = filter((x: number) => x > 3, list);
        console.log("Filter result:", result);
        console.log("Filter result type:", result?.constructor?.name);

        // Check if it's a LIPS list or JS array
        if (result && result.car !== undefined) {
          console.log("Result is LIPS list, car:", result.car);
          console.log("Result cdr:", result.cdr);
        } else if (Array.isArray(result)) {
          console.log("Result is JS array:", result);
        }
      } catch (error) {
        console.log("Filter error:", error.message);
      }
    }
  });

  it("should test Ramda map vs LIPS interaction", async () => {
    console.log("=== TESTING MAP INTERACTION ===");

    // Get functions
    const map = sandboxedEnv.get("map", { throwError: false });
    const inc = sandboxedEnv.get("inc", { throwError: false });
    const cons = sandboxedEnv.get("cons", { throwError: false });

    if (map && inc && cons && nil) {
      // Create test list: (1 2 3)
      const list = cons(1, cons(2, cons(3, nil)));
      console.log("Test list for map:", list);

      try {
        const result = map(inc, list);
        console.log("Map result:", result);
        console.log("Map result type:", result?.constructor?.name);

        // Walk the result
        let current = result;
        const values = [];
        while (current && current !== nil && current.car !== undefined) {
          values.push(current.car);
          current = current.cdr;
        }
        console.log("Map result values:", values);
      } catch (error) {
        console.log("Map error:", error.message);
        console.log("Map error stack:", error.stack);
      }
    }
  });
});
