// sdk-adapter — wire an array of DiscoveryTools onto the OFFICIAL @modelcontextprotocol/sdk Server.
//
// The whole bridge is two handlers: `describe()` → tools/list, `call()` → tools/call. Because a
// DiscoveryTool is a plain value (not a subclass), the tools are just an array you register — and the
// SAME `describe`/`call` surface would back ArrivalServer or any other transport. The SDK's
// per-request AbortSignal (`extra.signal` — cancel / timeout / disconnect) is threaded straight into
// the eval's TICK check; the host supplies the rest of the dispatch ctx (session/user/record).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { DiscoveryTool, ToolCallCtx } from "./DiscoveryTool.js";

/** Map an incoming call to its dispatch-time ctx (session/user/record). The adapter adds the
 *  request's own `signal`, so the resolver never supplies it. Omit the resolver for an anonymous,
 *  session-less wiring (still cancellable via the transport signal). */
export type CtxResolver = (
  params: { name: string; arguments?: Record<string, unknown> },
  clientInfo?: Record<string, unknown>,
) => Omit<ToolCallCtx, "signal"> | Promise<Omit<ToolCallCtx, "signal">>;

/** Register the discovery tools on `server`. A failed call surfaces as an `isError` tool result (a
 *  readable door), not a transport-level fault — so the actor sees the message and keeps going. */
export function registerDiscoveryTools(
  server: Server,
  tools: readonly DiscoveryTool[],
  resolveCtx?: CtxResolver,
): void {
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const clientInfo = () => server.getClientVersion() as Record<string, unknown> | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await Promise.all(tools.map((t) => t.describe(clientInfo()))),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };

    const base = (await resolveCtx?.(request.params, clientInfo())) ?? {};
    const args = (request.params.arguments ?? {}) as { expr: string } & Record<string, unknown>;
    try {
      const out = await tool.call(args, { ...base, signal: extra.signal });
      return { content: out.map((text) => ({ type: "text", text })) };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
