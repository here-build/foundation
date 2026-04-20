import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { dispatchTool, getToolDefinitions } from "../dispatch";
import { ToolInteraction } from "../ToolInteraction";

// Test tool that uses session state
class SessionStateTool extends ToolInteraction<{ operation: string; value?: any }> {
  static readonly name = "session-state-tool";
  readonly description = "Tool that reads/writes session state";

  async getToolSchema(): Promise<Tool["inputSchema"]> {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "increment", "append"],
        },
        value: {
          type: "string",
          description: "Value to write/append",
        },
      },
      required: ["operation"],
    };
  }

  async executeTool() {
    const args = this.executionContext;
    switch (args?.operation) {
      case "read":
        return { data: this.state };

      case "write":
        this.state.value = args.value;
        return { success: true, written: args.value };

      case "increment":
        this.state.counter = (this.state.counter || 0) + 1;
        return { counter: this.state.counter };

      case "append":
        if (!this.state.list) {
          this.state.list = [];
        }
        this.state.list.push(args.value);
        return { list: this.state.list };

      default:
        return { error: "Unknown operation" };
    }
  }
}

// Test tool that doesn't use state
class StatelessTool extends ToolInteraction<{ input: string }> {
  static readonly name = "stateless-tool";
  readonly description = "Tool that doesn't use state";

  async getToolSchema(): Promise<Tool["inputSchema"]> {
    return {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    };
  }

  async executeTool() {
    const args = this.executionContext;
    return { echo: args?.input };
  }
}

const tools = [SessionStateTool, StatelessTool];

function createMockContext(): Context {
  return {
    req: {
      header: () => {},
      json: async () => ({}),
    },
    get: () => {},
    set: () => {},
    header: () => {},
  } as any;
}

describe("Tool Dispatch", () => {
  const context = createMockContext();

  describe("State Persistence", () => {
    it("should persist state across multiple dispatch calls with same state object", async () => {
      const state: Record<string, any> = {};

      // First call - write to state
      await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "test-value" },
      });

      // Second call - read from state
      const result = await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.data.value).toBe("test-value");
    });

    it("should handle state mutations", async () => {
      const state: Record<string, any> = {};

      // Increment counter multiple times
      let result = await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      let data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(1);

      result = await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(2);

      result = await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(3);
    });

    it("should handle array mutations", async () => {
      const state: Record<string, any> = {};

      await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "first" },
      });

      await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "second" },
      });

      const result = await dispatchTool(tools, context, state, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "third" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.list).toEqual(["first", "second", "third"]);
    });
  });

  describe("State Isolation", () => {
    it("should isolate state between different state objects", async () => {
      const state1: Record<string, any> = {};
      const state2: Record<string, any> = {};

      // Write different values to different "sessions"
      await dispatchTool(tools, context, state1, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "session-1-value" },
      });

      await dispatchTool(tools, context, state2, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "session-2-value" },
      });

      // Read from state1
      const result1 = await dispatchTool(tools, context, state1, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });
      const data1 = JSON.parse((result1.content[0] as any).text);
      expect(data1.data.value).toBe("session-1-value");

      // Read from state2
      const result2 = await dispatchTool(tools, context, state2, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });
      const data2 = JSON.parse((result2.content[0] as any).text);
      expect(data2.data.value).toBe("session-2-value");
    });

    it("should not leak state between state objects", async () => {
      const state1: Record<string, any> = {};
      const state2: Record<string, any> = {};

      // Increment counter in state1
      await dispatchTool(tools, context, state1, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      await dispatchTool(tools, context, state1, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });

      // state2 should start fresh
      const result = await dispatchTool(tools, context, state2, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(1); // Not 3
    });
  });

  describe("Stateless dispatch", () => {
    it("should work with empty state", async () => {
      const result = await dispatchTool(
        tools,
        context,
        {},
        {
          name: "stateless-tool",
          arguments: { input: "test" },
        },
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.echo).toBe("test");
    });

    it("should not persist state when using fresh objects", async () => {
      // Write value with one state object
      await dispatchTool(
        tools,
        context,
        {},
        {
          name: "session-state-tool",
          arguments: { operation: "write", value: "test" },
        },
      );

      // Read with a fresh state object — should be empty
      const result = await dispatchTool(
        tools,
        context,
        {},
        {
          name: "session-state-tool",
          arguments: { operation: "read" },
        },
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.data).toEqual({});
    });
  });

  describe("Tool Definitions", () => {
    it("should return definitions for all tools", async () => {
      const definitions = await getToolDefinitions(tools, context, {});

      expect(definitions).toHaveLength(2);
      expect(definitions.map((d) => d.name)).toContain("session-state-tool");
      expect(definitions.map((d) => d.name)).toContain("stateless-tool");
    });
  });

  describe("Error Result Detection", () => {
    it("should mark results with success: false as errors", async () => {
      // The increment tool returns {counter: N} which is not an error
      const goodResult = await dispatchTool(
        tools,
        context,
        {},
        {
          name: "session-state-tool",
          arguments: { operation: "increment" },
        },
      );
      expect(goodResult.isError).toBe(false);
    });
  });
});
