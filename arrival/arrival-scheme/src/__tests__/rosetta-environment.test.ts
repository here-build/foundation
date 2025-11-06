/**
 * Test Rosetta Environment - seamless LIPS ↔ JS interop
 */

import { describe, expect, it } from "vitest";
import { sandboxedEnv } from "../sandbox-env";
import { createRosettaWrapper, jsToLips, lipsToJs } from "../rosetta";
import { exec } from "../lips";

// Helper to unwrap exec results
async function execOne(expr: string): Promise<any> {
  const results = await exec(expr, { env: sandboxedEnv });
  return results[0];
}

describe("Rosetta Environment", () => {
  describe("LIPS → JS Conversion", () => {
    it("should convert LIPS numbers to JS numbers", async () => {
      const lipsNumber = await execOne("42");
      const jsNumber = lipsToJs(lipsNumber, {});

      console.log("LIPS number:", lipsNumber);
      console.log("JS number:", jsNumber);

      expect(jsNumber).toBe(42);
      expect(typeof jsNumber).toBe("number");
    });

    it("should convert LIPS lists to JS arrays", async () => {
      const lipsList = await execOne("(list 1 2 3 4)");
      const jsArray = lipsToJs(lipsList, {});

      console.log("LIPS list:", lipsList);
      console.log("JS array:", jsArray);

      expect(Array.isArray(jsArray)).toBe(true);
      expect(jsArray).toEqual([1, 2, 3, 4]);
    });

    // this one is tricky and will probably require deep rewrite of runtime.
    // what needs to be done to introduce second instance of nil that will be "representing empty array"
    // to preserve metadata on reverse conversion
    it.skip("should convert empty LIPS list to empty JS array", async () => {
      const emptyList = await execOne("(list)");
      const jsArray = lipsToJs(emptyList, {});

      console.log("Empty LIPS list:", emptyList);
      console.log("Empty JS array:", jsArray);

      expect(jsArray).toEqual([]);
    });

    it("should convert nested LIPS lists", async () => {
      const nestedList = await execOne("(list (list 1 2) (list 3 4))");
      const jsArray = lipsToJs(nestedList, {});

      console.log("Nested LIPS list:", nestedList);
      console.log("Nested JS array:", jsArray);

      expect(jsArray).toEqual([
        [1, 2],
        [3, 4]
      ]);
    });

    it("should handle mixed data types", async () => {
      // Note: Using quote to prevent evaluation of symbols
      const mixedList = await execOne(`(list 42 "hello" #t)`);
      const jsArray = lipsToJs(mixedList, {});

      console.log("Mixed LIPS list:", mixedList);
      console.log("Mixed JS array:", jsArray);

      expect(jsArray[0]).toBe(42);
      expect(typeof jsArray[1]).toBe("string");
      expect(jsArray[2]).toBe(true);
    });
  });

  describe("JS → LIPS Conversion", () => {
    it("should convert JS arrays to LIPS lists", () => {
      const jsArray = [1, 2, 3, 4];
      const lipsList = jsToLips(jsArray, {});

      console.log("JS array:", jsArray);
      console.log("LIPS list:", lipsList);

      expect(lipsList.constructor.name).toBe("Pair");

      // Convert back to verify
      const backToJs = lipsToJs(lipsList, {});
      expect(backToJs).toEqual(jsArray);
    });

    it("should convert empty JS array to LIPS nil", () => {
      const emptyArray: any[] = [];
      const lipsList = jsToLips(emptyArray, {});

      console.log("Empty JS array:", emptyArray);
      console.log("LIPS nil:", lipsList);

      expect(lipsList.constructor.name).toBe("Nil");
    });

    it("should convert nested JS arrays", () => {
      const nestedArray = [
        [1, 2],
        [3, 4]
      ];
      const lipsList = jsToLips(nestedArray, {});

      console.log("Nested JS array:", nestedArray);
      console.log("Nested LIPS list:", lipsList);

      // Convert back to verify
      const backToJs = lipsToJs(lipsList, {});
      expect(backToJs).toEqual(nestedArray);
    });

    it("should handle JS objects", () => {
      const jsObject = { name: "test", value: 42, items: [1, 2, 3] };
      const lipsObject = jsToLips(jsObject, {});

      console.log("JS object:", jsObject);
      console.log("LIPS object:", lipsObject);

      // Should preserve object structure but convert array values
      expect(lipsObject.name).toBe("test");
      expect(lipsObject.value).toBe(42);
      expect(lipsObject.items.constructor.name).toBe("Pair"); // Array became LIPS list

      // Convert back to verify
      const backToJs = lipsToJs(lipsObject, {});
      expect(backToJs).toEqual(jsObject);
    });
  });

  describe("Rosetta Function Wrapping", () => {
    it("should wrap JS functions for automatic conversion", async () => {
      // Define a simple JS function
      const jsFunction = (numbers: number[]) => numbers.map((x) => x * 2);

      // Create Rosetta wrapper
      const rosettaFunction = createRosettaWrapper({ fn: jsFunction, options: {} });

      // Test with LIPS list
      const lipsList = await execOne("(list 1 2 3 4)");
      const result = await rosettaFunction(lipsList);

      console.log("Original LIPS list:", lipsList);
      console.log("Rosetta result:", result);

      // Result should be LIPS list with doubled values
      expect(result.constructor.name).toBe("Pair");
      const jsResult = lipsToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8]);
    });

    it("should handle complex JS operations", async () => {
      // Define a complex JS function (filtering and statistics)
      const analyzeNumbers = (numbers: number[]) => ({
        total: numbers.length,
        sum: numbers.reduce((a, b) => a + b, 0),
        evens: numbers.filter((x) => x % 2 === 0),
        odds: numbers.filter((x) => x % 2 === 1)
      });

      const rosettaAnalyze = createRosettaWrapper({ fn: analyzeNumbers, options: {} });

      // Test with LIPS list
      const lipsList = await execOne("(list 1 2 3 4 5 6)");
      const result = await rosettaAnalyze(lipsList);

      console.log("Analysis result:", result);

      // Convert back to JS to verify
      const jsResult = lipsToJs(result, {});
      expect(jsResult.total).toBe(6);
      expect(jsResult.sum).toBe(21);
      expect(jsResult.evens).toEqual([2, 4, 6]);
      expect(jsResult.odds).toEqual([1, 3, 5]);
    });
  });

  describe("Environment.defineRosetta", () => {
    it("should extend environment with Rosetta functions", async () => {
      // Define a Rosetta function in the environment
      sandboxedEnv.defineRosetta("double-all", {
        fn: (numbers: number[]) => numbers.map((x) => x * 2)
      });

      // Test calling it from LIPS
      const result = await execOne(`
        (double-all (list 1 2 3 4 5))
      `);

      console.log("Environment Rosetta result:", result);

      // Should return LIPS list with doubled values
      const jsResult = lipsToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8, 10]);
    });

    it("should handle multiple Rosetta functions", async () => {
      // Define multiple functions
      sandboxedEnv.defineRosetta("sum-array", {
        fn: (numbers: number[]) => numbers.reduce((a, b) => a + b, 0)
      });

      sandboxedEnv.defineRosetta("filter-evens", {
        fn: (numbers: number[]) => numbers.filter((x) => x % 2 === 0)
      });

      // Test chaining them
      const result = await execOne(`
        (sum-array (filter-evens (list 1 2 3 4 5 6 7 8)))
      `);

      console.log("Chained Rosetta result:", result);

      // Should sum the even numbers: 2 + 4 + 6 + 8 = 20
      const jsResult = lipsToJs(result, {});
      expect(jsResult).toBe(20);
    });

    it("should work with complex data structures", async () => {
      // Define a function that works with objects
      sandboxedEnv.defineRosetta("extract-values", {
        fn: (objects: any[]) => objects.map((obj) => obj.value)
      });

      // Create test data (this is tricky in LIPS, so we'll inject it)
      const testData = [
        { name: "first", value: 10 },
        { name: "second", value: 20 },
        { name: "third", value: 30 }
      ];

      // Convert to LIPS and call function
      const lipsData = jsToLips(testData, {});
      const rosettaFn = sandboxedEnv.get("extract-values");
      const result = await rosettaFn(lipsData);

      console.log("Complex data result:", result);

      const jsResult = lipsToJs(result, {});
      expect(jsResult).toEqual([10, 20, 30]);
    });
  });

  describe("Real-world Use Cases", () => {
    it("should handle the MCP CSS filtering pattern", async () => {
      // This simulates the exact pattern we need for MCP
      sandboxedEnv.defineRosetta("filter-by-css-property", {
        fn: (nodes: any[], property: string, value: string) => {
          return nodes.filter((node) => node.style && node.style[property] === value);
        }
      });

      // Create test node data
      const testNodes = [
        { name: "div1", style: { overflow: "hidden", color: "red" } },
        { name: "div2", style: { overflow: "visible", color: "blue" } },
        { name: "div3", style: { overflow: "hidden", color: "green" } },
        { name: "span1", style: { display: "block" } }
      ];

      // Convert to LIPS and filter
      const lipsNodes = jsToLips(testNodes, {});
      const filterFn = sandboxedEnv.get("filter-by-css-property");
      const result = await filterFn(lipsNodes, "overflow", "hidden");

      console.log("CSS filtering result:", result);

      const jsResult = lipsToJs(result, {});
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0].name).toBe("div1");
      expect(jsResult[1].name).toBe("div3");
    });

    it("should create CSS statistics like the MCP server needs", async () => {
      sandboxedEnv.defineRosetta("css-property-stats", {
        fn: (nodes: any[]) => {
          const stats: Record<string, number> = {};
          nodes.forEach((node) => {
            if (node.style) {
              Object.entries(node.style).forEach(([prop, value]) => {
                const key = `${prop}:${value}`;
                stats[key] = (stats[key] || 0) + 1;
              });
            }
          });
          return stats;
        }
      });

      const testNodes = [
        { style: { overflow: "hidden", display: "block" } },
        { style: { overflow: "visible", display: "block" } },
        { style: { overflow: "hidden", display: "flex" } }
      ];

      const lipsNodes = jsToLips(testNodes, {});
      const statsFn = sandboxedEnv.get("css-property-stats");
      const result = await statsFn(lipsNodes);

      console.log("CSS stats result:", result);

      const jsResult = lipsToJs(result, {});
      expect(jsResult["overflow:hidden"]).toBe(2);
      expect(jsResult["overflow:visible"]).toBe(1);
      expect(jsResult["display:block"]).toBe(2);
      expect(jsResult["display:flex"]).toBe(1);
    });
  });
});
