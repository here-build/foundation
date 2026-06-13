// chain-env.ts — the declarative chain runtime.
//
// A "chain" is an arrival environment that runs LLM-driven programs. Today every consumer
// hand-wires the SAME spine: a model router, an infer-store, a retrying infer closure, the
// arrival env, then a stack of extension registrars — ~300 lines of imperative setup. This
// collapses all of it behind ONE declaration:
//
//   const chain = buildChainEnv({ name, models, loader, mcp?, extensions? });
//   await chain.init();              // bridge boot + extension init (servers, etc.)
//   const { result } = await chain.run("entry.scm");
//   await chain.dispose();
//
// THE MEMBRANE: the *program* names models — `(define ideator (llm "claude-opus-4-8"))` then
// `(infer ideator …)` — and the *config* arms each id with a backend + credentials. The id IS
// the config key: NO remap, no `owl-alpha → SIFT_OWL_MODEL` indirection. Intent (which model,
// used where) lives in the program; materialization (backend, key) lives host-side in `models`.

import invariant from "tiny-invariant";
import { execGeneratorFromString, lipsToJs } from "@here.build/arrival-scheme";
import { buildArrivalEnv, BUILTIN_PREAMBLE, inferIdentityKey, type InferFn } from "./project.js";
import { assembleEnv, type AssembledEnv, type EnvPack, type RuntimeAssembler } from "./env-pack.js";
import { InferString } from "@here.build/arrival-inference";
import { EvalTrace } from "./trace.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelRouter } from "@here.build/arrival-inference";
import type { ModelBackend } from "@here.build/arrival-inference";
import type { Loader } from "./loader.js";
import type { McpEffectResolver } from "./mcp-effects.js";

/** A configured model: the host-side materialization of a model id the program names. */
export interface ChainModelSpec {
  provider: "openai-compatible" | "anthropic" | "ollama";
  /** openai-compatible / ollama endpoint. */
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** ollama only: per-request thinking. */
  think?: boolean;
  /** The wire model name sent to the provider, when it differs from the registry key the
   *  program names. Pure materialization: the program says `(llm "ideator")`, this arms that
   *  id with `model:"claude-opus-4-8"` so the backend asks the provider for the real model —
   *  the one place a logical program-id and a concrete provider-id legitimately diverge (NOT a
   *  remap: there's no env indirection, just the host stating which model this id resolves to).
   *  Omitted ⇒ the id IS the wire name (the common case: `(llm "zai-org/glm-4.7-flash")`). */
  model?: string;
}

type ChainEnv = ReturnType<typeof buildArrivalEnv>;

/** Context handed to an extension's `init` — enough to build a same-router narrator, read the
 *  run id, and register late rosettas. */
export interface ChainInitContext {
  env: ChainEnv;
  router: ModelRouter;
  runId: string;
  /** The chain's resolved infer capability — the SAME store-backed seam every `(infer …)`
   *  role uses. An extension (the agentic scout) drives its own loop through this, so its
   *  per-round inference gets caching / timing / trace cards / cost for free. Tool-aware:
   *  pass `tools` (7th/6th args) for an agentic turn → an InferString with toolCalls back. */
  infer: InferFn;
}

/** A composable env-extension: register rosettas synchronously, optionally materialize an
 *  imperative resource at `init` (a server, a connection — gated by the extension itself), and
 *  tear it down at `dispose`. This is the SAME shape `defineProgress` already uses. */
