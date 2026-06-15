// @here.build/arrival-scheme-env-infer — the inference palette package.
//
// Two packs, built FOR REAL on `@here.build/arrival-inference` (the engine + the
// derive-entity/middleware algebra), with zero arrival-chain dependency:
//   • `arrivalInferCapability` (./infer)     — `infer` / `infer/chat`, no deps.
//   • `arrivalAgenticCapability` (./mcp)     — the mcp-tool agentic loop, deps: [infer].
//
// arrival-chain consumes these capabilities one-way (it arms them with a host InferFn /
// McpEffectResolver and roots them into its base env).

export {
  arrivalInferCapability,
  asLlmModel,
  BREAK_ON_SINGLE_INFER,
  canonicalizeMessages,
  inferList,
  inferThroughChain,
  type InferFn,
  nullable,
  schemaSlot,
} from "./infer.js";

export {
  arrivalAgenticCapability,
  arrivalMcpCapability,
  defineMcpRosettas,
  describeMcpEffect,
  dispatchThroughChain,
  inertMcpResolver,
  type McpCapabilities,
  type McpEffect,
  type McpEffectContext,
  type McpEffectResolver,
  type McpMethod,
  type McpRoster,
  type McpServerSpec,
  type McpToolAnnotations,
  type McpToolDescriptor,
  parseSchemeChatMessages,
  type ResolvedTools,
  resolveTools,
  runAgenticInfer,
} from "./mcp.js";
