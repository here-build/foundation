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

import { Nil } from "@here.build/arrival-scheme";

import type { RosettaHost } from "./data-effects.js";
import { mcpEffectKey, stableJson } from "./effect-log.js";
import type { ToolDescriptor } from "./model.js";

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

/**
 * An opaque MCP server VALUE — what `(mcp :name)` returns. Carries only the exposed
 * roster NAME (intent); the credentialed transport stays host-side, reached through the
 * {@link McpEffectResolver} at dispatch. A class instance, so it round-trips through
 * scheme untouched — jsToLips/lipsToJs pass exotic objects through as-is (rosetta.ts:281
 * / :198) — and stays opaque to the program (no `@`-readable structure beyond the name).
 * The `mcp/derive` / `mcp/define` forms (C3) extend this with a middleware chain; on the
 * honest path it is just the name.
 */
export class McpServerValue {
  constructor(readonly name: string) {}
}

/** Narrow an unknown scheme value to an {@link McpServerValue} — what a `:tools` entry
 *  must be (a server handle from `(mcp …)` / derive / define). */
export function isMcpServerValue(v: unknown): v is McpServerValue {
  return v instanceof McpServerValue;
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
  // (mcp :name) / (mcp "name") — the opaque server getter (server-as-value). A PURE
  // name→handle constructor: no resolver crossing, no roster validation (the handle is
  // lazy; a bad name surfaces at dispatch). Keyword or string name. The handle is what
  // `:tools` and (later) `mcp/derive` consume.
  env.defineRosetta("mcp", {
    fn: (name: unknown) => new McpServerValue(serverNameOf(name)),
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
 *  the toolName→serverName routing the loop's dispatch uses to send a call back to the
 *  server that owns it. */
export interface ResolvedTools {
  tools: ToolDescriptor[];
  serverOf: Map<string, string>;
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
 * For each server, `tools/list` through the resolver, map each MCP descriptor to the
 * neutral {@link ToolDescriptor} (dropping MCP-only annotations, which feed the lint, not
 * the model), and record toolName→serverName so the loop's dispatch routes a call to the
 * server that owns it.
 *
 * FIRST-server-wins on a name collision (deterministic — the model sees ONE tool of that
 * name, routed to the first server). Cross-server name namespacing is a future refinement.
 * The `tools/list` calls cross the same resolver (and server tape) as a dispatch, so an
 * agentic run's tool discovery is recorded + replayed like any other MCP effect.
 */
export async function resolveTools(
  servers: readonly McpServerValue[],
  resolve: McpEffectResolver,
  ctx: McpEffectContext,
): Promise<ResolvedTools> {
  const tools: ToolDescriptor[] = [];
  const serverOf = new Map<string, string>();
  for (const server of servers) {
    const reply = await resolve(ctx, { kind: "mcp", server: server.name, method: "tools/list", request: {} });
    for (const t of toolListOf(reply)) {
      if (serverOf.has(t.name)) continue; // first server wins on a name collision (deterministic)
      tools.push({
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        ...(t.inputSchema === undefined ? {} : { inputSchema: t.inputSchema }),
      });
      serverOf.set(t.name, server.name);
    }
  }
  return { tools, serverOf };
}
