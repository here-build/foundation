/**
 * Host capability interface for MCP — the membrane through which a run's MCP tool
 * calls reach the outside world. The CLIENT-side twin of {@link ./data-effects}: the
 * OSS engine knows the VERBS, never the CREDENTIALS.
 *
 * A program/agent names a server by LABEL (intent); the resolver maps that label to a
 * decrypted, credentialed MCP client transport HOST-SIDE — the same membrane the LLM
 * keys cross (the interface vends BEHAVIOUR, not the secret). Scheme holds only the
 * server NAME and override λs; the only path to the real server is `next`, which runs
 * host-side, so credentials can never materialise in the sandbox.
 *
 * INERT BY DEFAULT. Like infer/data, the MCP capability REJECTS at call time until a
 * {@link McpEffectResolver} is injected via `buildArrivalEnv({ mcp })`. The OSS engine
 * ships MCP disarmed: a program that mentions an MCP server analyses fine, but invoking
 * one throws a teaching error ({@link inertMcpResolver}) — never a silent no-op, never a
 * network call. The credentialed resolver (roster lookup, envelope-decrypt, SDK `Client`
 * transport) is host-private, NOT part of this package.
 *
 * SERVER-TAPE replay. MCP calls are recorded POSITIONALLY per (inference, server) — not
 * by content like infer/http/sql — because an MCP call's result depends on the server's
 * hidden mutable state (read-after-write). {@link wrapMcpResolver} implements record/replay
 * over that tape: replay is HERMETIC (returns the recorded reply, NEVER re-fires — so a
 * what-if cannot trigger a second destructive action) and VERIFIES the recorded
 * `{server,method,request}` against the live call, stopping on divergence rather than
 * silently serving a stale value.
 */

import invariant from "tiny-invariant";

import { lipsToJs, Nil } from "@here.build/arrival-scheme";

import type { RosettaHost } from "./data-effects.js";
import { mcpEffectKey, stableJson } from "./effect-log.js";
import { LLM_PARAM_TYPES, type LlmParams, type ToolDescriptor } from "./model.js";

/** The MCP protocol methods the runner invokes. `tools/list` + `tools/call` are the v1
 *  surface; the rest are reserved so the membrane's method namespace is complete and
 *  every method is uniformly overridable (the `derive` interception surface). */
export type McpMethod =
  | "initialize"
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/read"
  | "prompts/list"
  | "prompts/get";

