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

import { execGeneratorFromString, lipsToJs } from "@here.build/arrival-scheme";
import { buildArrivalEnv, BUILTIN_PREAMBLE, type InferFn } from "./project.js";
import { EvalTrace } from "./trace.js";
import { createInferStore } from "./infer-store.js";
import type { ModelRouter } from "./registry.js";
import type { ModelBackend } from "./model.js";
import type { Loader } from "./loader.js";
import type { McpEffectResolver } from "./mcp-effects.js";
import { vercelBackend } from "./backends/vercel.js";
import { ollamaBackend } from "./backends/ollama.js";

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
}

type ChainEnv = ReturnType<typeof buildArrivalEnv>;

/** Context handed to an extension's `init` — enough to build a same-router narrator, read the
 *  run id, and register late rosettas. */
export interface ChainInitContext {
  env: ChainEnv;
  router: ModelRouter;
  runId: string;
}

/** A composable env-extension: register rosettas synchronously, optionally materialize an
 *  imperative resource at `init` (a server, a connection — gated by the extension itself), and
 *  tear it down at `dispose`. This is the SAME shape `defineProgress` already uses. */
export interface ChainExtension {
  register(env: ChainEnv): void;
  init?(ctx: ChainInitContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ChainConfig {
  name: string;
  /** id → backend. The program names ids; this arms them. No remap. */
  models: Record<string, ChainModelSpec>;
  loader: Loader;
  tap?: EvalTrace;
  mcp?: McpEffectResolver;
  extensions?: ChainExtension[];
  /** A stable id for this run (the progress room, etc.). Defaults to the chain name. */
  runId?: string;
  /** Transient-failure retry budget per infer call. Default 3. */
  maxInferRetry?: number;
}

/** Construct the concrete backend for a configured model. The provider→backend map — the one
 *  place that knows vercel vs ollama — replacing every consumer's hand-rolled router switch. */
function makeBackend(spec: ChainModelSpec): ModelBackend {
  switch (spec.provider) {
    case "anthropic":
      return vercelBackend({ provider: "anthropic", ...(spec.apiKey ? { apiKey: spec.apiKey } : {}), ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}) });
    case "ollama":
      return ollamaBackend({ ...(spec.baseURL ? { baseURL: spec.baseURL } : {}), ...(spec.think !== undefined ? { think: spec.think } : {}), ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}) });
    case "openai-compatible":
    default:
      return vercelBackend({
        provider: "openai-compatible",
        ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
        ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      });
  }
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
 *  the config key, resolved directly to a backend by the router. */
function makeInfer(store: ReturnType<typeof createInferStore>, maxRetry: number, trace: boolean): InferFn {
  return (async (_ctx, modelIn, prompt, schema, cacheKey) => {
    const model = String(modelIn);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      const cell = store.get({ model, prompt: String(prompt), schema: (schema ?? null) as string | null }, (cacheKey ?? null) as string | null);
      cell.acquire();
      try {
        const value = (await cell.done).value;
        if (trace) {
          // eslint-disable-next-line no-console
          console.error(`\x1b[36m[infer ${String(cacheKey)}]\x1b[0m ${JSON.stringify(value).slice(0, 600)}`);
        }
        return value;
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
  private readonly exts: ChainExtension[];
  private readonly runId: string;
  private readonly tap: EvalTrace;
  private started = false;

  constructor(config: ChainConfig) {
    const models = config.models;
    const cache = new Map<string, ModelBackend>();
    this.router = {
      async backendFor(modelId: string): Promise<ModelBackend> {
        const spec = models[modelId];
        if (!spec) throw new Error(`chain: model "${modelId}" is not configured — declared models: ${Object.keys(models).join(", ") || "(none)"}`);
        let b = cache.get(modelId);
        if (!b) { b = makeBackend(spec); cache.set(modelId, b); }
        return b;
      },
    };
    this.runId = config.runId ?? config.name;
    this.tap = config.tap ?? new EvalTrace();
    const store = createInferStore(this.router);
    const infer = makeInfer(store, config.maxInferRetry ?? 3, Boolean(process.env.SIFT_TRACE));
    this.env = buildArrivalEnv({
      name: config.name,
      infer,
      loader: config.loader,
      tap: this.tap,
      ...(config.mcp ? { mcp: config.mcp } : {}),
    });
    this.exts = config.extensions ?? [];
    for (const e of this.exts) e.register(this.env);
  }

  /** Bridge boot + every extension's `init` (servers, connections — each gated by itself). */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.env.init();
    for (const e of this.exts) await e.init?.({ env: this.env, router: this.router, runId: this.runId });
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

  /** Tear down extension resources (progress servers, etc.). */
  async dispose(): Promise<void> {
    for (const e of this.exts) await e.dispose?.();
  }
}

export const buildChainEnv = (config: ChainConfig): ChainEnvironment => new ChainEnvironment(config);
