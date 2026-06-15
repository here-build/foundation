import type { Context } from "hono";
import { describe, it, expect, beforeEach } from "vitest";
import * as z from "zod";

import { DiscoveryToolInteraction } from "../DiscoveryToolInteraction";
import { McpEnvCapability } from "../McpEnvCapability";

// Simple test implementation — on the capability path (env + catalog from one capability).
class TestDiscoveryTool extends DiscoveryToolInteraction<{ testContext: string }> {
  static readonly name = "test-discovery";
  readonly description = "Test discovery tool";

  readonly contextSchema = {
    testContext: z.string().describe("Test context value"),
  };

  protected capability(): McpEnvCapability {
    const ctx = this.executionContext;
    return new McpEnvCapability("test-discovery-caps", {
      symbols: {
        "echo-context": { fn: () => ctx?.testContext },
        "add-numbers": { fn: (a: number, b: number) => Number(a) + Number(b) },
      },
      annotations: {
        "echo-context": { description: "Returns the test context value" },
        "add-numbers": {
          description: "Adds two numbers",
          inputSchema: [
            z.union([z.number(), z.string().regex(/^-?\d*(?:\.\d*)?$/), z.bigint()]),
            z.union([z.number(), z.string().regex(/^-?\d*(?:\.\d*)?$/), z.bigint()]),
          ],
        },
      },
    });
  }
}

function createMockContext(): Context {
  return {
    req: {
      header: () => {},
    },
    get: () => {},
    set: () => {},
  } as unknown as Context;
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

    // Arg-parsing restored: the capability path parses `annotation.args` (post-membrane,
    // pre-call), so a wrong-typed positional arg is rejected — same as the legacy path.
    it("should handle invalid parameter types", async () => {
      const tool = new TestDiscoveryTool(mockContext, undefined, {
        expr: '(add-numbers "not-a-number" 5)',
        testContext: "test",
      });

      await expect(tool.executeTool()).rejects.toThrow();
    });
  });

  describe("Timeout Handling", () => {
    it.todo(
      "should timeout long-running expressions — blocked on framework-level timeout enforcement; naive infinite loop would hang the runner. Implement once DiscoveryTool has a host-side interrupt mechanism.",
    );
  });

  describe("inputSchema getter transform (context-resolving args)", () => {
    // The shape from the design: a non-contextual declaration whose `inputSchema` GETTER is
    // evaluated per-call with `this`=activation, so the `.transform(...)` closure resolves
    // against live config/resources. (Here via `this.configuration`; resources work identically.)
    class TransformTool extends DiscoveryToolInteraction<{ prefix: string }> {
      static readonly name = "transform-tool";
      readonly description = "transform test";
      readonly contextSchema = { prefix: z.string().describe("prefix") };
      protected capability(): McpEnvCapability {
        return new McpEnvCapability("transform-caps", {
          configuration: { prefix: z.string() },
          symbols: { "resolve-arg": { fn: (resolved: string) => resolved } },
          annotations: {
            "resolve-arg": {
              description: "echoes the transformed arg",
              get inputSchema() {
                // `this` is the Activation at runtime (bound via Reflect.get); TS ThisType
                // doesn't reach getter accessors, so the activation shape is asserted here.
                const act = this as unknown as { configuration: { prefix: string } };
                return [z.string().transform((v: string) => `${act.configuration.prefix}:${v}`)];
              },
            },
          },
        });
      }
    }

    it("evaluates the getter with this=activation and transforms the arg via config", async () => {
      const tool = new TransformTool(mockContext, undefined, { expr: '(resolve-arg "x")', prefix: "P" });
      const result = await tool.executeTool();
      expect(result).toEqual(["'P:x'"]);
    });
  });
});
