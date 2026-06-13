// ── Core ─────────────────────────────────────────────────────────────
export { type ModelBackend, type ModelSpec, type Completion, type TokenUsage, type DeltaSink, type NoticeSink, type StreamNotice, type ToolDescriptor, type ToolCall, type Chunk } from "@here.build/arrival-inference";
export { type ModelPrice, PRICE_MAP, priceFor, referenceCost, type ModelSpeed, SPEED_MAP, speedFor, effectiveCloudMs } from "@here.build/arrival-inference";
export {
  type InferCost,
  type ProjectedCost,
  type ProjectedCostStrategy,
  uncachedSumStrategy,
} from "@here.build/arrival-inference";
export { type RunCost, runCostSummary, summarizeCosts, type TaskCost } from "./run-cost.js";
export { RunSpend } from "@here.build/arrival-inference";
export {
  lintRacyReads,
  lintRacyMcpCalls,
  type RacyReadFinding,
  type RacyMcpCallFinding,
  type SourceLocation,
} from "./racy-read-lint.js";
export {
  type ModelRouter,
  StaticRouter,
  LayeredRouter,
  singletonRouter,
  emptyRouter,
} from "@here.build/arrival-inference";

export {
  InferStore,
  type InferStoreLike,
  createInferStore,
  InferBinding,
  type InferCell,
  type InferCache,
  noopCache,
} from "@here.build/arrival-inference";

