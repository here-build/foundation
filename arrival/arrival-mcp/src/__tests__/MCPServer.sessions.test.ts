import { beforeEach, describe, expect, it } from "vitest";
import { MCPServer } from "../MCPServer";
import { ToolInteraction } from "../ToolInteraction";
import type { Context } from "hono";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

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

function createMockContext(sessionId?: string): Context {
  return {
    req: {
      header: (name: string) => {
        if (name === "mcp-session-id") return sessionId;
        return undefined;
      },
      json: async () => ({}),
    },
    get: () => undefined,
    set: () => {},
    header: () => {},
  } as any;
}

describe("MCPServer Session Management", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer(SessionStateTool, StatelessTool);
  });

  describe("State Persistence", () => {
    it("should persist state across multiple tool calls", async () => {
      const sessionId = "test-session-1";
      const context = createMockContext(sessionId);

      // First call - write to state
      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "test-value" },
      });

      // Second call - read from state
      const result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });

      expect(result.content[0].type).toBe("text");
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.data.value).toBe("test-value");
    });

    it("should handle state mutations", async () => {
      const sessionId = "test-session-2";
      const context = createMockContext(sessionId);

      // Increment counter multiple times
      let result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      let data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(1);

      result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(2);

      result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(3);
    });

    it("should handle array mutations", async () => {
      const sessionId = "test-session-3";
      const context = createMockContext(sessionId);

      // Append to list multiple times
      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "first" },
      });

      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "second" },
      });

      const result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "append", value: "third" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.list).toEqual(["first", "second", "third"]);
    });
  });

  describe("State Isolation", () => {
    it("should isolate state between different sessions", async () => {
      const session1 = "session-1";
      const session2 = "session-2";
      const context1 = createMockContext(session1);
      const context2 = createMockContext(session2);

      // Write different values to different sessions
      await server.callTool(context1, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "session-1-value" },
      });

      await server.callTool(context2, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "session-2-value" },
      });

      // Read from session 1
      const result1 = await server.callTool(context1, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });
      const data1 = JSON.parse((result1.content[0] as any).text);
      expect(data1.data.value).toBe("session-1-value");

      // Read from session 2
      const result2 = await server.callTool(context2, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });
      const data2 = JSON.parse((result2.content[0] as any).text);
      expect(data2.data.value).toBe("session-2-value");
    });

    it("should not leak state between sessions", async () => {
      const session1 = "leak-test-1";
      const session2 = "leak-test-2";
      const context1 = createMockContext(session1);
      const context2 = createMockContext(session2);

      // Increment counter in session 1
      await server.callTool(context1, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      await server.callTool(context1, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });

      // Session 2 should start fresh
      const result = await server.callTool(context2, {
        name: "session-state-tool",
        arguments: { operation: "increment" },
      });
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.counter).toBe(1); // Not 3
    });
  });

  describe("Backward Compatibility", () => {
    it("should work without session ID", async () => {
      const context = createMockContext(); // No session ID

      const result = await server.callTool(context, {
        name: "stateless-tool",
        arguments: { input: "test" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.echo).toBe("test");
    });

    it("should provide empty state when no session", async () => {
      const context = createMockContext(); // No session ID

      const result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.data).toEqual({}); // Empty state
    });

    it("should not persist state without session ID", async () => {
      const context = createMockContext(); // No session ID

      // Write value
      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "test" },
      });

      // Read value - should be empty since no session
      const result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.data).toEqual({}); // Not persisted
    });
  });

  describe("Tool Definitions with State", () => {
    it("should pass state when generating tool definitions", async () => {
      const sessionId = "definition-test";
      const context = createMockContext(sessionId);

      // Set up some state
      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "definition-context" },
      });

      // Get tool definitions - should have access to state
      const definitions = await server.getToolDefinitions(context);

      expect(definitions).toHaveLength(2);
      expect(definitions.map((d) => d.name)).toContain("session-state-tool");
      expect(definitions.map((d) => d.name)).toContain("stateless-tool");
    });

    it("should work without session when generating definitions", async () => {
      const context = createMockContext(); // No session

      const definitions = await server.getToolDefinitions(context);

      expect(definitions).toHaveLength(2);
    });
  });

  describe("Session Cleanup", () => {
    it("should clean up session state on delete", async () => {
      const sessionId = "cleanup-test";
      const context = createMockContext(sessionId);

      // Create some state
      await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "to-be-deleted" },
      });

      // Delete session (using protected method directly in test)
      await (server as any).deleteSessionState(context, sessionId);

      // New call should have empty state
      const result = await server.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "read" },
      });

      const data = JSON.parse((result.content[0] as any).text);
      // After deletion, getSessionState creates new empty state
      expect(data.data).toEqual({});
    });
  });

  describe("Custom Session Storage Override", () => {
    it("should allow overriding session storage methods", async () => {
      // Custom server with in-memory storage tracking
      class CustomStorageServer extends MCPServer {
        public storageAccess: string[] = [];

        protected async getSessionState(context: Context, sessionId: string) {
          this.storageAccess.push(`get:${sessionId}`);
          return super["getSessionState"](context, sessionId);
        }

        protected async setSessionState(
          context: Context,
          sessionId: string,
          state: Record<string, any>
        ) {
          this.storageAccess.push(`set:${sessionId}`);
          return super["setSessionState"](context, sessionId, state);
        }

        protected async deleteSessionState(context: Context, sessionId: string) {
          this.storageAccess.push(`delete:${sessionId}`);
          return super["deleteSessionState"](context, sessionId);
        }
      }

      const customServer = new CustomStorageServer(SessionStateTool);
      const sessionId = "custom-storage-test";
      const context = createMockContext(sessionId);

      // Call tool
      await customServer.callTool(context, {
        name: "session-state-tool",
        arguments: { operation: "write", value: "test" },
      });

      // Verify storage methods were called
      expect(customServer.storageAccess).toContain(`get:${sessionId}`);
      expect(customServer.storageAccess).toContain(`set:${sessionId}`);
    });
  });
});
