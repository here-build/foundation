// @here.build/arrival-scheme-env-infer — the inference palette package.
//
// Stands on `@here.build/arrival-inference` (the engine + the derive-entity/middleware algebra)
// and depends only DOWN — no arrival-chain import — which is the whole reason it's a separate
// package: it isolates the inference dep out of the chain core, and the dependency edge runs
// chain → here, never back. Three capabilities, in a deliberate dep order:
//   • `arrivalDeriveCapability` (./derive) — the pure entity/derive algebra (`mcp`/`llm`/`derive`).
//   • `arrivalInferCapability`  (./infer)  — `infer`/`infer/chat`; `deps: [derive]` (needs `llm`).
//   • `arrivalMcpCapability` + `arrivalAgenticCapability` (./mcp) — mcp dispatch + the agentic loop.
//
// The barrel surfaces only what crosses the package boundary. The rest stays module-private
// (still `export`ed from the source files for their own tests, just not re-exported here). What
// leaves: the capabilities (rooted into chain's base env); `InferFn` (the host inference seam,
// also reaching the host); the seal helpers chain's `sealPromptUnit` imports (`asLlmModel`,
// `canonicalizeMessages`, `schemaSlot`, `nullable` — the seal lives in chain because it also needs
// the handlebars render, so it pulls these in rather than the reverse); the membrane symbols the
// host server-tape + mcp tests touch.

export {
  arrivalInferCapability,
  asLlmModel,
  canonicalizeMessages,
  type InferFn,
  nullable,
  schemaSlot,
} from "./infer.js";

export { arrivalDeriveCapability } from "./derive.js";

export {
  arrivalAgenticCapability,
  arrivalMcpCapability,
  describeMcpEffect,
  inertMcpResolver,
  type McpEffect,
  type McpEffectResolver,
  type McpMethod,
  type McpServerSpec,
  type McpRoster,
  runAgenticInfer,
} from "./mcp.js";
