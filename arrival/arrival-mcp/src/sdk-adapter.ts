// sdk-adapter — wire an array of tools (DiscoveryTool / ActionTool / anything `McpTool`-shaped) onto
// the OFFICIAL @modelcontextprotocol/sdk McpServer.
//
// The whole bridge is two handlers: `describe()` → tools/list, `call()` → tools/call. Because a tool
// is a plain value (not a subclass), tools are just an array you register — and the SAME describe/call
// surface backs any transport. The SDK's per-request AbortSignal (`extra.signal` — cancel / timeout /
// disconnect) is threaded straight into the eval's TICK check; the host supplies the rest of the
// dispatch ctx (session/user/record). Whatever `call` returns — a DiscoveryTool's `string[]` REPL
// output or an ActionTool's result object — is lowered by the one `serializeResult` (string→text,
// object→JSON, `success:false`→isError), so both tiers register identically.
//
// We drive `McpServer.server` (the low-level escape hatch) rather than `McpServer.registerTool`,
// because our catalog is DYNAMIC: `describe(clientInfo)` regenerates per `tools/list` (the
// dynamicDescription welcome, personalized by the client) — registerTool registers ONE static schema.
// Going through `.server` keeps that, and never names the deprecated `Server` symbol.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolCallCtx } from "./DiscoveryTool.js";
import { serializeResult, type UserlandCallToolResult } from "./dispatch.js";

/** The transport contract both `DiscoveryTool` and `ActionTool` satisfy (structurally). `call`'s
 *  return is serialized by `serializeResult`, so a tier may return `string[]`, an object, or an array
 *  of objects — all lower uniformly. */
export interface McpTool {
  readonly name: string;
  describe(clientInfo?: Record<string, unknown>): Promise<Tool>;
  call(args: any, ctx?: ToolCallCtx): Promise<unknown>;
}

/** Map an incoming call to its dispatch-time ctx (session/user/record). The adapter adds the
 *  request's own `signal`, so the resolver never supplies it. Omit the resolver for an anonymous,
 *  session-less wiring (still cancellable via the transport signal). */
export type CtxResolver = (
  params: { name: string; arguments?: Record<string, unknown> },
  clientInfo?: Record<string, unknown>,
) => Omit<ToolCallCtx, "signal"> | Promise<Omit<ToolCallCtx, "signal">>;

/** Register the tools on `mcp` (an `McpServer`), driving its low-level `.server` for dynamic
 *  ListTools/CallTool. An unknown tool, an abort, or an infra fault surfaces as an `isError` result;
 *  a tool's own structured failure (`success:false`) becomes `isError` via `serializeResult`; a
 *  DiscoveryTool REPL crash is normal content (an `(error …)` form). Do not mix with
 *  `mcp.registerTool` — these custom handlers replace McpServer's own tool dispatch. */
export function registerTools(mcp: McpServer, tools: readonly McpTool[], resolveCtx?: CtxResolver): void {
  const server = mcp.server; // low-level escape hatch — custom, dynamic ListTools/CallTool
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const clientInfo = () => server.getClientVersion() as Record<string, unknown> | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await Promise.all(tools.map((t) => t.describe(clientInfo()))),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };

    const base = (await resolveCtx?.(request.params, clientInfo())) ?? {};
    const args = request.params.arguments ?? {};
    try {
      // `call` returns `string[]` (DiscoveryTool) or a result object (ActionTool) — both are
      // `UserlandCallToolResult`-shaped; the one serializer lowers either.
      const result = (await tool.call(args, { ...base, signal: extra.signal })) as
        | UserlandCallToolResult
        | UserlandCallToolResult[];
      return await serializeResult(result);
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
}
