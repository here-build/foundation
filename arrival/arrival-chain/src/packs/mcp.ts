import type { EnvPack } from "@here.build/arrival-scheme/env";
import { type ArrivalEnv, type BuildArrivalEnvOpts } from "../infer-kernel.js";
import { defineMcpRosettas, inertMcpResolver, MCP_BREAK } from "../mcp-effects.js";

/** MCP dispatch verbs (`mcp/call`, `mcp/list`, `mcp/break`) — INERT until the host arms `opts.mcp`. */
export function arrivalMcpPack(opts: Pick<BuildArrivalEnvOpts, "mcp">): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/mcp-effects",
    config: opts.mcp,
    apply: (env) => {
      defineMcpRosettas(env, opts.mcp ?? inertMcpResolver);
      env.set("mcp/break", MCP_BREAK);
    },
  };
}
