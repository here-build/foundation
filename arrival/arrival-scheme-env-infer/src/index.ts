// @here.build/arrival-scheme-env-infer — the inference palette package.
//
// Two packs, built FOR REAL on `@here.build/arrival-inference` (the engine + the
// derive-entity/middleware algebra), with zero arrival-chain dependency:
//   • `arrivalInferCapability` (./infer)     — `infer` / `infer/chat`, no deps.
//   • `arrivalMcpCapability` + `arrivalAgenticCapability` (./mcp) — mcp dispatch + the
//     agentic loop (`deps: [infer]`), plus the MCP client membrane.
//
// The barrel exposes only what crosses the package boundary today. Most of the verb
// toolkit + membrane internals stay module-private (still `export`ed from ./infer / ./mcp
// for the packs' own tests, just not surfaced here). arrival-chain consumes:
//   - the three capabilities (rooted into its base env);
//   - `InferFn` (the host inference seam — also re-exported to host);
//   - the seal helpers its `.prompt` compiler (makeCompileInferUnit) still reaches for —
//     these disappear from the barrel once that seal moves into this package;
//   - the membrane symbols its host server-tape + mcp tests touch.

export {
  arrivalInferCapability,
  asLlmModel,
  canonicalizeMessages,
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
  type McpEffect,
  type McpEffectResolver,
  type McpMethod,
  resolveTools,
  runAgenticInfer,
} from "./mcp.js";
