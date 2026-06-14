// arrivalAgenticCapability — agentic inference (`infer/agentic/end-to-end`), as an EnvCapability.
//
// Same impl as `arrivalAgenticPack`: lists the requested servers' tools and loops infer↔dispatch
// through the shared engine. The first DEP-BEARING capability — it depends on BOTH infer and mcp.
//
// `infer` is required config; `mcp` is optional (absent ⇒ the inert resolver's teaching error).
// `infer`/`mcp` are reshaped from `opts.*` to `this.configuration.*`.

import { EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { type InferFn, inferList, parseSchemeChatMessages, runAgenticInfer } from "../infer-kernel.js";
import { inertMcpResolver, isDerivableEntity, type McpEffectResolver } from "../mcp-effects.js";
import { arrivalInferCapability } from "./infer.js";
import { arrivalMcpCapability } from "./mcp.js";

type AgenticActivation = Activation<
  {
    infer: z.ZodType<InferFn>;
    mcp: z.ZodOptional<z.ZodType<McpEffectResolver>>;
  },
  Record<string, never>
>;

export const arrivalAgenticCapability = new EnvCapability("arrival/infer-agentic", {
  configuration: {
    infer: z.custom<InferFn>(),
    mcp: z.custom<McpEffectResolver>().optional(),
  },
  deps: [arrivalInferCapability, arrivalMcpCapability],
  symbols: {
    "infer/agentic/end-to-end": {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, messages: unknown, servers: unknown): List<SStr>",
      async fn(this: AgenticActivation, ctx: unknown, model: unknown, messages: unknown, servers: unknown) {
        const mcpResolve = this.configuration.mcp ?? inertMcpResolver;
        const serverVals = (Array.isArray(servers) ? servers : [servers])
          .filter(isDerivableEntity)
          .filter((s) => s.kind === "mcp");
        return inferList(
          await runAgenticInfer(
            this.configuration.infer,
            mcpResolve,
            ctx,
            model,
            parseSchemeChatMessages(messages),
            serverVals,
          ),
        );
      },
    },
  },
});
