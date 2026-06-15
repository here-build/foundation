import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";

export type MCPClientInfo = Record<string, any>;
export type UserlandCallToolResult = File | string | object;

/**
 * One tool across its whole lifecycle: description (non-contextual — it describes the input
 * shape, though it already sees the Hono context) and execution (contextual). Hence we thread
 * the Hono context but NOT the per-call tool-call context — that's the lower-level interaction.
 *
 * Subclasses stay MCP-agnostic: `executeTool` returns plain blobs/text/objects, and the
 * transport (dispatch.ts) lowers them to MCP wire shapes.
 */

export abstract class ToolInteraction<ExecutionContext extends Record<string, any>> {
  static readonly name: string;
  readonly description!: string | Promise<string>;

  constructor(
    public readonly context: Context,
    public readonly state: Record<string, any> = {},
    public readonly executionContext?: ExecutionContext,
  ) {}

  async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
    return {
      name: this.constructor.name,
      description: await this.description,
      inputSchema: await this.getToolSchema(clientInfo),
    };
  }

  abstract getToolSchema(clientInfo?: MCPClientInfo): Tool["inputSchema"] | Promise<Tool["inputSchema"]>;

  abstract executeTool(clientInfo?: MCPClientInfo): Promise<UserlandCallToolResult | UserlandCallToolResult[]>;
}
