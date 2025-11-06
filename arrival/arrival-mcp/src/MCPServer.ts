import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import invariant from "tiny-invariant";
import type { Constructor } from "type-fest";

import type { ToolInteraction } from "./ToolInteraction";
import { MCPClientInfo } from "./hono/HonoMCPServer";

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

// External session storage (not part of class instance)
const sessionStates = new Map<string, Record<string, any>>();

export class MCPServer {
  public readonly tools: Constructor<ToolInteraction<any>>[];

  constructor(...tools: Constructor<ToolInteraction<any>>[]) {
    this.tools = tools;
  }

  /**
   * Override this method to use external storage (Redis, Durable Objects, etc.)
   * Default implementation uses in-memory Map
   */
  protected async getSessionState(context: Context, sessionId: string): Promise<Record<string, any>> {
    const state = sessionStates.get(sessionId);
    if (state) {
      return state;
    }
    // Create new state object
    const newState = {};
    sessionStates.set(sessionId, newState);
    return newState;
  }

  /**
   * Override this method to use external storage (Redis, Durable Objects, etc.)
   * Default implementation uses in-memory Map (state object may have been mutated)
   */
  protected async setSessionState(context: Context, sessionId: string, state: Record<string, any>): Promise<void> {
    sessionStates.set(sessionId, state);
  }

  /**
   * Override this method to use external storage (Redis, Durable Objects, etc.)
   * Default implementation uses in-memory Map
   */
  protected async deleteSessionState(context: Context, sessionId: string): Promise<void> {
    sessionStates.delete(sessionId);
  }

  /**
   * Public method to delete a session (calls protected deleteSessionState)
   */
  async deleteSession(context: Context, sessionId: string): Promise<void> {
    await this.deleteSessionState(context, sessionId);
  }

  async callTool(context: Context, request: CallToolRequest["params"], clientInfo?: MCPClientInfo): Promise<CallToolResult> {
    const ToolInteraction = this.tools.find(({ name }) => name === request.name);
    invariant(ToolInteraction !== undefined, "unknown tool");

    // Load session state if session exists
    const sessionId = context.req.header("mcp-session-id");
    const state = sessionId ? await this.getSessionState(context, sessionId) : {};

    const toolInteraction = new ToolInteraction(context, state, request.arguments);
    console.log("calling MCP", request.name, request.arguments);
    const callToolResult = await toolInteraction.executeTool(clientInfo);

    // Save state after execution (tool may have mutated it)
    if (sessionId) {
      await this.setSessionState(context, sessionId, state);
    }

    return {
      content: await Promise.all(
        asArray(callToolResult).map(async (result): Promise<CallToolResult["content"][number]> => {
          switch (true) {
            case typeof result === "string":
              return {
                type: "text",
                text: result,
              };
            case result instanceof Blob && result.type.startsWith("image/"):
            case result instanceof Blob && result.type.startsWith("audio/"): {
              let binary = "";
              const bytes = new Uint8Array(await result.arrayBuffer());
              const length_ = bytes.byteLength;
              for (let index = 0; index < length_; index++) {
                binary += String.fromCodePoint(bytes[index]);
              }
              return {
                type: result.type.split("/")[0] as "image" | "audio",
                data: btoa(binary),
                mimeType: result.type,
              };
            }
            default:
              return {
                type: "text",
                text: JSON.stringify(result),
              };
          }
        }),
      ),
    };
  }

  async getToolDefinitions(context: import("hono").Context, clientInfo?: MCPClientInfo): Promise<ListToolsResult["tools"]> {
    const definitions: ListToolsResult["tools"] = [];
    // Load session state for tools that need it for schema generation
    const sessionId = context.req.header("mcp-session-id");
    const state = sessionId ? await this.getSessionState(context, sessionId) : {};

    for (const ToolClass of this.tools) {
      try {
        // Instantiate each tool to get its definition
        const tool = new ToolClass(context, state);
        const definition = await tool.getToolDescription(clientInfo);
        definitions.push(definition);
      } catch (error) {
        console.warn(`[MCPServer] Failed to get definition for tool ${ToolClass.name}:`, error);
        // Continue with other tools - don't fail the entire tool list
      }
    }

    return definitions;
  }
}
