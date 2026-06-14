// arrivalMcpCapability — the MCP dispatch verbs (`mcp/call`, `mcp/list`, `mcp/break`) as
// an EnvCapability.
//
// Same impl as `arrivalMcpPack`, reshaped onto the capability surface. This pack is
// HELPER-DELEGATING: it defines its verbs via `defineMcpRosettas(env, …)` (plus the
// `mcp/break` sentinel binding) rather than an inline method map, so it uses the `wire`
// escape hatch. The `McpEffectResolver` is CONFIG (validated by zod, optional — INERT
// until the host arms `mcp`), and `wire` passes `this.configuration.mcp ?? inertMcpResolver`
// to the same helpers mcp.ts uses.

import { captureSymbols, EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { defineMcpRosettas, inertMcpResolver, MCP_BREAK, type McpEffectResolver } from "../mcp-effects.js";

type McpActivation = Activation<{ mcp: z.ZodOptional<z.ZodType<McpEffectResolver>> }, Record<string, never>>;

export const arrivalMcpCapability = new EnvCapability("arrival/mcp", {
  configuration: { mcp: z.custom<McpEffectResolver>().optional() },
  // helper-delegating → a symbols BUILDER: run the same helpers mcp.ts uses against a
  // recording host, capturing the `mcp/*` verbs + the `mcp/break` sentinel binding as a
  // declarative symbol record (no re-homing).
  symbols: (a: McpActivation) =>
    captureSymbols((env) => {
      defineMcpRosettas(env as never, a.configuration.mcp ?? inertMcpResolver);
      env.set("mcp/break", MCP_BREAK);
    }),
});
