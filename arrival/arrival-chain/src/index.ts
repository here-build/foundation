// ── Core ─────────────────────────────────────────────────────────────
export { type ModelBackend, type ModelSpec } from "./model.js";
export {
  type BackendRegistry,
  StaticRegistry,
  LayeredRegistry,
  singletonRegistry,
  emptyRegistry,
} from "./registry.js";
export { startOrchestrator, type OrchestratorOptions } from "./worker.js";

export { InferenceTask, InferenceResult, InferenceError } from "./task.js";
export { Program, ProgramVersion } from "./program.js";
export { Project } from "./project.js";
export { InferenceCache, ArrivalCache } from "./cache.js";
export { ArrivalChain } from "./arrival-chain.js";
export { runPipeline, type RunPipelineOptions, type PublishOptions } from "./runner.js";
export { type RequireResolver } from "./require.js";
export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";

// ── Backend authoring helpers ────────────────────────────────────────
//
// Concrete backends live as individual subpath modules:
//   import { openaiBackend }    from "@here.build/arrival-chain/backends/openai";
//   import { anthropicBackend } from "@here.build/arrival-chain/backends/anthropic";
//
// Compose them into a BackendRegistry (StaticRegistry/LayeredRegistry)
// and pass to startOrchestrator. The shared helpers below are exported
// from the kernel for callers writing their own backends.
export {
  lazyBackend,
  parseChatPrompt,
  renderSchema,
  specMessages,
  type ChatMessage,
  type JsonSchema,
} from "./backends/_shared.js";
