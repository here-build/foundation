// arrivalInferCapability — the inference verbs as an EnvCapability.
//
// Same impl as `arrivalInferPack` (it lives here BECAUSE infer-kernel's helpers are
// here — no extraction needed), reshaped onto the capability surface: the InferFn is
// CONFIG (validated by zod), the verbs are METHODS reading `this.configuration.infer`.
// Demonstrates the config-armed + rosetta-spec method shape on a production pack.

import { EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { isMcpBreak } from "../mcp-effects.js";
import {
  asLlmModel,
  BREAK_ON_SINGLE_INFER,
  type BuildArrivalEnvOpts,
  canonicalizeMessages,
  inferList,
  inferThroughChain,
  nullable,
  schemaSlot,
} from "../infer-kernel.js";

type InferFn = BuildArrivalEnvOpts["infer"];
type InferActivation = Activation<{ infer: z.ZodType<InferFn> }, Record<string, never>>;

export const arrivalInferCapability = new EnvCapability("arrival/infer", {
  configuration: { infer: z.custom<InferFn>() },
  symbols: {
    infer: {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, prompt: SStr, schema?: unknown, cacheKey?: unknown): List<SStr>",
      async fn(this: InferActivation, ctx: unknown, model: unknown, prompt: unknown, schema: unknown, cacheKey: unknown) {
        const { name, middleware, params } = asLlmModel(model);
        const honest = () =>
          this.configuration.infer(ctx as Parameters<InferFn>[0], name, String(prompt), schemaSlot(schema), nullable(cacheKey), undefined, params);
        const out = await inferThroughChain(honest, middleware, String(prompt), {});
        if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
        return inferList(out);
      },
    },
    "infer/chat": {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, messages: unknown, schema?: unknown, cacheKey?: unknown): List<SStr>",
      async fn(this: InferActivation, ctx: unknown, model: unknown, messages: unknown, schema: unknown, cacheKey: unknown) {
        const { name, middleware, params } = asLlmModel(model);
        const prompt = canonicalizeMessages(messages);
        const honest = () =>
          this.configuration.infer(ctx as Parameters<InferFn>[0], name, prompt, schemaSlot(schema), nullable(cacheKey), undefined, params);
        const out = await inferThroughChain(honest, middleware, prompt, {});
        if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
        return inferList(out);
      },
    },
  },
});
