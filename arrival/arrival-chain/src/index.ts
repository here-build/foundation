// ── Core ─────────────────────────────────────────────────────────────
export { type RunCost, runCostSummary, summarizeCosts, type TaskCost } from "./run-cost.js";
export {
  lintRacyReads,
  lintRacyMcpCalls,
  type RacyReadFinding,
  type RacyMcpCallFinding,
  type SourceLocation,
} from "./racy-read-lint.js";

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
export { schemeToJs } from "@here.build/arrival-scheme";
// NOTE: schemeToJs above is from arrival-scheme (stays). The inference-runtime and
// provenance-analysis clusters are NOT re-exported here — import them directly from
// `@here.build/arrival-inference` and `@here.build/arrival-provenance`.
// `@arrival.private` — seal a host class opaque to Scheme (re-exported so `@here.build/arrival`
// consumers like sift can brand entities with the correct boundary symbol, not the forgeable hack).
export { arrival, markSandboxPrivate, markAsSandboxBoundary } from "@here.build/arrival-scheme";
export { Program, ProgramVersion } from "./program.js";
// NOTE: provenance trace-capture + analysis (EvalTrace, extractDefines, traceTo*,
// collapseMDL, slice/uneval, region tooling, trace-artifact, snapshotTrace) moved to
// `@here.build/arrival-provenance` — import directly from there.
export {
  Project,
  buildArrivalEnv,
  BUILTIN_PREAMBLE,
  type BuildArrivalEnvOpts,
  type InferFn,
  // The arrival capability vocabulary. `arrivalCapabilities()` is the default root-set buildArrivalEnv
  // lowers + assembles; the capability singletons (exported below) let a consumer assemble a
  // capability-scoped subset. `discoveryCapabilities()` is the read-plane root-set. loader-core is the
  // one raw `EnvPack` (the imperative plumbing floor), not a capability.
  type ArrivalEnv,
  arrivalCapabilities,
  discoveryCapabilities,
  arrivalLoaderCorePack,
  runNamed,
  runNamedCall,
  whyOf,
  whereOf,
  howOf,
  dagOf,
  ResultHandle,
  is_result_handle,
  isWireSafe,
  assertWireSafe,
  WireUnsafeError,
} from "./project.js";
// The capability palette: every chain pack is an EnvCapability (singleton-by-construction, zod
// config, lifecycle-bearing). loader-core is the sole exception (raw EnvPack — see note below).
// The inference cluster (infer / mcp / agentic) now lives in the env-infer package; chain
// consumes it one-way and re-exports here for back-compat.
export { arrivalAgenticCapability, arrivalInferCapability, arrivalMcpCapability } from "@here.build/arrival-scheme-env-infer";
export { arrivalUtilsCapability } from "./packs/utils.js";
export { arrivalReflectCapability } from "./packs/reflect.js";
export { arrivalBudgetCapability } from "./packs/budget.js";
export { arrivalRunCapability } from "./packs/run.js";
export { arrivalSourceReadCapability } from "./packs/source-read.js";
export { arrivalDataCapability } from "./packs/data.js";
// File-type resolvers as capabilities: `.hbs` (pure render lambda) and `.prompt` (sealed infer
// proc — resource-armed, see ext-prompt.ts). Both register via their prelude's
// `(require/register-extension …)`; the loader stays prompt/template-agnostic.
export { arrivalHandlebarsCapability } from "./packs/ext-handlebars.js";
export { arrivalPromptCapability } from "./packs/ext-prompt.js";
// NOTE: loader-core has NO capability form. Its `wire` calls the `defineRequire*Rosetta` helpers,
// which need the LIVE env at wire time to bake the `require` rosetta closure (no ctx thread). It
// keeps its `arrivalLoaderCorePack` (EnvPack) form, assembled in `packs/index.ts`. (The `.prompt`
// seal that USED to anchor loader-core here now lives in `ext/prompt`: it reaches the env lazily via
// the sealed proc's `withContext` ctx at CALL time — the move S5 made.)
export { arrivalSuperDefineCapability } from "./packs/superdefine.js";
// Env-pack capability-DAG assembly (P0–P4): the pack type + the construction/runtime assemblers, so a
// host can author extension packs and arm a `(require/extension :name)` registry.
export {
  assembleEnv,
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
} from "@here.build/arrival-scheme/env";
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
  type McpEffect,
  type McpEffectResolver,
  type McpMethod,
  describeMcpEffect,
  inertMcpResolver,
  wrapMcpResolver,
} from "./mcp-effects.js";
export { ArrivalChain } from "./arrival-chain.js";
// `runPipeline` (the Node/CLI top-to-bottom entry) is deliberately NOT in this
// barrel: it lazy-imports yjs + y-websocket for the publish path, which the
// browser studio never runs but vite would still crawl off the barrel. It lives
// at the `@here.build/arrival-chain/runner` subpath — a Node-only entry — so the
// browser kernel stays free of the websocket-publish transport (materialization).
// Tests import it via the relative `./runner.js`.
export {
  defaultResolvers,
  defineRequireRosetta,
  loaderFromResolver,
  makeProjectLoader,
  resolveRequireType,
  valueToTsType,
  type ContentResolver,
  type ExtensionHandler,
  type Loader,
  type RequireResolver,
  type RequireTypeProvider,
  type ResolverResult,
} from "./loader.js";
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
export {
  compileExposeSig,
  extractFormSpec,
  type ExposeSig,
  type FormFieldKind,
  type FormHole,
  type FormSpecOptions,
} from "./compile-expose-sig.js";
export {
  cellTriggers,
  cellRunnable,
  formsTrigger,
  formsRunnable,
  rootEffectEnv,
  EffectEnv,
  evalForm,
  PENETRATING_FORMS,
} from "./effect-analysis.js";
export { inferTasksByScope } from "./infer-content.js";

// ── Sweet-expression lens ─────────────────────────────────────────────
// The classic↔sweet lens moved to its own zero-dep package `@here.build/arrival-sweet`
// (schemeToSweet / sweetToScheme / readSweet / parseSexprs / alignSweetClassic / paramHints).
// Import it directly — it no longer rides the arrival-chain barrel or the `/sweet` subpath.

// ── Backend authoring helpers ────────────────────────────────────────
//
// The inference runtime — model spec/router, provider backends (openaiBackend /
// anthropicBackend / openrouterBackend / ollamaBackend / vercelBackend), pricing,
// the infer store, InferString, the agentic loop, and the chat-protocol kernel
// (chatBackend / openAICompatBackend / ChatProtocol) — lives in
// `@here.build/arrival-inference`. Import it directly.
//
// schema DSL → zod, routed through the single `tagToJsonSchema` lowering (no
// parallel recursion). Lets the SaaS validate exposed-fn request bodies against
// the same `(s/object …)` signature the inference path uses — wire schema and
// HTTP validator cannot drift.
export { schemaToZod, schemaSlotToZod } from "./schema-to-zod.js";
