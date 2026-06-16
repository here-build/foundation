// entity-middleware — the derive-entity / middleware ALGEBRA.
//
// Pure substrate: a connection-like value (`DerivableEntity`) of some KIND (mcp · llm ·
// sql · http) carrying a middleware chain, plus the runner that composes that chain
// around an honest call, plus the halt sentinel. KIND-AGNOSTIC and orchestration-free —
// it depends only DOWNWARD (this package's `LlmParams`, arrival-scheme's `schemeToJs`
// membrane), so the inference verbs (`@here.build/arrival-scheme-env-infer`) AND the MCP
// dispatch layer both build on it without either importing the other. (It lived in
// arrival-chain's `mcp-effects` under the monolith; that was a layer inversion — the
// substrate sat above the capabilities standing on it.)

import { schemeToJs } from "@here.build/arrival";

import type { LlmParams } from "./model.js";

/**
 * A middleware installed on a server for one method — a scheme λ `(req next progress) →
 * value | mcp/break`, arriving at JS as a callable function (the spike proved the
 * crossing). `next` re-enters the chain (eventually the honest, credentialed call); the
 * λ may pass through (`(next req)`), transform the request/reply, short-circuit with a
 * canned value, or return `mcp/break` to halt.
 */
export interface EntityMiddleware {
  /** The method this middleware intercepts. A `string` (not a closed protocol enum)
   *  because the method namespace is per-KIND: an mcp entity's `tools/call`, an llm entity's
   *  `infer`. The chain runner filters by `===`, so any kind's method name works uniformly. */
  method: string;
  handler: (req: unknown, next: (req: unknown) => Promise<unknown>, progress: unknown) => unknown;
}

/** A method's total implementation for a FABRICATED server (`mcp/define`) — the bottom of
 *  the chain, no `next`. A scheme λ `(req) → reply`, run instead of the credentialed call. */
export type McpDefinedMethod = (req: unknown) => unknown;

/**
 * An opaque DERIVABLE ENTITY — what `(mcp :name)` / `(llm :name)` / `derive` / `mcp/define`
 * return. The kind-agnostic unit the `derive` algebra operates on: a connection-like value
 * of some KIND (mcp · llm · sql · http) that carries an intent NAME, a middleware chain
 * (empty on the honest path; `derive` appends), and optionally fabricated method impls
 * (`mcp/define` — used as `honest` INSTEAD of the credentialed call, so a defined entity
 * needs no backend).
 *
 * `kind` is the discriminant: the GETTER `(mcp …)` / `(llm …)` binds it (it picks the
 * honest bottom at dispatch — mcp's credentialed transport vs llm's model call), while
 * `derive` is kind-AGNOSTIC (it just appends a middleware; the kind rides the value). That
 * split is the whole point: one `derive` verb, N kinds — because the honest is needed only
 * at dispatch, never at derive time (which is why {@link runMiddlewareChain} takes `honest`
 * as a parameter rather than baking it in).
 *
 * A class instance, so it round-trips through scheme untouched — jsToScheme/schemeToJs pass
 * exotic objects through as-is (rosetta.ts:281 / :198) — opaque to the program.
 */
export class DerivableEntity {
  constructor(
    /** The entity kind — the dispatch discriminant (`"mcp"` | `"llm"` | …). Set by the
     *  getter, carried by the value, read at dispatch to pick the honest bottom. */
    readonly kind: string,
    readonly name: string,
    readonly middleware: readonly EntityMiddleware[] = [],
    /** Fabricated method impls (`mcp/define`) — when a method is here, it is the chain's
     *  `honest` bottom (no resolver crossing). Absent ⇒ honest is the credentialed call.
     *  Keyed by method string (the MCP layer narrows to its protocol methods). */
    readonly defined?: Partial<Record<string, McpDefinedMethod>>,
    /** Content-affecting model params bound to an `(llm …)` entity (`llm/with`). Distinct
     *  from `middleware` (observe-only, cache-NEUTRAL): params are IDENTITY — they change
     *  the completion, so the infer path folds them into the cache key + sends them to the
     *  backend. Carried generically (only the llm kind interprets them today). */
    readonly params?: LlmParams,
  ) {}

  /** Return a NEW entity with `mw` appended (immutable derive — the base is shared, never
   *  mutated, so two derivations of one base stay independent). Preserves kind/defined/params. */
  withMiddleware(mw: EntityMiddleware): DerivableEntity {
    return new DerivableEntity(this.kind, this.name, [...this.middleware, mw], this.defined, this.params);
  }

  /** Return a NEW entity with `patch` shallow-merged over the existing params (immutable;
   *  later keys win). Mirror of {@link withMiddleware} — preserves kind/name/middleware/defined,
   *  so params and middleware compose order-independently on one entity. */
  withParams(patch: Partial<LlmParams>): DerivableEntity {
    return new DerivableEntity(this.kind, this.name, this.middleware, this.defined, { ...this.params, ...patch });
  }
}

/** Narrow an unknown scheme value to a {@link DerivableEntity} — what `derive`'s base and a
 *  `:tools` entry must be (a handle from `(mcp …)` / `(llm …)` / derive / define). */
export function isDerivableEntity(v: unknown): v is DerivableEntity {
  return v instanceof DerivableEntity;
}

// ── the middleware chain: derive's interception primitive ─────────────────────

/**
 * The halt sentinel a middleware returns (bare `mcp/break` in scheme) to stop the loop
 * WITHOUT calling next — the call is suppressed (flow 4's force-halt; "the call is already
 * on the tape, break only stops the loop"). A GLOBAL registered symbol so scheme's bound
 * `mcp/break` and the JS chain runner compare `===` across the membrane (spike-verified).
 *
 * NOTE: the registered key string is preserved verbatim from its original home in
 * arrival-chain — it is the cross-membrane identity, so it must NOT change with the move.
 */
export const MCP_BREAK: unique symbol = Symbol.for("@here.build/arrival-chain/mcp-break");

/** Is a value the {@link MCP_BREAK} sentinel? (The agentic loop's halt signal from dispatch.) */
export function isMcpBreak(v: unknown): boolean {
  return v === MCP_BREAK;
}

/**
 * Run the middleware chain for `method` over `honest` (the credentialed resolver call):
 * composes `mw1(req, r⇒mw2(r, …honest), progress)` — outermost-first. Only middlewares
 * matching `method` participate. Returns the (possibly transformed) reply, or
 * {@link MCP_BREAK} if a middleware returned the sentinel without calling next.
 *
 * Membrane: `honest`/`next` return a JS reply that auto-wraps for the scheme λ; the λ's
 * return crosses back, so each stage `schemeToJs`-es it (MCP_BREAK passes through untouched).
 */
export async function runMiddlewareChain(
  middleware: readonly EntityMiddleware[],
  method: string,
  honest: (req: unknown) => Promise<unknown>,
  req: unknown,
  progress: unknown,
): Promise<unknown> {
  const chain = middleware.filter((m) => m.method === method);
  if (chain.length === 0) return honest(req);
  let next = honest;
  for (let i = chain.length - 1; i >= 0; i--) {
    const handler = chain[i]!.handler;
    const downstream = next;
    next = async (r: unknown) => {
      const out = await handler(r, downstream, progress);
      return out === MCP_BREAK ? MCP_BREAK : schemeToJs(out);
    };
  }
  return next(req);
}