export { Run, Hypothesis, RunResult, RunError, formatRunError, type RunStatus } from "./run.js";
export { Draft } from "./draft.js";
// Effect-log — the per-run record of every external effect (infer/http/sql) +
// the replay / partial-invalidation machinery. `effectLogCollector` builds a
// run's log in one pass (feed `onEffectResult`); `invalidateForwardCone`
// subtracts a changed node's blast radius for minimal recomputation. The
// kind-tagged key constructors keep the three effect kinds in one disjoint space.
export {
  type EffectKind,
  type EffectLog,
  DataBinding,
  dataEffectKey,
  effectKey,
  effectKeysByInvocation,
  effectLogCollector,
  httpEffectKey,
  inferEffectKey,
  invalidateForwardCone,
  invalidatedEffectKeys,
  McpBinding,
  mcpEffectKey,
  sqlEffectKey,
  stableJson,
  subtractKeys,
} from "./effect-log.js";
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
// `@arrival.private` — seal a host class opaque to Scheme (re-exported so `@here.build/arrival`
// consumers like sift can brand entities with the correct boundary symbol, not the forgeable hack).
export { arrival, markSandboxPrivate, markAsSandboxBoundary } from "@here.build/arrival-scheme";
export { Program, ProgramVersion } from "./program.js";
export {
  Project,
  buildArrivalEnv,
  BUILTIN_PREAMBLE,
  type BuildArrivalEnvOpts,
  type InferFn,
  // Atomic capability packs (P5): the composable arrival capability vocabulary. `arrivalPacks(opts)`
  // is the default root-set buildArrivalEnv assembles; the individual factories let a consumer
  // assemble a capability-scoped subset.
  type ArrivalEnv,
  arrivalPacks,
  arrivalInferPack,
  arrivalUtilsPack,
  arrivalBudgetPack,
  arrivalDataPack,
  arrivalMcpPack,
  arrivalSuperDefinePack,
  arrivalAgenticPack,
  arrivalLoaderCorePack,
} from "./project.js";
// Env-pack capability-DAG assembly (P0–P4): the pack type + the construction/runtime assemblers, so a
// host can author extension packs and arm a `(require/extension :name)` registry.
export {
  assembleEnv,
  assembleEnvSync,
  createRuntimeAssembler,
  type AssembledEnv,
  type EnvPack,
  type PackContext,
  type RuntimeAssembler,
  AssembleCycleError,
  AssembleConfigConflictError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
} from "./env-pack.js";
export { defineRequireExtensionRosetta } from "./require-extension.js";
export {
  buildChainEnv,
  ChainEnvironment,
  type ChainConfig,
  type ChainModelSpec,
  type ChainExtension,
  type ChainInitContext,
} from "./chain-env.js";
// Data-effect host capability — the membrane `(http/*)` / `(sql/query)` cross.
// The SaaS host injects a `DataEffectResolver` (label→credential, egress-safe);
// the OSS engine ships the verbs inert. Twin of `InferFn`. See `data-effects.ts`.
export {
  type DataEffect,
  type DataEffectContext,
  type DataEffectResolver,
  type DataEffectResult,
  type HttpEffect,
  type HttpMethod,
  type SqlEffect,
  type RosettaHost,
  defineDataEffectRosettas,
  describeDataEffect,
  inertDataResolver,
} from "./data-effects.js";
// MCP host capability — the client-side membrane `(mcp/call …)` / `(mcp/list …)`
// cross. The host injects an `McpEffectResolver` (roster → credentialed SDK client);
// the OSS engine ships the verbs inert. The SDK + transport live host-side, NEVER
// here (eject boundary — only the value-only seam + inert/wrap/define). See
// `mcp-effects.ts`.
export {
  type McpCapabilities,
  type McpEffect,
  type McpEffectContext,
  type McpEffectResolver,
  type McpMethod,
  type McpRoster,
  type McpServerSpec,
  type McpToolAnnotations,
  type McpToolDescriptor,
  defineMcpRosettas,
  describeMcpEffect,
  inertMcpResolver,
  wrapMcpResolver,
} from "./mcp-effects.js";
// The rich inference response — a string-transparent value carrying `reasoning` +
// `chunks` as external-only side-data. See `infer-string.ts`.
export { InferString } from "@here.build/arrival-inference";
// The agentic-loop driver (the core of `infer/agentic/end-to-end`), exported so a host can
// run a tool-using agent over its own infer + MCP dispatch without going through project.run.
export {
  runAgenticLoop,
  DEFAULT_AGENTIC_MAX_ROUNDS,
  type AgenticTurn,
  type AgenticDeps,
  type AgenticResult,
} from "@here.build/arrival-inference";
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
// Provenance-analysis cluster — moved to `@here.build/arrival-provenance`; these
// re-exports keep the arrival-chain barrel back-compat for existing consumers.
export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "@here.build/arrival-provenance";
export { extractDefines, type DefineInfo } from "@here.build/arrival-provenance";
// `(declare/expose …)` — the sealed-skill form. Static signature extraction
// (the config-plane sync path; the handler never runs) + the runtime
// declaration the host registry consumes (`OnExpose`, wired into
// `buildArrivalEnv`). `SourceLocation` is intentionally NOT re-exported here —
// the barrel already surfaces a (differently-shaped) one from `racy-read-lint`;
// import the parse-form location type directly from `./extract-expose.js`.
export {
  extractExpose,
  extractOverridables,
  extractRequires,
  extractReachableOverridables,
  type ExposeInfo,
  type OverridableInfo,
  type ReachableExposed,
  EXPOSE_FORM,
  EXPOSED_DEFINE_HEAD,
  OVERRIDABLE_DEFINE_HEAD,
} from "./extract-expose.js";
export { defineExposeRosetta, type ExposeDeclaration, type OnExpose } from "./expose.js";
// The superpowered-define family: `define/overridable` (host-overridable
// binding with a declared default + schema) + `define/exposed` (expose with a
// derived overridable arg surface). Both are preamble macros lowering to a plain
// `(define name (<rosetta> …))` so the interpreter core stays domain-free. The
// binding's NAME is its identity — no derived token (renaming a public function
// is a breaking change by design, caught by the dangling-binding linter).
export {
  defineOverridableRosetta,
  type OverridableDescriptor,
  type OnOverridable,
  type ResolveOverride,
  OVERRIDABLE_FORM,
} from "./overridable.js";
// The human-in-the-loop approval gate: `(run/continue-after-approval spec result)`
// THUNKS the irreversible value, awaits a human verdict over a reactive
// `FunctionRunApprovalRequest`, and only then runs + releases the go-token. Local/
// sandbox auto-approves when no approver is wired. Durable suspend is next (ADR-025).
export {
  defineApprovalRosetta,
  FunctionRunApprovalRequest,
  FunctionRunApprovalResult,
  FunctionRunApprovalReject,
  ApprovalRejected,
  type OnApprovalRequest,
  type ResolveApproval,
  APPROVAL_FORM,
} from "./approval.js";
// The bridge from static `(declare/expose …)` extraction to the canonical
// tagged-list signature the registry stores: evaluates ONLY the pure
// `:input`/`:output` schema slices (never the handler), so a config-plane
// registry sync can run it on every draft edit safely. Feeds `schemaToZod`.
export { compileExposeSig, extractFormSpec, type ExposeSig, type FormFieldKind, type FormHole, type FormSpecOptions } from "./compile-expose-sig.js";
export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "@here.build/arrival-provenance";
export {
  collapseMDL,
  type CandidateBox,
  type BoxType,
  type CollapseParams,
  type CollapseResult,
  type Decision,
} from "@here.build/arrival-provenance";
export { traceToForest, scopeId, type ForestOptions } from "@here.build/arrival-provenance";
export {
  traceToFlowGraph,
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowGraphOptions,
} from "@here.build/arrival-provenance";
export { traceToFlowGraphNaive } from "@here.build/arrival-provenance";
export { traceToChain, type ProvenanceChain, type ChainNode, type ChainEdge } from "@here.build/arrival-provenance";
export { traceToRegions, type Region, type RegionGraph } from "@here.build/arrival-provenance";
// Incremental twin of `traceToRegions` — maintains the same RegionGraph in O(Δ) per streamed tick (vs O(N) full rebuild) for the live blueprint render. Parity-locked to traceToRegions.
export { TraceRegionFold } from "@here.build/arrival-provenance";
export { serializeTrace, loadTraceArtifact, TRACE_PROTOCOL_VERSION, type TraceArtifact } from "@here.build/arrival-provenance";
export { regionBoundaries, type RegionBoundary } from "@here.build/arrival-provenance";
export { buildSlice, writeForm, referencedSymbols, defineNameOf, lastTopLevelForm, resolveReadIds, type Slice } from "@here.build/arrival-provenance";
export { cellTriggers, formsTrigger, rootEffectEnv, EffectEnv, evalForm, PENETRATING_FORMS } from "./effect-analysis.js";
export { buildUneval, type Uneval, type UnevalContainer } from "@here.build/arrival-provenance";
export { inferTasksByScope } from "./infer-content.js";

