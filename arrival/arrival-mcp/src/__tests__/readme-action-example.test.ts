/**
 * Test the ActionToolInteraction example from the arrival barrel README
 */

import { describe, expect, it, vi } from "vitest";
import { ActionToolInteraction } from "../ActionToolInteraction";
import * as z from "zod";
import type { Context } from "hono";

// Mock database
const mockDatabase = {
  tasks: {
    create: vi.fn((data) => Promise.resolve({ id: `task-${Date.now()}`, ...data })),
    update: vi.fn((id, data) => Promise.resolve({ id, ...data }))
  }
};

// Make database available globally for the example
(global as any).database = mockDatabase;

class UpdateTasks extends ActionToolInteraction<{ projectId: string }> {
  static readonly name = "update_tasks";
  readonly description = "Batch update tasks";

  // Define what context is required for all actions
  readonly contextSchema = {
    projectId: z.string().describe("Project ID")
  };

  constructor(...args: any[]) {
    // @ts-expect-error
    super(...args);

    // Register available actions
    this.registerAction({
      name: "create-task",
      description: "Create a new task",
      context: ["projectId"], // requires projectId
      props: {
        title: z.string(),
        priority: z.number().optional()
      },
      handler: async (context, { title, priority }) => {
        // @ts-expect-error
        const task = await database.tasks.create({
          projectId: context.projectId,
          title,
          priority: priority ?? 0
        });
        return { created: task.id };
      }
    });

    this.registerAction({
      name: "update-task",
      description: "Update existing task",
      context: ["projectId"],
      props: {
        taskId: z.string(),
        title: z.string().optional(),
        priority: z.number().optional()
      },
      handler: async (context, { taskId, title, priority }) => {
        // @ts-expect-error
        const task = await database.tasks.update(taskId, {
          ...(title && { title }),
          ...(priority && { priority })
        });
        return { updated: task.id };
      }
    });
  }
}

function createMockContext(): Context {
  return {
    req: {
      header: () => undefined
    },
    get: () => undefined,
    set: () => {}
  } as any;
}

describe("README Action Example", () => {
  it("should execute the example batch from README", async () => {
    const tool = new UpdateTasks(createMockContext(), undefined, {
      projectId: "proj-123",
      actions: [
        ["create-task", "Implement login", 5],
        ["create-task", "Write tests", 3],
        ["update-task", "task-456", "Fix bug in auth", 10]
      ]
    });

    const result = await tool.executeTool();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);

    // First action: create-task
    expect(result[0]).toHaveProperty("created");
    expect(mockDatabase.tasks.create).toHaveBeenCalledWith({
      projectId: "proj-123",
      title: "Implement login",
      priority: 5
    });

    // Second action: create-task
    expect(result[1]).toHaveProperty("created");
    expect(mockDatabase.tasks.create).toHaveBeenCalledWith({
      projectId: "proj-123",
      title: "Write tests",
      priority: 3
    });

    // Third action: update-task
    expect(result[2]).toHaveProperty("updated");
    expect(mockDatabase.tasks.update).toHaveBeenCalledWith("task-456", {
      title: "Fix bug in auth",
      priority: 10
    });
  });

  it("should share context across all actions", async () => {
    mockDatabase.tasks.create.mockClear();

    const tool = new UpdateTasks(createMockContext(), undefined, {
      projectId: "shared-project",
      actions: [["create-task", "Task 1"], ["create-task", "Task 2"]]
    });

    await tool.executeTool();

    // Both calls should use the same projectId
    expect(mockDatabase.tasks.create).toHaveBeenNthCalledWith(1, {
      projectId: "shared-project",
      title: "Task 1",
      priority: 0
    });
    expect(mockDatabase.tasks.create).toHaveBeenNthCalledWith(2, {
      projectId: "shared-project",
      title: "Task 2",
      priority: 0
    });
  });

  it("should validate all actions before execution", async () => {
    mockDatabase.tasks.create.mockClear();
    mockDatabase.tasks.update.mockClear();

    const tool = new UpdateTasks(createMockContext(), undefined, {
      projectId: "proj-123",
      actions: [
        ["create-task", "Valid task"],
        ["invalid-action", "This will fail validation"],
        ["create-task", "Another task"]
      ]
    });

    const result = await tool.executeTool();

    // Should fail validation
    expect(result).toMatchObject({
      success: false,
      validation: "failed"
    });

    // No actions should have executed
    expect(mockDatabase.tasks.create).not.toHaveBeenCalled();
    expect(mockDatabase.tasks.update).not.toHaveBeenCalled();
  });
});
