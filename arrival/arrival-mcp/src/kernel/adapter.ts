import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import invariant from "tiny-invariant";
import type { Constructor } from "type-fest";

import { ToolInteraction, type MCPClientInfo, type UserlandCallToolResult } from "../ToolInteraction";
import { compileActionTool, type ActionTool } from "./action";
import { compileDiscoveryTool, type DiscoveryTool, type Services } from "./discovery";

/**
 * Adapter: wrap a value-shaped DiscoveryTool/ActionTool as a legacy
 * Constructor<ToolInteraction> for drop-in use by the existing ArrivalServer.
 *
 * No behavior changes in the server layer — shape translation only.
 */

export type ServicesExtractor<Svc extends Services> = (
  honoContext: Context,
  state: Record<string, any>,
) => Svc;

export function toLegacyDiscoveryClass<BaseCtx, Svc extends Services, Prep>(
  tool: DiscoveryTool<BaseCtx, Svc, Prep>,
  extractServices: ServicesExtractor<Svc>,
): Constructor<ToolInteraction<any>> {
  const compiled = compileDiscoveryTool(tool);

  class LegacyDiscoveryAdapter extends ToolInteraction<any> {
    static readonly name = tool.name;
    readonly description = tool.description;

    async getToolSchema(clientInfo?: MCPClientInfo): Promise<Tool["inputSchema"]> {
      const svc = extractServices(this.context, this.state);
      const desc = await compiled.getToolDescription(clientInfo, svc);
      return desc.inputSchema;
    }

    async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
      const svc = extractServices(this.context, this.state);
      return compiled.getToolDescription(clientInfo, svc);
    }

    async executeTool(clientInfo?: MCPClientInfo): Promise<UserlandCallToolResult | UserlandCallToolResult[]> {
      invariant(this.executionContext, `${tool.name}: executionContext required`);
      const { expr, intent, ...contextInput } = this.executionContext;
      const svc = extractServices(this.context, this.state);
      const history: string[] = this.state.__repl__ ?? [];

      const { result, replay } = await compiled.execute(
        { contextInput, expr, history },
        svc,
        clientInfo,
      );

      history.push(replay);
      this.state.__repl__ = history;

      void intent; // currently unused; hook for audit-trail integration
      return result as UserlandCallToolResult;
    }
  }

  Object.defineProperty(LegacyDiscoveryAdapter, "name", { value: tool.name });
  return LegacyDiscoveryAdapter;
}

export function toLegacyActionClass<BaseCtx, Svc extends Services, Prep>(
  tool: ActionTool<BaseCtx, Svc, Prep>,
  extractServices: ServicesExtractor<Svc>,
): Constructor<ToolInteraction<any>> {
  const compiled = compileActionTool(tool);

  class LegacyActionAdapter extends ToolInteraction<any> {
    static readonly name = tool.name;
    readonly description = tool.description;

    async getToolSchema(clientInfo?: MCPClientInfo): Promise<Tool["inputSchema"]> {
      const desc = compiled.getToolDescription(clientInfo);
      return desc.inputSchema;
    }

    async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
      return compiled.getToolDescription(clientInfo);
    }

    async executeTool(clientInfo?: MCPClientInfo): Promise<UserlandCallToolResult | UserlandCallToolResult[]> {
      invariant(this.executionContext, `${tool.name}: executionContext required`);
      const { actions, intent, ...contextInput } = this.executionContext;
      const svc = extractServices(this.context, this.state);
      const result = await compiled.dispatch(
        { intent: intent ?? "", actions: actions ?? [], contextInput },
        svc,
        clientInfo,
      );
      return result as UserlandCallToolResult;
    }
  }

  Object.defineProperty(LegacyActionAdapter, "name", { value: tool.name });
  return LegacyActionAdapter;
}
