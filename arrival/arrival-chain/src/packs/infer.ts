import type { EnvPack } from "../env-pack.js";
import {
  type ArrivalEnv,
  asLlmModel,
  BREAK_ON_SINGLE_INFER,
  type BuildArrivalEnvOpts,
  canonicalizeMessages,
  inferList,
  inferThroughChain,
  nullable,
  schemaSlot,
} from "../infer-kernel.js";
import { isMcpBreak } from "../mcp-effects.js";

/** Inference verbs (`infer`, `infer/chat`) — armed by `opts.infer`. */
export function arrivalInferPack(opts: Pick<BuildArrivalEnvOpts, "infer">): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/infer",
    config: opts.infer,
    apply: (env) => {
      env.defineRosetta("infer", {
        withContext: true,
        options: { provenancePoint: true },
        fn: async (ctx, model, prompt, schema, cacheKey) => {
          const { name, middleware, params } = asLlmModel(model);
          const honest = () =>
            opts.infer(ctx, name, String(prompt), schemaSlot(schema), nullable(cacheKey), undefined, params);
          const out = await inferThroughChain(honest, middleware, String(prompt), {});
          if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
          return inferList(out);
        },
      });
      env.defineRosetta("infer/chat", {
        withContext: true,
        options: { provenancePoint: true },
        fn: async (ctx, model, messages, schema, cacheKey) => {
          const { name, middleware, params } = asLlmModel(model);
          const prompt = canonicalizeMessages(messages);
          const honest = () => opts.infer(ctx, name, prompt, schemaSlot(schema), nullable(cacheKey), undefined, params);
          const out = await inferThroughChain(honest, middleware, prompt, {});
          if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
          return inferList(out);
        },
      });
    },
  };
}
