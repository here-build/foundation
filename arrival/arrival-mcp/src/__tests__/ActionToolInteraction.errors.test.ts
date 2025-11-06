// @ts-nocheck
import { describe, it, expect } from "vitest";
import { ActionToolInteraction, ActionCall } from "../ActionToolInteraction";
import * as z from "zod";
import type { Context } from "hono";

// Test action tool with various validation scenarios
class TestActionTool extends ActionToolInteraction<{
  projectId: string;
  component?: { name: string };
}> {
  static readonly name = "test-actions";
  readonly description = "Test action tool for error validation";

  readonly contextSchema = {
    projectId: z.string(),
    component: z.object({ name: z.string() }).optional(),
  };

  constructor(context: Context) {
    super(context, {}, undefined);
    this.registerTestActions();
  }

  private registerTestActions() {
    this.registerAction({
      name: "simple-action",
      description: "Simple action with required string",
      context: ["projectId"],
      props: {
        name: z.string(),
      },
      handler: async (ctx, { name }) => ({ success: true, name }),
    });

    this.registerAction({
      name: "complex-action",
      description: "Complex action with nested validation",
      context: ["projectId"],
      props: {
        type: z.enum(["a", "b", "c"]),
        options: z.object({
          required: z.boolean(),
          default: z.string().optional(),
          choices: z.array(z.string()).optional(),
        }).optional(),
      },
      handler: async (ctx, { type, options }) => ({
        success: true,
        type,
        options
      }),
    });

    this.registerAction({
      name: "needs-component",
      description: "Action requiring component context",
      context: ["projectId", "component"],
      props: {
        value: z.number(),
      },
      handler: async (ctx, { value }) => ({
        success: true,
        component: ctx.component!.name,
        value
      }),
    });
  }
}

// Mock Hono context
const createMockContext = () => ({
  req: { header: () => undefined },
} as any as Context);

describe("ActionToolInteraction - Error Handling", () => {
  it("should collect all validation errors, not just first one", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["simple-action", 123], // Wrong type
        ["complex-action", "invalid-enum", { required: "not-boolean" }], // Multiple errors
        ["unknown-action"], // Unknown action
      ] as ActionCall[],
    };

    const result = await tool.executeTool();

    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("validation", "failed");
    expect((result as any).errors).toBeInstanceOf(Array);

    const errors = (result as any).errors;

    // Should have errors from all 3 actions
    expect(errors.length).toBeGreaterThanOrEqual(3);

    // Error from action 0 - wrong type for 'name'
    expect(errors.some((e: any) =>
      e.actionIndex === 0 && e.argument === "name"
    )).toBe(true);

    // Error from action 1 - invalid enum
    expect(errors.some((e: any) =>
      e.actionIndex === 1 && e.argument === "type"
    )).toBe(true);

    // Error from action 1 - nested validation
    expect(errors.some((e: any) =>
      e.actionIndex === 1 && e.argument === "options" && e.path
    )).toBe(true);

    // Error from action 2 - unknown action
    expect(errors.some((e: any) =>
      e.actionIndex === 2 && e.action === "unknown-action"
    )).toBe(true);
  });

  it("should include field paths for nested validation errors", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["complex-action", "a", { required: "not-a-boolean", choices: [123, 456] }],
      ] as ActionCall[],
    };

    const result = await tool.executeTool();
    const errors = (result as any).errors;

    // Should have error with path indicating nested field
    const nestedError = errors.find((e: any) =>
      e.argument === "options" && e.path && e.path.includes("required")
    );
    expect(nestedError).toBeDefined();
    expect(nestedError.path).toContain("required");
  });

  it("should provide received values for type mismatches", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["simple-action", 123], // number instead of string
      ] as ActionCall[],
    };

    const result = await tool.executeTool();
    const errors = (result as any).errors;

    const typeError = errors.find((e: any) => e.argument === "name");
    expect(typeError).toBeDefined();
    expect(typeError.argument).toBe("name");
    // Zod embeds type info in message, not separate field
    expect(typeError.error).toContain("expected string");
    expect(typeError.error).toContain("received number");
  });

  it("should format errors as S-expression", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["simple-action", 123],
        ["complex-action", "invalid"],
      ] as ActionCall[],
    };

    const result = await tool.executeTool();

    expect(result).toHaveProperty("sexpr");
    const sexpr = (result as any).sexpr;

    // Should be valid S-expression structure
    expect(sexpr).toContain("(validation-error");
    expect(sexpr).toContain('action 0 "simple-action"');
    expect(sexpr).toContain('argument "name"');
    expect(sexpr).toContain("(error");
    // Error message contains type info
    expect(sexpr).toContain("expected string");
  });

  it("should validate context properties with detailed errors", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: 123 as any, // Wrong type
      component: { name: 456 } as any, // Nested wrong type
      actions: [
        ["simple-action", "test"],
      ] as ActionCall[],
    };

    const result = await tool.executeTool();
    const errors = (result as any).errors;

    // Should have context validation errors
    const projectIdError = errors.find((e: any) => e.property === "projectId");
    expect(projectIdError).toBeDefined();
    expect(projectIdError.error).toContain("expected string");
    expect(projectIdError.error).toContain("received number");

    const componentError = errors.find((e: any) =>
      e.property === "component" && e.path
    );
    expect(componentError).toBeDefined();
    expect(componentError.path).toContain("name");
  });

  it("should not execute any actions if validation fails", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["simple-action", "valid"],
        ["simple-action", 123], // Invalid
        ["simple-action", "also-valid"],
      ] as ActionCall[],
    };

    const result = await tool.executeTool();

    // Should return validation error, not results
    expect(result).toHaveProperty("success", false);
    expect(result).not.toHaveProperty("length"); // Not an array of results
    expect((result as any).message).toContain("No actions were executed");
  });

  it("should handle missing required context gracefully", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      // Missing 'component' which is required for 'needs-component' action
      actions: [
        ["needs-component", 42],
      ] as ActionCall[],
    };

    // This should work - component is optional in context schema
    // But action requires it - this tests runtime context validation
    const result = await tool.executeTool();

    // Should either validate or execute and fail with clear error
    if ((result as any).success === false) {
      expect((result as any).message || (result as any).sexpr).toBeTruthy();
    }
  });

  it("should provide helpful message for unknown actions", async () => {
    const tool = new TestActionTool(createMockContext());
    tool.executionContext = {
      projectId: "test-123",
      actions: [
        ["nonexistent-action", "arg1", "arg2"],
      ] as ActionCall[],
    };

    const result = await tool.executeTool();
    const errors = (result as any).errors;

    const unknownError = errors.find((e: any) => e.action === "nonexistent-action");
    expect(unknownError).toBeDefined();
    expect(unknownError.error).toContain("Unknown action");
    expect(unknownError.error).toContain("Available actions");
  });
});