export interface ChainExtension {
  register(env: ChainEnv): void;
  init?(ctx: ChainInitContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Adapt a `ChainExtension` to an `EnvPack` (P3: the register/init/dispose triad dissolves into one
 *  capability `apply`). The extension's register → init runs in a single pass, and its `dispose`
 *  becomes an `onDispose` thunk torn down LIFO by the assembled env. Extensions carry no `deps`
 *  (their registrations are disjoint — order-immaterial); a future coupled extension declares a dep
 *  rather than relying on array order. The name is positional (extensions are anonymous). */
function extensionToPack(ext: ChainExtension, index: number, initCtx: ChainInitContext): EnvPack<ChainEnv> {
  return {
    name: `chain/extension-${index}`,
    apply: async (env, ctx) => {
      ext.register(env);
      await ext.init?.(initCtx);
      if (ext.dispose) ctx.onDispose(ext.dispose.bind(ext));
    },
  };
}

export interface ChainConfig {
  name: string;
  /** id → backend. The program names ids; this arms them. No remap. */
  models: Record<string, ChainModelSpec>;
  /** Override the resolved infer capability (skips the model-registry router + store). A test
   *  passes a canned resolver to drive the whole loop offline; production omits it and the chain
   *  builds infer from `models`. */
  infer?: InferFn;
  loader: Loader;
  tap?: EvalTrace;
  mcp?: McpEffectResolver;
  extensions?: ChainExtension[];
  /** Host-armed registry of named extension packs for `(require/extension :name)`. Programs reach a
   *  capability by name; the host decides what each resolves to. Absent ⇒ the verb is unbound. */
  extensionRegistry?: ReadonlyMap<string, EnvPack<ChainEnv>>;
  /** A stable id for this run (the progress room, etc.). Defaults to the chain name. */
  runId?: string;
  /** Transient-failure retry budget per infer call. Default 3. */
  maxInferRetry?: number;
}

/** Construct the concrete backend for a configured model. The provider→backend map — the one
 *  place that knows vercel vs ollama — replacing every consumer's hand-rolled router switch. */
async function makeBackend(spec: ChainModelSpec): Promise<ModelBackend> {
  // Backends are DYNAMICALLY imported per provider, so a browser bundle never
  // pulls a node-only transport (ollama → node:http) it will never select. Each
  // provider's module is its own lazy chunk; only the selected one loads.
  const inner = await (async (): Promise<ModelBackend> => {
    switch (spec.provider) {
      case "anthropic": {
        const { vercelBackend } = await import("./backends/vercel.js");
        return vercelBackend({ provider: "anthropic", ...(spec.apiKey ? { apiKey: spec.apiKey } : {}), ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}) });
      }
      case "ollama": {
        const { ollamaBackend } = await import("./backends/ollama.js");
        return ollamaBackend({ ...(spec.baseURL ? { baseURL: spec.baseURL } : {}), ...(spec.think !== undefined ? { think: spec.think } : {}), ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}) });
      }
      case "openai-compatible":
      default: {
        const { vercelBackend } = await import("./backends/vercel.js");
        return vercelBackend({
          provider: "openai-compatible",
          ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
          ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
          ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
        });
      }
    }
  })();
  // Wire-name override: the program named a logical id (the registry key reaching `complete`
  // as `spec.model`); rewrite it to the configured provider model. Materialization only —
  // identity/caching upstream still keys on the program id, so two logical ids backed by the
  // same wire model stay distinct cells.
  if (spec.model === undefined) return inner;
  const wire = spec.model;
  return { complete: (s) => inner.complete({ ...s, model: wire }) };
}

/** A transient failure worth re-rolling: an infra blip or a bounded truncation. A single
 *  slow/flaky call must not crash a long autonomous run; the cell is evicted so each retry
 *  re-rolls a fresh request. (Streaming backends rarely hit this now, but the net stays.) */
function isTransient(e: unknown): boolean {
  const err = e as { cause?: unknown; code?: unknown; message?: string };
  const s = `${err?.message ?? ""} ${String(err?.cause ?? "")} ${String(err?.code ?? "")} ${String(e)}`.toLowerCase();
  return /timeout|timedout|etimedout|terminated|aborted|econnreset|socket|fetch failed|und_err|network|503|502|429|unparseable|truncated|cut off|finish=length|streamed no content/.test(s);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Build the retrying infer closure over the store. NO remap — the model name from scheme is
 *  the config key, resolved directly to a backend by the router.
 *
 *  TOOL-AWARE: when `tools` are passed (the agentic scout path), they ride the ModelSpec to the
 *  backend AND fold into the cache key (`inferIdentityKey`), so a tool-enabled turn caches
 *  honestly and replays. The result is wrapped in an `InferString` carrying the turn's
 *  `toolCalls` — exactly the shape the agentic loop reads — so the scout's per-round inference
 *  runs on the SAME store seam as every other role: caching, timing, trace cards, cost. */
function makeInfer(store: ReturnType<typeof createInferStore>, maxRetry: number, trace: boolean): InferFn {
  return (async (_ctx, modelIn, prompt, schema, cacheKey, tools, params) => {
    const model = String(modelIn);
    const hasTools = tools !== undefined && tools.length > 0;
    const idKey = inferIdentityKey((cacheKey ?? null) as string | null, tools, params);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      const cell = store.get(
        { model, prompt: String(prompt), schema: (schema ?? null) as string | null, ...(hasTools ? { tools } : {}), ...(params ?? {}) },
        idKey,
      );
      cell.acquire();
      try {
        const completion = await cell.done;
        if (trace) {
          // eslint-disable-next-line no-console
          console.error(`\x1b[36m[infer ${String(cacheKey)}]\x1b[0m ${JSON.stringify(completion.value).slice(0, 600)}`);
        }
        // Tool turn ⇒ an InferString carrying the toolCalls (the agentic loop reads them);
        // plain ⇒ the bare value, byte-identical to before.
        return hasTools ? new InferString(String(completion.value ?? ""), "", [], completion.toolCalls ?? []) : completion.value;
      } catch (e) {
        lastErr = e;
        if (!isTransient(e) || attempt === maxRetry) throw e;
        await sleep(1000 * attempt);
      } finally {
        cell.release();
      }
    }
    throw lastErr;
  }) as InferFn;
}

