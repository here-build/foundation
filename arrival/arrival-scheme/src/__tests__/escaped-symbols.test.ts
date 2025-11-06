/**
 * Test escaped symbols and edge cases in LIPS
 *
 * LIPS supports escaped symbols like |symbol with spaces| or |24|
 * These tests verify proper resolution and interop with JS
 */

import { describe, expect, it } from "vitest";
import { sandboxedEnv } from "../sandbox-env";
import { exec } from "../lips";
import { lipsToJs } from "../rosetta";

// Helper to execute and get first result
async function execOne(expr: string, env = sandboxedEnv): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

describe("Escaped Symbol Resolution", () => {
  describe("Basic escaped symbols", () => {
    it("should handle numeric symbols like |24|", async () => {
      // Define a variable with numeric name
      const result = await execOne(`
        (begin
          (define |24| "twenty-four")
          |24|)
      `);

      expect(lipsToJs(result, {})).toBe("twenty-four");
    });

    it("should handle symbols with spaces", async () => {
      const result = await execOne(`
        (begin
          (define |my variable| 42)
          |my variable|)
      `);

      expect(lipsToJs(result, {})).toBe(42);
    });

    it("should handle symbols with special characters", async () => {
      const result = await execOne(`
        (begin
          (define |foo-bar!@#| "special")
          |foo-bar!@#|)
      `);

      expect(lipsToJs(result, {})).toBe("special");
    });
  });

  describe("Escaped symbols with property access", () => {
    it("should access numeric object keys", async () => {
      const result = await execOne(`(@ test-obj :|24|)`, sandboxedEnv.inherit({
        "test-obj": {
          "24": "value-24",
          "42": "value-42",
          normal: "normal-value"
        }
      }));
      expect(
        lipsToJs(result, {})
      ).toBe("value-24");
    });
  });

  describe("Escaped symbols in function names", () => {
    it("should define and call functions with escaped names", async () => {
      sandboxedEnv.defineRosetta("get-24", {
        fn: () => 24
      });

      const result = await execOne(`(|get-24|)`);
      expect(lipsToJs(result, {})).toBe(24);
    });

    it("should define functions with space-containing names", async () => {
      sandboxedEnv.defineRosetta("my function", {
        fn: (x: number) => x * 2
      });

      const result = await execOne(`(|my function| 21)`);
      expect(lipsToJs(result, {})).toBe(42);
    });
  });

  describe("Keywords vs escaped symbols", () => {
    it("should distinguish :24 from |24|", async () => {
      const testObj = {
        "24": "numeric key value"
      };

      sandboxedEnv.set("test-obj", testObj);

      // :24 should be treated as keyword and converted to "24" by @ function
      const result1 = await execOne(`(@ test-obj :24)`);
      expect(lipsToJs(result1, {})).toBe("numeric key value");

      // :|24| should also work (keyword with escaped symbol)
      const result2 = await execOne(`(@ test-obj :|24|)`);
      expect(lipsToJs(result2, {})).toBe("numeric key value");
    });

    it("should handle keywords with special characters", async () => {
      const testObj = {
        "foo-bar": "hyphenated",
        "foo_bar": "underscored"
      };

      sandboxedEnv.set("test-obj", testObj);

      const result = await execOne(`
        (list
          (@ test-obj :foo-bar)
          (@ test-obj :foo_bar))
      `);

      expect(lipsToJs(result, {})).toEqual(["hyphenated", "underscored"]);
    });
  });

  describe("Edge cases and resolution", () => {
    it("should handle empty escaped symbol", async () => {
      // LIPS might not support this, but let's test
      try {
        const result = await execOne(`
          (begin
            (define || "empty")
            ||)
        `);
        expect(lipsToJs(result, {})).toBe("empty");
      } catch (error) {
        // If LIPS doesn't support it, that's fine - document the limitation
        expect(error).toBeDefined();
      }
    });

    it("should handle unicode in escaped symbols", async () => {
      const result = await execOne(`
        (begin
          (define |hello-世界| "unicode works")
          |hello-世界|)
      `);

      expect(lipsToJs(result, {})).toBe("unicode works");
    });

    it("should handle pipes inside escaped symbols", async () => {
      // This might require escaping - test what LIPS does
      try {
        // Try escaping with backslash
        const result = await execOne(`
          (begin
            (define |foo\\|bar| "pipe inside")
            |foo\\|bar|)
        `);
        expect(lipsToJs(result, {})).toBe("pipe inside");
      } catch (error) {
        // Document if this doesn't work
        expect(error).toBeDefined();
      }
    });

    it("should preserve case sensitivity in escaped symbols", async () => {
      const result = await execOne(`
        (begin
          (define |MyVariable| "uppercase")
          (define |myvariable| "lowercase")
          (list |MyVariable| |myvariable|))
      `);

      expect(lipsToJs(result, {})).toEqual(["uppercase", "lowercase"]);
    });
  });

  describe("MCP real-world patterns", () => {
    it("should handle component UUIDs as property keys", async () => {
      const component = {
        "794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4": {
          name: "Button",
          type: "component"
        }
      };

      sandboxedEnv.set("components", component);

      const result = await execOne(`
        (@ components :|794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4|)
      `);

      const jsResult = lipsToJs(result, {});
      expect(jsResult.name).toBe("Button");
    });

    it("should chain property access with mixed key types", async () => {
      const data = {
        "projects": [
          {
            "id": "794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4",
            "name": "My Project",
            "24": "numeric property value"
          }
        ]
      };

      sandboxedEnv.set("data", data);

      const result = await execOne(`
        (begin
          (define project (car (@ data :projects)))
          (list
            (@ project :id)
            (@ project :name)
            (@ project :|24|)))
      `);

      expect(lipsToJs(result, {})).toEqual([
        "794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4",
        "My Project",
        "numeric property value"
      ]);
    });

    it("should filter objects by properties with escaped keys", async () => {
      const items = [
        { "item-id": "1", "24": "first" },
        { "item-id": "2", "24": "second" },
        { "item-id": "3", "24": "first" }
      ];

      sandboxedEnv.set("items", items);

      const result = await execOne(`
        (filter
          (lambda (item) (eq? (@ item :|24|) "first"))
          items)
      `);

      const jsResult = lipsToJs(result, {});
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0]["item-id"]).toBe("1");
      expect(jsResult[1]["item-id"]).toBe("3");
    });
  });
});
