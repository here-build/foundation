// kernel-bridge — register a value-shaped `kernel.*` tool on the official server via the McpTool seam.
//
// The kernel arch (kernel/discovery.ts, kernel/action.ts) compiles a tool to { getToolDescription,
// execute|dispatch }. This adapts that compiled form to `McpTool` (name/describe/call), so a kernel
// tool registers on the same `McpServer` as our native `DiscoveryTool`/`ActionTool`. It is the
// TRANSITION seam: it lets `ArrivalServer` retire WITHOUT first rewriting the kernel tools — each can
// migrate to `DiscoveryTool`/`ActionTool` incrementally afterwards. Services are injected per session
// (closed into the `services` thunk), the same shape our native tools use — NOT pulled from a Hono
// context per call, which is what the legacy `toLegacy*Class` adapters required.

import type { ToolCallCtx } from "./DiscoveryTool.js";
import {
  type ActionTool,
  compileActionTool,
  compileDiscoveryTool,
  type DiscoveryTool,
  type Services,
} from "./kernel/index.js";
import type { McpTool } from "./sdk-adapter.js";

type DiscoveryArgs = { expr: string; intent?: string } & Record<string, unknown>;
type ActionArgs = { actions?: unknown; intent?: string } & Record<string, unknown>;

/** Bridge a compiled kernel DISCOVERY tool to `McpTool`. The session `state.__repl__` carries the
 *  honest-replay history across calls (kernel's own replay model — re-run on each call — is preserved
 *  verbatim; a later conversion to `DiscoveryTool` swaps in the structural cache). */
export function kernelDiscoveryToMcpTool<BaseCtx, Svc extends Services, Prep>(
  tool: DiscoveryTool<BaseCtx, Svc, Prep>,
  services: () => Svc,
): McpTool {
  const compiled = compileDiscoveryTool(tool);
  return {
    name: tool.name,
    describe: (clientInfo) => compiled.getToolDescription(clientInfo, services()),
    async call(args: DiscoveryArgs, ctx?: ToolCallCtx) {
      const { expr, intent: _intent, ...contextInput } = args;
      const state = ctx?.session?.state;
      const history = (state?.__repl__ as string[] | undefined) ?? [];
      const { result, replay } = await compiled.execute({ contextInput, expr, history }, services());
      history.push(replay);
      if (state) state.__repl__ = history;
      return result;
    },
  };
}

/** Bridge a compiled kernel ACTION tool to `McpTool` (the tuple-dispatch batch tier). */
export function kernelActionToMcpTool<BaseCtx, Svc extends Services, Prep>(
  tool: ActionTool<BaseCtx, Svc, Prep>,
  services: () => Svc,
): McpTool {
  const compiled = compileActionTool(tool);
  return {
    name: tool.name,
    describe: (clientInfo) => Promise.resolve(compiled.getToolDescription(clientInfo)),
    call(args: ActionArgs, _ctx?: ToolCallCtx) {
      const { actions, intent, ...contextInput } = args;
      return compiled.dispatch(
        { intent: typeof intent === "string" ? intent : "", actions: Array.isArray(actions) ? actions : [], contextInput },
        services(),
      );
    },
  };
}