/** A declaratively-configured arrival environment that runs chains. Owns the router, the
 *  infer-store, the env, the extension stack, and the init/dispose lifecycle. */
export class ChainEnvironment {
  readonly env: ChainEnv;
  readonly router: ModelRouter;
  readonly infer: InferFn;
  private readonly exts: ChainExtension[];
  private readonly runId: string;
  private readonly tap: EvalTrace;
  private started = false;
  private assembledExts?: AssembledEnv<ChainEnv>;
  private extAssembler?: RuntimeAssembler<ChainEnv>;

  constructor(config: ChainConfig) {
    const models = config.models;
    const cache = new Map<string, ModelBackend>();
    this.router = {
      async backendFor(modelId: string): Promise<ModelBackend> {
        const spec = models[modelId];
        invariant(!!spec, () => `chain: model "${modelId}" is not configured — declared models: ${Object.keys(models).join(", ") || "(none)"}`);
        let b = cache.get(modelId);
        if (!b) { b = await makeBackend(spec); cache.set(modelId, b); }
        return b;
      },
    };
    this.runId = config.runId ?? config.name;
    this.tap = config.tap ?? new EvalTrace();
    // The infer capability: a caller-supplied override (tests drive the loop offline), else built
    // from the model registry — the router resolves each program-named id straight to a backend.
    const store = createInferStore(this.router);
    const infer = config.infer ?? makeInfer(store, config.maxInferRetry ?? 3, Boolean(process.env.SIFT_TRACE));
    this.infer = infer;
    this.env = buildArrivalEnv({
      name: config.name,
      infer,
      loader: config.loader,
      tap: this.tap,
      ...(config.mcp ? { mcp: config.mcp } : {}),
      ...(config.extensionRegistry
        ? {
            extensionRegistry: config.extensionRegistry,
            onExtensionAssembler: (a) => {
              this.extAssembler = a;
            },
          }
        : {}),
    });
    this.exts = config.extensions ?? [];
    // P3: registration is deferred to async init() — the env-pack assembly is the single pass that
    // registers, initializes, and records teardown for every extension. Nothing touches the env
    // between construction and init() (run() awaits init() first), so deferring register is safe.
  }

  /** Bridge boot + the extension capability-DAG assembly (register + init + dispose, one pass). */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.env.init();
    const initCtx: ChainInitContext = { env: this.env, router: this.router, runId: this.runId, infer: this.infer };
    // Roots reversed so the least-precedence-first apply order matches the extensions' array order
    // (C3 applies highest-precedence root last). Order is immaterial for disjoint registrations, but
    // preserving array order keeps behavior identical to the pre-P3 register/init loops.
    const packs = this.exts.map((ext, i) => extensionToPack(ext, i, initCtx)).reverse();
    this.assembledExts = await assembleEnv(this.env, packs);
  }

  /** Run a scheme program string (already loaded). Returns the JS-projected last value + trace.
   *  Never throws on a program error — reports it as `["error", message]` with the trace so far,
   *  matching the autonomous-run discipline. Call `init()` first (idempotent if not). */
  async run(source: string): Promise<{ result: unknown; trace: EvalTrace }> {
    await this.init();
    try {
      const results = await execGeneratorFromString(BUILTIN_PREAMBLE + source, { env: this.env, tap: this.tap });
      let last: unknown = results.at(-1);
      if (last && typeof (last as { then?: unknown }).then === "function") last = await last;
      return { result: lipsToJs(last, {}), trace: this.tap };
    } catch (e) {
      return { result: ["error", e instanceof Error ? e.message : String(e)], trace: this.tap };
    }
  }

  /** Tear down extension resources (progress servers, etc.) — LIFO via the assembled env's dispose,
   *  plus any runtime `(require/extension)`-applied packs' disposers. */
  async dispose(): Promise<void> {
    await this.assembledExts?.dispose();
    await this.extAssembler?.dispose();
  }
}

export const buildChainEnv = (config: ChainConfig): ChainEnvironment => new ChainEnvironment(config);
