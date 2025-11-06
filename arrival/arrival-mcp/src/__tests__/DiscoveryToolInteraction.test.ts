import { describe, it, expect, beforeEach } from "vitest";
import { DiscoveryToolInteraction } from "../DiscoveryToolInteraction";
import type { Context } from "hono";
import * as z from "zod";

// Simple test implementation
class TestDiscoveryTool extends DiscoveryToolInteraction<{ testContext: string }> {
  static readonly name = "test-discovery";
  readonly description = "Test discovery tool";

  readonly contextSchema = {
    testContext: z.string().describe("Test context value"),
  };

  protected async registerFunctions(): Promise<void> {
    // Register a simple function that echoes the context
    this.registerFunction(
      "echo-context",
      "Returns the test context value",
      [],
      () => this.executionContext?.testContext
    );

    // Register a function with parameters
    this.registerFunction(
      "add-numbers",
      "Adds two numbers",
      [z.union([z.number(), z.string().regex(/^-?\d*\.?\d*$/), z.bigint()]), z.union([z.number(), z.string().regex(/^-?\d*\.?\d*$/), z.bigint()])],
      (a: number, b: number) => Number(a) + Number(b)
    );
  }
}

function createMockContext(): Context {
  return {
    req: {
      header: () => undefined,
    },
    get: () => undefined,
    set: () => {},
  } as any;
}

describe("DiscoveryToolInteraction", () => {
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
  });

  describe("Tool Schema", () => {
    it("should generate valid tool schema", async () => {
      const tool = new TestDiscoveryTool(mockContext);
      const schema = await tool.getToolSchema();

      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("expr");
      expect(schema.properties).toHaveProperty("testContext");
      expect(schema.required).toContain("expr");
      expect(schema.required).not.toContain("testContext");
    });
  });

  describe("Function Registration", () => {
    it("should execute registered function without parameters", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: "(echo-context)",
        testContext: "test-value-123",
      });

      const result = await tool.executeTool();
      expect(result).toEqual(["'test-value-123'"]);
    });

    it("should execute registered function with parameters", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: "(add-numbers 5 3)",
        testContext: "test",
      });

      const result = await tool.executeTool();
      expect(result).toEqual(["8"]);
    });

    it("should handle LIPS expressions with multiple function calls", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: "(+ (add-numbers 5 3) (add-numbers 10 2))",
        testContext: "test",
      });

      const result = await tool.executeTool();
      expect(result).toEqual(["20"]);
    });
  });

  describe("Available Functions", () => {
    it("should execute successfully with registered functions", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: "(add-numbers 1 1)",
        testContext: "test",
      });

      const result = await tool.executeTool();
      expect(result).toEqual(["2"]);
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid function calls", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: "(non-existent-function)",
        testContext: "test",
      });

      await expect(tool.executeTool()).rejects.toThrow();
    });

    it("should handle invalid parameter types", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: '(add-numbers "not-a-number" 5)',
        testContext: "test",
      });

      await expect(tool.executeTool()).rejects.toThrow();
    });
  });

  // describe("Timeout Handling", () => {
  //   it("should timeout long-running expressions", async () => {
  //     const tool = new (class extends TestDiscoveryTool {
  //       protected async registerFunctions() {
  //         this.registerFunction(
  //           "infinite-loop",
  //           "Never returns",
  //           [],
  //           () => {
  //             while (true) {
  //               // Infinite loop
  //             }
  //           }
  //         );
  //       }
  //     })(mockContext, undefined, {
  //       expr: "(infinite-loop)",
  //       testContext: "test",
  //     });
  //
  //     await expect(tool.executeTool()).rejects.toThrow(/timeout/i);
  //   }, 10000); // 10s test timeout
  // });
});
