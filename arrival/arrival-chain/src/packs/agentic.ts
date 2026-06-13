import type { EnvPack } from "../env-pack.js";
import {
  type ArrivalEnv,
  type BuildArrivalEnvOpts,
  inferList,
  parseSchemeChatMessages,
  runAgenticInfer,
} from "../infer-kernel.js";
import { inertMcpResolver, isDerivableEntity } from "../mcp-effects.js";

/** Agentic inference (`infer/agentic/end-to-end`) — the first DEP-BEARING pack: deps BOTH infer and
 *  mcp, so C3 orders them before it. The caller passes the SAME pack instances it lists as roots. */
export function arrivalAgenticPack(
  opts: Pick<BuildArrivalEnvOpts, "infer" | "mcp">,
  deps: readonly EnvPack<ArrivalEnv>[],
): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/infer-agentic",
    deps,
    config: opts.infer,
    apply: (env) => {
      const mcpResolve = opts.mcp ?? inertMcpResolver;
      env.defineRosetta("infer/agentic/end-to-end", {
        withContext: true,
        options: { provenancePoint: true },
        fn: async (ctx, model, messages, servers) => {
          const serverVals = (Array.isArray(servers) ? servers : [servers])
            .filter(isDerivableEntity)
            .filter((s) => s.kind === "mcp");
          return inferList(
            await runAgenticInfer(opts.infer, mcpResolve, ctx, model, parseSchemeChatMessages(messages), serverVals),
          );
        },
      });
    },
  };
}