/** Behavioural hints driving cache/lint policy: read-only/idempotent ⇒ replay-safe to
 *  share; destructive/non-idempotent ⇒ each call is distinct and feeds the parallel-arm
 *  non-idempotent lint. Trusted as given — a mis-annotating server is the user's risk. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}

/** A probe-verified MCP tool descriptor (one entry of a `tools/list` result). */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (lowered via the same `tagToJsonSchema` path
   *  the output-schema validator uses, so a tool schema can't drift from the wire). */
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

/** The probe result for an MCP connection — verified facts, never user-typed. */
export interface McpCapabilities {
  serverInfo?: { name: string; version: string };
  tools?: McpToolDescriptor[];
  instructions?: string;
}

/**
 * One honest MCP server, built HOST-SIDE from a connection. Holds the credentialed
 * transport. `methods` are the `next` targets — the only path to the real server; the
 * sandbox never sees them, only the value-only {@link McpEffect} seam. Opaque to scheme.
 */
export interface McpServerSpec {
  capabilities?: McpCapabilities;
  /** The honest, credentialed protocol methods. Partial: a server need only implement
   *  what it supports (a tools-only server has no `resources/*`). */
  methods: Partial<Record<McpMethod, (request: unknown) => Promise<unknown>>>;
}

/** The honest roster — exposed name → server. Vended host-side into a run; HOLDS the
 *  credentials. Repeatable: two connections to the same server kind on different hosts
 *  (e.g. `mcp_cf_host` / `mcp_cf_herebuild`) are two distinct entries. */
export type McpRoster = Record<string, McpServerSpec>;

/**
 * A single MCP call crossing the membrane — the INTENT a tool dispatch carries. Plain-
 * serialisable so the server-tape can record/verify it without reaching into scheme
 * value types.
 */
export interface McpEffect {
  kind: "mcp";
  /** Exposed server name (the projection key the model sees). */
  server: string;
  /** The protocol method invoked. */
  method: McpMethod;
  /** Method params — for `tools/call`: `{ tool, args }`; for `tools/list`: usually empty. */
  request: unknown;
}

/** Minimal structural view of the `EvalContext` a resolver receives (mirrors
 *  `DataEffectContext`) — only the current invocation, for tracing/provenance. */
export interface McpEffectContext {
  currentInvocation?: unknown;
}

/**
 * THE SEAM. A host injects one of these to arm MCP; absent it, the capability is inert
 * ({@link inertMcpResolver}). Receives the eval context and the canonical {@link McpEffect},
 * performs the credentialed, transport-backed call host-side, and resolves to the raw
 * reply. Deliberately the SAME shape as `DataEffectResolver` / `InferFn` —
 * `(ctx, descriptor) → Promise<value>` — so a host routes MCP through the
 * structurally-identical resolver.
 */
export type McpEffectResolver = (ctx: McpEffectContext, effect: McpEffect) => Promise<unknown>;

/** Stable at-a-glance identity for inert/error messages and the effect node label.
 *  NOT the effect key (that is positional — {@link mcpEffectKey}). */
export function describeMcpEffect(effect: McpEffect): string {
  return `mcp ${effect.method} ${effect.server}`;
}

/**
 * The disarmed default. When `buildArrivalEnv` is called WITHOUT an `mcp` resolver, MCP
 * calls route here and throw a teaching error at call time — the MCP analogue of
 * `inertDataResolver` / the infer "no store bound" invariant. Errors-as-doors: names the
 * real condition (capability not wired) and points at the fix; never a silent no-op,
 * never a network call.
 */
export const inertMcpResolver: McpEffectResolver = (_ctx, effect) => {
  throw new Error(
    `${describeMcpEffect(effect)}: MCP is not enabled in this environment. ` +
      `The (mcp …) capability requires a host-injected McpEffectResolver — pass one via ` +
      `buildArrivalEnv({ mcp }). The OSS engine ships MCP disarmed; a credentialed resolver ` +
      `(roster lookup, envelope-decrypt, SDK client transport) is supplied by the host.`,
  );
};

// ── server-tape: positional record / hermetic replay / verification ──────────

/** The recorded tape entry: the reply, plus the `{server,method,request}` verification
 *  record so replay can confirm the nth call aligns with what was recorded. */
export interface McpTapeRecord {
  server: string;
  method: McpMethod;
  request: unknown;
  reply: unknown;
}

/** A replay divergence — the nth call to a server does not match the recorded tape (a
 *  what-if changed the trajectory). Hermetic replay cannot re-fire, so this is a
 *  legitimate STOP: by default throw; a host may instead supply the answer (ask the user
 *  / LLM-simulate) via {@link McpTapeSeam.onDivergence}. */
export interface McpDivergence {
  key: string;
  reason: "mismatch";
  got: McpEffect;
  expected: McpTapeRecord;
}

/** Wiring a server-tape needs: the inference identity it is anchored to, the replay
 *  source (recorded log), the record sink (this run's collector), and a divergence
 *  policy. Mirrors the `{ effectLog, onEffectResult }` seam `Project` threads to data
 *  effects (`#wrapDataResolver`). */
export interface McpTapeSeam {
  /** The inference this tape is anchored to (its cache identity) — the first key element. */
  inferenceId: string;
  /** Replay source: recorded mcp entries (full → hermetic; absent → all live). */
  effectLog?: Map<string, string>;
  /** Called with the positional key for every mcp call as it fires, in order (→
   *  `Run.effects`, the causal key sequence), for fresh AND replayed calls. */
  onEffect?: (effectKey: string) => void;
  /** Record sink for THIS run (→ the effect-log collector). */
  onEffectResult?: (effectKey: string, valueJson: string) => void;
  /** Divergence policy on a verification mismatch. Default: throw a teaching error. A
   *  host may return a substitute reply (ask-user / LLM-simulate) instead. */
  onDivergence?: (divergence: McpDivergence) => Promise<unknown> | unknown;
}

/**
 * Wrap an {@link McpEffectResolver} with positional server-tape record/replay +
 * verification — the MCP twin of `Project.#wrapDataResolver`, but keyed POSITIONALLY
 * (per inference, per server) rather than by content, because MCP calls are stateful.
 *
 *   - LIVE (no recorded entry): call `inner`, record `{server,method,request,reply}`
 *     under the positional key. Order is the run's natural call order — deterministic in
 *     sequential code; a parallel arm is the lint case (racy index reconstruction).
 *   - REPLAY (entry present): VERIFY the recorded `{server,method,request}` matches this
 *     call; on match return the recorded reply WITHOUT calling `inner` (HERMETIC — never
 *     re-fires, so a destructive call cannot run twice); on mismatch raise a divergence.
 *
 * Returns a resolver closure carrying the per-server counter (one tape per server within
 * the inference). One wrap per inference.
 */
export function wrapMcpResolver(inner: McpEffectResolver, seam: McpTapeSeam): McpEffectResolver {
  const nextIndex = new Map<string, number>(); // server → next positional index in this inference
  return async (ctx, effect) => {
    const n = nextIndex.get(effect.server) ?? 0;
    nextIndex.set(effect.server, n + 1);
    const key = mcpEffectKey(seam.inferenceId, effect.server, n);

    const replayed = seam.effectLog?.get(key);
    if (replayed !== undefined) {
      const record = JSON.parse(replayed) as McpTapeRecord;
      if (
        record.server !== effect.server ||
        record.method !== effect.method ||
        stableJson(record.request) !== stableJson(effect.request)
      ) {
        const divergence: McpDivergence = { key, reason: "mismatch", got: effect, expected: record };
        if (seam.onDivergence) return await seam.onDivergence(divergence);
        throw new Error(
          `${describeMcpEffect(effect)}: replay divergence at ${key} — recorded ` +
            `${record.method} on "${record.server}", got ${effect.method} on "${effect.server}". ` +
            `Hermetic replay cannot re-fire an MCP call; re-record this run or supply the ` +
            `expected answer (onDivergence).`,
        );
      }
      // fired for replayed calls too — the key sequence is part of the run's identity.
      seam.onEffect?.(key);
      seam.onEffectResult?.(key, replayed);
      return record.reply;
    }

    // live — call the honest resolver, then record the tape entry.
    seam.onEffect?.(key);
    const reply = await inner(ctx, effect);
    const record: McpTapeRecord = {
      server: effect.server,
      method: effect.method,
      request: effect.request,
      reply: reply ?? null,
    };
    seam.onEffectResult?.(key, JSON.stringify(record));
    return reply;
  };
}

// ── server-as-value: the (mcp :name) getter handle ───────────────────────────

/** The brand arrival-scheme stamps on a keyword's accessor function (Environment.ts:40).
 *  A global registered symbol, so it's reconstructable without importing it. */
const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

/** Coerce a server-name argument to its string name. A keyword (`:linear`) evaluates to a
 *  branded accessor function carrying its field; a string/symbol stringifies directly.
 *  Mirrors project.ts `dictKey` (the same keyword-accessor decode). */
function serverNameOf(raw: unknown): string {
  if (typeof raw === "function") {
    const field = (raw as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(raw);
}

/** Validate + coerce one `(llm/with …)` value to its declared param type. A `number` param
 *  rejects a non-number; a `string` param rejects the clearly-non-string scheme values
 *  (number / boolean / λ / nil) and coerces the rest (a scheme string may cross as a
 *  SchemeString wrapper, so `String(…)` it). A wrong type is a legible throw — never a silent
 *  coerce of `:temperature "hot"`, never storing `:system #f`. */
function coerceLlmParam(key: string, value: unknown, expected: "number" | "string"): unknown {
  if (expected === "number") {
    invariant(typeof value === "number" && Number.isFinite(value), `llm/with: :${key} must be a number`);
    return value;
  }
  invariant(
    value != null && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "function",
    `llm/with: :${key} must be a string`,
  );
  return String(value);
}

/**
 * A middleware installed on a server for one method — a scheme λ `(req next progress) →
 * value | mcp/break`, arriving at JS as a callable function (the spike proved the
 * crossing). `next` re-enters the chain (eventually the honest, credentialed call); the
 * λ may pass through (`(next req)`), transform the request/reply, short-circuit with a
 * canned value, or return `mcp/break` to halt.
 */
export interface EntityMiddleware {
  /** The method this middleware intercepts. A `string` (not the closed {@link McpMethod})
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
 * A class instance, so it round-trips through scheme untouched — jsToLips/lipsToJs pass
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
     *  `honest` bottom (no resolver crossing). Absent ⇒ honest is the credentialed call. */
    readonly defined?: Partial<Record<McpMethod, McpDefinedMethod>>,
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
 * return crosses back, so each stage `lipsToJs`-es it (MCP_BREAK passes through untouched).
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
      return out === MCP_BREAK ? MCP_BREAK : lipsToJs(out);
    };
  }
  return next(req);
}

/**
 * Dispatch one MCP `method` to a server VALUE through its middleware chain — `honest` is
 * the credentialed {@link McpEffectResolver} call (which also records the server tape). The
 * agentic loop calls this for `tools/call`, and {@link resolveTools} for `tools/list`, so
 * derive's interceptions apply uniformly. A {@link MCP_BREAK} return signals "halt".
 */
export function dispatchThroughChain(
  server: DerivableEntity,
  method: McpMethod,
  request: unknown,
  resolve: McpEffectResolver,
  ctx: McpEffectContext,
  progress: unknown = {},
): Promise<unknown> {
  // The chain's bottom: a FABRICATED impl (mcp/define) when this method has one — run it,
  // no credentialed call — else the resolver. `lipsToJs(req)` so a defined λ's reply and
  // the resolver's request are both plain JS (a middleware may have rewrapped `req`).
  const honest = async (req: unknown): Promise<unknown> => {
    const fabricated = server.defined?.[method];
    if (fabricated) return lipsToJs(await fabricated(req));
    return resolve(ctx, { kind: "mcp", server: server.name, method, request: lipsToJs(req) });
  };
  return runMiddlewareChain(server.middleware, method, honest, request, progress);
}

// ── scheme-facing dispatch verbs ─────────────────────────────────────────────

/** Coerce a tool-args value crossing the rosetta membrane into the request shape.
 *  Absent / the empty scheme list (`Nil`) ⇒ `{}` (no arguments); a real dict arrives
 *  already `lipsToJs`'d to a plain object. Mirrors the `Nil` discipline `data-effects`
 *  uses for its option dicts. */
function mcpArgs(raw: unknown): unknown {
  return raw === undefined || raw === null || raw instanceof Nil ? {} : raw;
}

/**
 * Register the low-level MCP dispatch verbs on `env`, routing each through the single
 * resolved `resolve` seam — the program-initiated membrane crossing (and the primitive
 * the step-3 trio / model-driven loop dispatch through):
 *
 *   (mcp/call "server" "tool" args)   → tools/call  with request `{ tool, args }`
 *   (mcp/list "server")               → tools/list
 *
 * `withContext: true` threads the eval context (for provenance/tracing), mirroring the
 * `infer`/data verbs. The result is returned RAW; the rosetta membrane wraps it into
 * scheme on the way out. Disarmed default: with {@link inertMcpResolver} these throw the
 * teaching error rather than reach a server (present-but-inert, never an unbound symbol).
 */
export function defineMcpRosettas(env: RosettaHost, resolve: McpEffectResolver): void {
  // (mcp :name) / (mcp "name") — the opaque mcp-entity getter (connection-as-value). A PURE
  // name→handle constructor: no resolver crossing, no roster validation (the handle is
  // lazy; a bad name surfaces at dispatch). Keyword or string name. The handle is what
  // `:tools` and `derive` consume. The getter is the ONLY kind-specific verb — it binds
  // `kind`, which picks the honest bottom at dispatch (here: the credentialed mcp resolver).
  env.defineRosetta("mcp", {
    fn: (name: unknown) => new DerivableEntity("mcp", serverNameOf(name)),
  });
  // (llm :name) / (llm "name") — the opaque llm-entity getter, the SECOND kind. Same shape
  // as `mcp`: a pure name→handle constructor, `kind` = "llm" so dispatch picks the model
  // call as the honest bottom (wired in the infer path). Proves the getter is the only
  // kind-aware verb; everything downstream (`derive`, the chain) is kind-agnostic.
  env.defineRosetta("llm", {
    fn: (name: unknown) => new DerivableEntity("llm", serverNameOf(name)),
  });
  // (llm/with base :temperature 0.7 :system "…") — bind CONTENT params to an (llm …) entity
  // (the tweaks op). Kind-prefixed (like mcp/define): params are llm-specific, and unlike
  // `derive`'s observe-only middleware they are IDENTITY (cache-affecting — the infer path
  // folds them into the key + sends them to the backend). Typed-not-bag: an unknown :keyword
  // or a wrong-typed value is a legible error (validated against LLM_PARAM_TYPES), never a
  // silent no-op. Returns a NEW entity (immutable, via withParams; params shallow-merge).
  env.defineRosetta("llm/with", {
    fn: (base: unknown, ...pairs: unknown[]) => {
      invariant(base instanceof DerivableEntity, "llm/with: first arg must be an (llm …) entity");
      invariant(base.kind === "llm", `llm/with: base must be an (llm …), got kind "${base.kind}"`);
      invariant(pairs.length % 2 === 0, "llm/with: expects an (llm …) then :key value pairs");
      const patch: Record<string, unknown> = {};
      for (let i = 0; i < pairs.length; i += 2) {
        const key = serverNameOf(pairs[i]);
        const expected = (LLM_PARAM_TYPES as Record<string, "number" | "string" | undefined>)[key];
        invariant(
          expected !== undefined,
          `llm/with: unknown param ":${key}" — allowed: ${Object.keys(LLM_PARAM_TYPES).join(", ")}`,
        );
        patch[key] = coerceLlmParam(key, pairs[i + 1], expected);
      }
      return base.withParams(patch as Partial<LlmParams>);
    },
  });
  // (derive base :method handler) — the KIND-AGNOSTIC derive verb. Install a middleware on
  // `base` (ANY derivable entity — mcp, llm, …) for `:method`, returning a NEW entity
  // (immutable derive). The handler is a scheme λ `(req next progress) → value | mcp/break`
  // run in the chain at dispatch. THIS is the MITM / budget / mock / break / tweak primitive;
  // `next` is the honest membrane. Generic because the honest bottom is supplied at dispatch
  // by the entity's kind — `derive` never needs it, it only appends.
  env.defineRosetta("derive", {
    fn: (base: unknown, method: unknown, handler: unknown) => {
      invariant(
        base instanceof DerivableEntity,
        "derive: first arg must be a derivable entity (from (mcp …) / (llm …))",
      );
      invariant(typeof handler === "function", "derive: handler must be a (req next progress) lambda");
      return base.withMiddleware({
        method: serverNameOf(method),
        handler: handler as EntityMiddleware["handler"],
      });
    },
  });
  // (mcp/define name :method handler :method2 handler2 …) — fabricate an mcp entity whose
  // methods ARE the handlers (a `(req) → reply` λ each; no credentialed backend). TOTAL:
  // every method you dispatch must be defined. `derive` can still layer middleware on top
  // (the defined impl is the chain's honest bottom). The mock/what-if-a-server primitive.
  // STAYS kind-prefixed (unlike `derive`): fabrication makes an entity from nothing, so it
  // must DECLARE its kind — there's no base value to carry it.
  env.defineRosetta("mcp/define", {
    fn: (name: unknown, ...pairs: unknown[]) => {
      invariant(pairs.length % 2 === 0, "mcp/define: expects a name then :method handler pairs");
      const defined: Partial<Record<McpMethod, McpDefinedMethod>> = {};
      for (let i = 0; i < pairs.length; i += 2) {
        const method = serverNameOf(pairs[i]) as McpMethod;
        invariant(typeof pairs[i + 1] === "function", `mcp/define: handler for ${method} must be a (req) lambda`);
        defined[method] = pairs[i + 1] as McpDefinedMethod;
      }
      return new DerivableEntity("mcp", serverNameOf(name), [], defined);
    },
  });
  env.defineRosetta("mcp/call", {
    withContext: true,
    fn: (ctx: McpEffectContext, server: unknown, tool: unknown, args?: unknown): Promise<unknown> =>
      resolve(ctx, {
        kind: "mcp",
        server: String(server),
        method: "tools/call",
        request: { tool: String(tool), args: mcpArgs(args) },
      }),
  });
  env.defineRosetta("mcp/list", {
    withContext: true,
    fn: (ctx: McpEffectContext, server: unknown): Promise<unknown> =>
      resolve(ctx, { kind: "mcp", server: String(server), method: "tools/list", request: {} }),
  });
}

// ── :tools desugar — server values → the model's tool set + dispatch routing ──

/** The resolved tool set for an agentic run: the neutral descriptors the model sees, plus
 *  the toolName→server-VALUE routing the loop's dispatch uses to send a call back to the
 *  server that owns it (the VALUE, not just the name, so dispatch runs that server's
 *  middleware chain). */
export interface ResolvedTools {
  tools: ToolDescriptor[];
  serverOf: Map<string, DerivableEntity>;
}

/** Pull the tool array out of a `tools/list` reply — tolerant of the MCP spec's
 *  `{ tools: [...] }` envelope or a bare array (a `derive`d/`define`d server may return
 *  either). Non-array / absent ⇒ no tools. */
function toolListOf(reply: unknown): McpToolDescriptor[] {
  if (Array.isArray(reply)) return reply as McpToolDescriptor[];
  const tools = (reply as { tools?: unknown } | null | undefined)?.tools;
  return Array.isArray(tools) ? (tools as McpToolDescriptor[]) : [];
}

/**
 * Resolve `:tools` server values into the model's neutral tool set + the dispatch routing.
 * For each server, `tools/list` THROUGH ITS MIDDLEWARE CHAIN (so a derived `tools/list`
 * middleware — flow 2's description rewrite — applies), map each MCP descriptor to the
 * neutral {@link ToolDescriptor} (dropping MCP-only annotations, which feed the lint, not
 * the model), and record toolName→server-value so the loop's dispatch routes a call back
 * through the right server's chain.
 *
 * FIRST-server-wins on a name collision (deterministic — the model sees ONE tool of that
 * name, routed to the first server). Cross-server name namespacing is a future refinement.
 * The `tools/list` calls cross the same resolver (and server tape) as a dispatch, so an
 * agentic run's tool discovery is recorded + replayed like any other MCP effect. A server
 * whose `tools/list` middleware returns `mcp/break` contributes no tools (skipped).
 */
export async function resolveTools(
  servers: readonly DerivableEntity[],
  resolve: McpEffectResolver,
  ctx: McpEffectContext,
  progress: unknown = {},
): Promise<ResolvedTools> {
  const tools: ToolDescriptor[] = [];
  const serverOf = new Map<string, DerivableEntity>();
  for (const server of servers) {
    const reply = await dispatchThroughChain(server, "tools/list", {}, resolve, ctx, progress);
    if (reply === MCP_BREAK) continue; // a tools/list break → this server exposes no tools
    for (const t of toolListOf(reply)) {
      if (serverOf.has(t.name)) continue; // first server wins on a name collision (deterministic)
      tools.push({
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        ...(t.inputSchema === undefined ? {} : { inputSchema: t.inputSchema }),
      });
      serverOf.set(t.name, server);
    }
  }
  return { tools, serverOf };
}
