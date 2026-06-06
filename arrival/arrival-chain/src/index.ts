// ── Core ─────────────────────────────────────────────────────────────
export { type ModelBackend, type ModelSpec, type Completion, type TokenUsage, type DeltaSink, type NoticeSink, type StreamNotice } from "./model.js";
export { type ModelPrice, PRICE_MAP, priceFor, referenceCost } from "./pricing.js";
export {
  type InferCost,
  type ProjectedCost,
  type ProjectedCostStrategy,
  uncachedSumStrategy,
} from "./projected-cost.js";
export { type RunCost, runCostSummary, summarizeCosts, type TaskCost } from "./run-cost.js";
export {
  type ModelRouter,
  StaticRouter,
  LayeredRouter,
  singletonRouter,
  emptyRouter,
} from "./registry.js";

export {
  InferStore,
  type InferStoreLike,
  createInferStore,
  InferBinding,
  type InferCell,
  type InferCache,
  noopCache,
} from "./infer-store.js";

export { Run, Hypothesis, RunResult, RunError, formatRunError, type RunStatus } from "./run.js";
export { Draft } from "./draft.js";
// Re-exported from arrival-scheme where AValue lives (L4 collapsed the draft).
export {
  type AKind,
  ABool,
  ANil,
  AObject,
  APair,
  AProc,
  AString,
  ASymbol,
  AValue,
  EMPTY_PROVENANCE,
  pointProvenance,
  unionProvenance,
} from "@here.build/arrival-scheme";
// Re-export the LIPS→JS membrane so studio consumers can convert raw scheme
// values (Pair / cons cells captured in trace.Invocation.value) into plain JS
// without taking a direct dep on arrival-scheme.
export { lipsToJs } from "@here.build/arrival-scheme";
export { Program, ProgramVersion } from "./program.js";
export { Project, buildArrivalEnv, BUILTIN_PREAMBLE, type InferFn } from "./project.js";
export { ArrivalChain } from "./arrival-chain.js";
// `runPipeline` (the Node/CLI top-to-bottom entry) is deliberately NOT in this
// barrel: it lazy-imports yjs + y-websocket for the publish path, which the
// browser studio never runs but vite would still crawl off the barrel. It lives
// at the `@here.build/arrival-chain/runner` subpath — a Node-only entry — so the
// browser kernel stays free of the websocket-publish transport (materialization).
// Tests import it via the relative `./runner.js`.
export {
  defaultResolvers,
  defineImport,
  defineImportRosetta,
  defineRequireRosetta,
  loaderFromResolver,
  makeProjectLoader,
  type ContentResolver,
  type Loader,
  type RequireResolver,
  type ResolverResult,
} from "./loader.js";
export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";
export { extractDefines, type DefineInfo } from "./extract-defines.js";
export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "./statechart.js";
export {
  collapseMDL,
  type CandidateBox,
  type BoxType,
  type CollapseParams,
  type CollapseResult,
  type Decision,
} from "./mdl-collapse.js";
export { traceToForest, scopeId, type ForestOptions } from "./trace-to-forest.js";
export {
  traceToFlowGraph,
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowGraphOptions,
} from "./trace-to-flow-graph.js";
export { traceToFlowGraphNaive } from "./trace-to-flow-graph-naive.js";
export { traceToChain, type ProvenanceChain, type ChainNode, type ChainEdge } from "./trace-to-chain.js";
export { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
export { regionBoundaries, type RegionBoundary } from "./region-boundaries.js";
export { inferTasksByScope } from "./infer-content.js";

// ── Sweet-expression lens ─────────────────────────────────────────────
//
// classic↔sweet view over .scm source. `schemeToSweet` renders the stored
// canonical scheme as a readable "sweet" form (curly-infix, `=>` lambda, colon
// kwargs, `??` coalesce); `sweetToScheme` folds an edited sweet view back to
// canonical scheme, preserving every UNCHANGED top-level form byte-for-byte and
// reprinting only what changed (canonical reprint when the form correspondence is
// uncertain). Stored entities stay raw scheme — sweet is a derived editing lens.
// Studio's [scheme]/[sweet] editor toggle renders + saves the program through them.
export { schemeToSweet, type SweetOpts } from "./sweet-render.js";
export { sweetToScheme } from "./sweet-read.js";

// ── Backend authoring helpers ────────────────────────────────────────
//
// Concrete backends live as individual subpath modules:
//   import { openaiBackend }    from "@here.build/arrival-chain/backends/openai";
//   import { anthropicBackend } from "@here.build/arrival-chain/backends/anthropic";
//
// Compose them into a ModelRouter (StaticRouter / LayeredRouter) and
// pass to `createInferStore`. The shared helpers below are exported from
// the kernel for callers writing their own backends.
export {
  lazyBackend,
  parseChatPrompt,
  renderSchema,
  specMessages,
  type ChatMessage,
  type JsonSchema,
} from "./backends/_shared.js";
