import { beforeEach, describe, expect, it } from "vitest";
import { ActionToolInteraction } from "../ActionToolInteraction";
import type { Context } from "hono";
import * as z from "zod";

// Simple test implementation
class TestActionTool extends ActionToolInteraction<{ projectId: string }> {
  static readonly name = "test-action";
  readonly description = "Test action tool";

  readonly contextSchema = {
    projectId: z.string().describe("Project ID"),
  };

  constructor (...args) {
    // @ts-expect-error
    super(...args);
    // Register some test actions
    this.registerAction({
      name: "create-item",
      description: "Create a test item",
      context: ["projectId"],
      props: {
        name: z.string().describe("Item name"),
        value: z.number().optional().describe("Optional value"),
      },
      handler: async (context, { name, value }) => ({
        action: "create-item",
        projectId: context.projectId,
        item: { name, value: value || 0 },
        success: true,
      }),
    });

    this.registerAction({
      name: "delete-item",
      description: "Delete a test item",
      context: ["projectId"],
      props: {
        itemId: z.string().describe("Item ID to delete"),
      },
      handler: async (context, { itemId }) => ({
        action: "delete-item",
        projectId: context.projectId,
        deletedId: itemId,
        success: true,
      }),
    });

    this.registerAction({
      name: "failing-action",
      description: "Action that always fails",
      context: ["projectId"],
      props: {},
      handler: async () => {
        throw new Error("Intentional failure");
      },
    });
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

describe("ActionToolInteraction", () => {
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
  });

  describe("Tool Schema", () => {
    it("should generate valid tool schema with actions", async () => {
      const tool = new TestActionTool(mockContext);
      const schema = await tool.getToolSchema();

      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("actions");
      expect(schema.properties).toHaveProperty("projectId");
      expect(schema.required).toContain("actions");
      expect(schema.required).toContain("projectId");
    });

    it("should include all registered actions in schema", async () => {
      const tool = new TestActionTool(mockContext);
      const schema = await tool.getToolSchema();
      // @ts-expect-error
      const actionsSchema = schema.properties.actions;

      // @ts-expect-error
      expect(actionsSchema.type).toBe("array");
      // @ts-expect-error
      expect(actionsSchema.items.type.oneOf).toHaveLength(3); // create-item, delete-item, failing-action
    });
  });

  describe("Single Action Execution", () => {
    it("should execute single action successfully", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [["create-item", "Test Item", 42]],
      });

      const result = await tool.executeTool();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        action: "create-item",
        projectId: "proj-123",
        item: { name: "Test Item", value: 42 },
        success: true,
      });
    });

    it("should handle optional parameters", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [["create-item", "Test Item"]],
      });

      const result = await tool.executeTool();

      expect(result[0].item).toMatchObject({
        name: "Test Item",
        value: 0, // Default value
      });
    });
  });

  describe("Batch Action Execution", () => {
    it("should execute multiple actions in sequence", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1", 10],
          ["create-item", "Item 2", 20],
          ["delete-item", "item-to-delete"],
        ],
      });

      const result = await tool.executeTool();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      expect(result[0].item.name).toBe("Item 1");
      expect(result[1].item.name).toBe("Item 2");
      expect(result[2].deletedId).toBe("item-to-delete");
    });

    it("should share context across all actions", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "shared-project-id",
        actions: [
          ["create-item", "Item A"],
          ["create-item", "Item B"],
        ],
      });

      const result = await tool.executeTool();

      expect(result[0].projectId).toBe("shared-project-id");
      expect(result[1].projectId).toBe("shared-project-id");
    });
  });

  describe("Validation", () => {
    it("should validate all actions before executing", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [
          ["create-item", "Valid Item"],
          ["non-existent-action"],
          ["create-item", "Another Item"],
        ],
      });

      const result = await tool.executeTool();

      expect(result).toMatchObject({
        success: false,
        validation: "failed",
        errors: expect.arrayContaining([
          expect.objectContaining({
            actionIndex: 1,
            action: "non-existent-action",
          }),
        ]),
      });
    });

    it("should not execute any actions if validation fails", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1"],
          ["invalid-action"],
        ],
      });

      const result = await tool.executeTool();

      expect(result).toHaveProperty("validation", "failed");
      expect(result).toHaveProperty("message");
      // @ts-expect-error
      expect(result.message).toContain("No actions were executed");
    });

    it("should validate parameter types", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [
          ["create-item", "Item", "not-a-number"], // Should be number
        ],
      });

      const result = await tool.executeTool();

      expect(result).toMatchObject({
        success: false,
        validation: "failed",
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle runtime errors during execution", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1"],
          ["failing-action"],
          ["create-item", "Item 3"], // Should not execute
        ],
      });

      const result = await tool.executeTool();

      expect(result).toMatchObject({
        success: false,
        partial: true,
        executed: 1,
        total: 3,
        failedAction: {
          actionIndex: 1,
          action: "failing-action",
          error: "Intentional failure",
        },
      });
      // @ts-expect-error
      expect(result.results).toHaveLength(1); // Only first action executed
    });
  });

  describe("Function Registration", () => {
    it("should allow registering helper functions", async () => {
      const tool = new TestActionTool(mockContext, undefined, {
        projectId: "test-proj-456",
        actions: [["create-item", "Test"]],
      });

      const result = await tool.executeTool();

      // Verify the action executed successfully (indirectly confirms functions registered)
      expect(result[0]).toMatchObject({
        action: "create-item",
        projectId: "test-proj-456",
        success: true,
      });
    });
  });

  describe("Context Constraints", () => {
    it("should require context properties that all actions need", async () => {
      const tool = new TestActionTool(mockContext);
      const schema = await tool.getToolSchema();

      // projectId is required by all actions, so it should be in required
      expect(schema.required).toContain("projectId");
    });
  });
});