// ── Sweet-expression lens ─────────────────────────────────────────────
// The classic↔sweet lens moved to its own zero-dep package `@here.build/arrival-sweet`
// (schemeToSweet / sweetToScheme / readSweet / parseSexprs / alignSweetClassic / paramHints).
// Import it directly — it no longer rides the arrival-chain barrel or the `/sweet` subpath.

// ── Backend authoring helpers ────────────────────────────────────────
//
// Concrete backends live as individual subpath modules:
//   import { openaiBackend }     from "@here.build/arrival-chain/backends/openai";
//   import { anthropicBackend }  from "@here.build/arrival-chain/backends/anthropic";
//   import { openrouterBackend } from "@here.build/arrival-chain/backends/openrouter";
//
// `openrouterBackend` is the OpenAI-compatible backend plus provider-cost capture
// (`usage.cost` → `providerCostMicroUsd`) — the resale-billing path; direct
// `openaiBackend`/`anthropicBackend` report tokens only (billing on referenceCost).
//
// Compose them into a ModelRouter (StaticRouter / LayeredRouter) and pass to
// `createInferStore`. The shared helpers below are the kernel for callers writing
// their own backends: a backend is a `ChatProtocol` (five seams — buildBody / call /
// toolCalls / text / usage, + optional stream) handed to `chatBackend`, which supplies
// the shared completion arc (retry, tool-vs-text, coercion ladder). `openAICompatBackend`
// is the OpenAI-protocol instance every chat-completions endpoint reuses.
export {
  chatBackend,
  lazyBackend,
  openAICompatBackend,
  openAIRequestBody,
  parseModelValue,
  parseChatPrompt,
  renderSchema,
  tagToJsonSchema,
  specMessages,
  type ChatProtocol,
  type ChatMessage,
  type JsonSchema,
  type OpenAICompatUsage,
  type OpenAICompatBackendOptions,
  type CostFromUsage,
  type ParseDiag,
} from "@here.build/arrival-inference";
// schema DSL → zod, routed through the single `tagToJsonSchema` lowering (no
// parallel recursion). Lets the SaaS validate exposed-fn request bodies against
// the same `(s/object …)` signature the inference path uses — wire schema and
// HTTP validator cannot drift.
export { schemaToZod, schemaSlotToZod } from "./schema-to-zod.js";
