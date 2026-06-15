// @here.build/arrival-scheme-env-infer — the inference verbs (`infer`, `infer/chat`) as a
// real EnvCapability, built FOR REAL on the engine layer (not re-exported from chain).
//
// The capability stands on `@here.build/arrival-inference` alone: the derive-entity /
// middleware algebra (DerivableEntity, runMiddlewareChain, the break sentinel) + the model
// types. The host arms it via `configuration.infer` — the inference SEAM (an InferFn the
// host wraps around its cache-backed engine). The verbs read `this.configuration.infer`.
//
// No arrival-chain dependency — the package depends only DOWN. The verb-helper toolkit
// (asLlmModel / inferThroughChain / coercions) is co-located here; the dependent mcp pack
// (./mcp) and arrival-chain reuse it from this package.

import { type Activation, EnvCapability } from "@here.build/arrival-scheme/capability";
import {
  DerivableEntity,
  type EntityMiddleware,
  isMcpBreak,
  type LlmParams,
  runMiddlewareChain,
  type ToolDescriptor,
} from "@here.build/arrival-inference";
import invariant from "tiny-invariant";
import { z } from "zod";

import { arrivalDeriveCapability } from "./derive.js";

// ── the inference seam (host config) ──────────────────────────────────────────

/**
 * The infer-resolution seam: resolve ONE `(infer …)` call site to its value. The host
 * decides where the task lives (a content-addressed cache, the host's per-File tasks) and
 * how it resolves; the capability only knows the SHAPE. Returns the RAW value; the verb
 * wraps it to a list for scheme. Args arrive already coerced (model/prompt stringified,
 * schema via {@link schemaSlot}, cacheKey via {@link nullable}).
 *
 * Defined natively here against the engine's `ToolDescriptor` / `LlmParams` — severed from
 * the old monolith `BuildArrivalEnvOpts["infer"]`, which is what tied the capability to the
 * "older system".
 */
export type InferFn = (
  ctx: { currentInvocation?: unknown } | undefined,
  model: string,
  prompt: string,
  schema: string | null,
  cacheKey: string | null,
  /** Tools the model may call THIS turn (agentic path); a plain `(infer …)` omits it. */
  tools?: ToolDescriptor[],
  /** Content-affecting model params from an `(llm/with …)` entity (temperature, system). */
  params?: LlmParams,
) => Promise<unknown>;

// ── verb-helper toolkit (pure, over the engine algebra) ───────────────────────

/** A single `(infer …)` has no loop to halt, so an `(llm …)` middleware returning
 *  `mcp/break` here is a category error (break belongs to the agentic loop). Named so the
 *  two single-shot infer verbs share one legible message. */
export const BREAK_ON_SINGLE_INFER =
  "infer: an (llm …) middleware returned mcp/break on a single (infer …) — break only halts an agentic run (infer/agentic/end-to-end …)";

/** A scheme `#f` crosses the membrane as JS `false`; treat it, `null`, and `undefined` uniformly as
 *  "absent" → null, so an omitted optional arg and an explicit `#f` both mean no cacheKey. */
export const nullable = (v: unknown): string | null => (v === undefined || v === false || v === null ? null : String(v));

/** Canonicalise a schema arg (string marker | tagged-list DSL | nothing) to the single
 *  string used as the schema slot of a task's content key. */
export const schemaSlot = (v: unknown): string | null => {
  if (v === undefined || v === false || v === null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
};

/** Wrap an infer result into the scheme list the verbs return. */
export const inferList = (v: unknown): unknown => (Array.isArray(v) ? v : [v]);

/** Canonicalise a scheme `(role content)` message list to the wire string an `infer/chat`
 *  call site uses as its prompt slot. */
export function canonicalizeMessages(messages: unknown): string {
  invariant(Array.isArray(messages), "infer/chat: messages must be a list");
  return JSON.stringify(
    messages.map((m) => {
      invariant(Array.isArray(m) && m.length === 2, "infer/chat: each message must be (role content)");
      return { role: String(m[0]), content: String(m[1]) };
    }),
  );
}

/** Coerce an infer `model` argument that may be a bare string OR an `(llm …)` entity. An
 *  llm entity contributes its NAME, its observe-only `middleware` chain, and its content
 *  `params` (`llm/with` tweaks). middleware is cache-NEUTRAL (observe-only); `params` ARE
 *  cache-affecting (folded into the key + sent to the backend). A non-llm entity (e.g. an
 *  `(mcp …)` server) in model position is a misuse → legible error. */
export function asLlmModel(model: unknown): {
  name: string;
  middleware: readonly EntityMiddleware[];
  params?: LlmParams;
} {
  if (model instanceof DerivableEntity) {
    invariant(
      model.kind === "llm",
      `infer: a derivable entity in model position must be an (llm …), got kind "${model.kind}"`,
    );
    return { name: model.name, middleware: model.middleware, params: model.params };
  }
  return { name: String(model), middleware: [] };
}

/** Run one inference through an `(llm …)` entity's OBSERVE-ONLY middleware chain (or
 *  directly when there is no middleware). `honest` is the cached infer call, closed over
 *  the ORIGINAL request — so whatever a middleware passes to `next`, the model is always
 *  called with the original request (the cache-neutral guarantee). Returns the infer
 *  result, or the break sentinel if a middleware halted without calling `next`. */
export function inferThroughChain(
  honest: () => Promise<unknown>,
  middleware: readonly EntityMiddleware[],
  reqView: unknown,
  progress: unknown,
): Promise<unknown> {
  if (middleware.length === 0) return honest();
  return runMiddlewareChain(middleware, "infer", () => honest(), reqView, progress);
}

// ── the capability ────────────────────────────────────────────────────────────

type InferActivation = Activation<{ infer: z.ZodType<InferFn> }, Record<string, never>>;

export const arrivalInferCapability = new EnvCapability("arrival/infer", {
  configuration: { infer: z.custom<InferFn>() },
  // `(infer (llm …) …)` needs the `llm` entity getter — the derive algebra's scheme surface.
  deps: [arrivalDeriveCapability],
  symbols: {
    infer: {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, prompt: SStr, schema?: unknown, cacheKey?: unknown): List<SStr>",
      async fn(this: InferActivation, ctx: unknown, model: unknown, prompt: unknown, schema: unknown, cacheKey: unknown) {
        const { name, middleware, params } = asLlmModel(model);
        const honest = () =>
          this.configuration.infer(ctx as Parameters<InferFn>[0], name, String(prompt), schemaSlot(schema), nullable(cacheKey), undefined, params);
        const out = await inferThroughChain(honest, middleware, String(prompt), {});
        if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
        return inferList(out);
      },
    },
    "infer/chat": {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, messages: unknown, schema?: unknown, cacheKey?: unknown): List<SStr>",
      async fn(this: InferActivation, ctx: unknown, model: unknown, messages: unknown, schema: unknown, cacheKey: unknown) {
        const { name, middleware, params } = asLlmModel(model);
        const prompt = canonicalizeMessages(messages);
        const honest = () =>
          this.configuration.infer(ctx as Parameters<InferFn>[0], name, prompt, schemaSlot(schema), nullable(cacheKey), undefined, params);
        const out = await inferThroughChain(honest, middleware, prompt, {});
        if (isMcpBreak(out)) throw new Error(BREAK_ON_SINGLE_INFER);
        return inferList(out);
      },
    },
  },
});
