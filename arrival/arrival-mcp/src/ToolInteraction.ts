import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { MCPClientInfo } from "./hono/HonoMCPServer";

export type UserlandCallToolResult = File | string | object;

/** Tool interaction represents the whole interaction lifecycle:
 - discovery and description (non-contextual as it describes the context input itself, yet already hono context aware)
 - interaction (contextual as happens within the context provided)
 That's why we pass hono context, but not tool call context - tool call is lower-level interaction.

 Specific Tool is mostly not thinking in terms of MCP server wherever possible.
 Execution is returning just blobs, texts and objects, not mcp representations of those
 */

export abstract class ToolInteraction<ExecutionContext extends Record<string, any>> {
  static readonly name: string;
  readonly description!: string | Promise<string>;

  constructor(
    public readonly context: Context,
    public readonly state: Record<string, any> = {},
    public readonly executionContext?: ExecutionContext
  ) {
  }

  async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      name: this.constructor.name,
      description: await this.description,
      inputSchema: await this.getToolSchema(clientInfo),
    };
  }

  abstract getToolSchema(clientInfo?: MCPClientInfo): Tool["inputSchema"] | Promise<Tool["inputSchema"]>;

  abstract executeTool(clientInfo?: MCPClientInfo): Promise<UserlandCallToolResult | UserlandCallToolResult[]>;
}
