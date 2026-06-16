// @here.build/arrival-scheme-env-infer/mcp — MCP as an EXTENDED capability over infer.
//
// MCP tool use IS inference with tools: the agentic verb loops infer↔dispatch, so this
// pack `deps: [arrivalInferCapability]` — it is the dependent half of the package. It owns
// the MCP client MEMBRANE (the value-only seam an agent's tool calls cross): the entity
// getters (`mcp`/`llm`/`derive`/…), the dispatch verbs (`mcp/call`/`mcp/list`), the
// resolver SEAM type + its inert default, and the tool-loop driver. The membrane builds on
// the derive-entity algebra (arrival-inference) and the infer toolkit (./infer) — no
// arrival-chain dependency.
//
// What STAYS in arrival-chain: the host-side server-tape (`wrapMcpResolver` — positional
// record/replay over the effect-log). That is run orchestration, not the capability; it
// imports the seam types from here, one-way.

import { type Activation, EnvCapability } from "@here.build/arrival/capability";
import {
  type ChatMessage,
  DerivableEntity,
  InferString,
  isDerivableEntity,
  isMcpBreak,
  MCP_BREAK,
  type McpDefinedMethod,
  runAgenticLoop,
  runMiddlewareChain,
  type ToolDescriptor,
} from "@here.build/arrival-inference";
import { schemeToJs, Nil } from "@here.build/arrival";
import invariant from "tiny-invariant";
import { z } from "zod";

import { arrivalDeriveCapability } from "./derive.js";
import { arrivalInferCapability, asLlmModel, type InferFn, inferList, inferThroughChain } from "./infer.js";

// ── MCP protocol surface ──────────────────────────────────────────────────────

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
  /** JSON Schema for the tool's arguments. */
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

/** Minimal structural view of the `EvalContext` a resolver receives — only the current
 *  invocation, for tracing/provenance. */
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
 *  NOT the effect key (that is positional — the host server-tape keys it). */
export function describeMcpEffect(effect: McpEffect): string {
  return `mcp ${effect.method} ${effect.server}`;
}

/**
 * The disarmed default. When MCP is not armed, calls route here and throw a teaching error
 * at call time — the MCP analogue of the infer "no store bound" invariant. Errors-as-doors:
 * names the real condition (capability not wired) and points at the fix; never a silent
 * no-op, never a network call.
 */
export const inertMcpResolver: McpEffectResolver = (_ctx, effect) => {
  throw new Error(
    `${describeMcpEffect(effect)}: MCP is not enabled in this environment. ` +
      `The (mcp …) capability requires a host-injected McpEffectResolver — arm it via the ` +
      `arrival/mcp capability's config. The OSS engine ships MCP disarmed; a credentialed ` +
      `resolver (roster lookup, envelope-decrypt, SDK client transport) is supplied by the host.`,
  );
};

// ── dispatch helpers ──────────────────────────────────────────────────────────
// The entity getters (`mcp`/`llm`/`derive`/`llm/with`/`mcp/define`) + `mcp/break` live in
// ./derive (the config-less `arrivalDeriveCapability`); this file keeps the resolver-bearing
// dispatch (`mcp/call`/`mcp/list`), the chain runner, and the agentic loop.

/** Coerce a tool-args value crossing the rosetta membrane into the request shape. Absent /
 *  the empty scheme list (`Nil`) ⇒ `{}` (no arguments); a real dict arrives already
 *  `schemeToJs`'d to a plain object. */
function mcpArgs(raw: unknown): unknown {
  return raw === undefined || raw === null || raw instanceof Nil ? {} : raw;
}

// ── dispatch through a server value's middleware chain ────────────────────────

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
  // no credentialed call — else the resolver. `schemeToJs(req)` so a defined λ's reply and
  // the resolver's request are both plain JS (a middleware may have rewrapped `req`).
  const honest = async (req: unknown): Promise<unknown> => {
    const fabricated = server.defined?.[method];
    if (fabricated) return schemeToJs(await (fabricated as McpDefinedMethod)(req));
    return resolve(ctx, { kind: "mcp", server: server.name, method, request: schemeToJs(req) });
  };
  return runMiddlewareChain(server.middleware, method, honest, request, progress);
}

// ── :tools desugar — server values → the model's tool set + dispatch routing ──

/** The resolved tool set for an agentic run: the neutral descriptors the model sees, plus
 *  the toolName→server-VALUE routing the loop's dispatch uses (the VALUE, not just the
 *  name, so dispatch runs that server's middleware chain). */
export interface ResolvedTools {
  tools: ToolDescriptor[];
  serverOf: Map<string, DerivableEntity>;
}

/** Pull the tool array out of a `tools/list` reply — tolerant of the MCP spec's
 *  `{ tools: [...] }` envelope or a bare array. Non-array / absent ⇒ no tools. */
function toolListOf(reply: unknown): McpToolDescriptor[] {
  if (Array.isArray(reply)) return reply as McpToolDescriptor[];
  const tools = (reply as { tools?: unknown } | null | undefined)?.tools;
  return Array.isArray(tools) ? (tools as McpToolDescriptor[]) : [];
}

/**
 * Resolve `:tools` server values into the model's neutral tool set + the dispatch routing.
 * For each server, `tools/list` THROUGH ITS MIDDLEWARE CHAIN, map each MCP descriptor to
 * the neutral {@link ToolDescriptor}, and record toolName→server-value. FIRST-server-wins
 * on a name collision (deterministic). A server whose `tools/list` middleware returns
 * `mcp/break` contributes no tools (skipped).
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
      if (serverOf.has(t.name)) continue; // first server wins on a name collision
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

// ── agentic loop driver ───────────────────────────────────────────────────────

/** Parse a scheme `(role content)` message list into neutral {@link ChatMessage}s — the
 *  SEED for `infer/agentic/end-to-end`'s loop. */
export function parseSchemeChatMessages(messages: unknown): ChatMessage[] {
  invariant(Array.isArray(messages), "infer/agentic/end-to-end: messages must be a list");
  return messages.map((m) => {
    invariant(Array.isArray(m) && m.length === 2, "infer/agentic/end-to-end: each message must be (role content)");
    return { role: String(m[0]) as ChatMessage["role"], content: String(m[1]) };
  });
}

/**
 * Drive `infer/agentic/end-to-end`'s loop and return the final {@link InferString}: resolve
 * the servers' tools, then loop infer↔dispatch via {@link runAgenticLoop}:
 *   - each turn through the cached infer seam with `ctx=undefined`, so per-turn inferences
 *     record as effects WITHOUT re-binding the agentic node's trace (one provenance node);
 *   - each dispatch through the server's middleware chain, break-aware ({@link isMcpBreak}),
 *     with the loop's `{round,maxRounds}` handed in as `progress`.
 */
export async function runAgenticInfer(
  infer: InferFn,
  mcpResolve: McpEffectResolver,
  ctx: unknown,
  model: unknown,
  messages: ChatMessage[],
  servers: DerivableEntity[],
): Promise<InferString> {
  const mcpCtx = ctx as McpEffectContext;
  // The model may be a bare string or an (llm …) entity. Its observe-only middleware runs
  // around EACH turn's inference; the chain's return decides break-vs-proceed ONLY — the
  // loop is always driven by the RAW InferString (a scheme middleware's return round-trips
  // through schemeToJs, which would demote the InferString and drop its toolCalls).
  const { name, middleware, params } = asLlmModel(model);
  const { tools, serverOf } = await resolveTools(servers, mcpResolve, mcpCtx);
  const result = await runAgenticLoop(messages, {
    infer: async (msgs, progress) => {
      // Capture the RAW infer result in a box: a scheme middleware's return round-trips
      // through schemeToJs (demoting an InferString → bare string, dropping toolCalls), so
      // the chain return drives break-vs-proceed only — the loop runs on the captured raw value.
      const captured: unknown[] = [];
      const honest = async (): Promise<unknown> => {
        const v = await infer(undefined, name, JSON.stringify(msgs), null, null, tools, params);
        captured.push(v);
        return v;
      };
      const out = await inferThroughChain(honest, middleware, msgs, progress);
      if (isMcpBreak(out)) return { text: "", toolCalls: [], halt: true };
      // honest ran ⇒ use the raw InferString (toolCalls intact); a middleware that
      // short-circuited (never called next) ⇒ its value is a canned, text-only turn.
      const turn = captured.length > 0 ? captured[0] : out;
      return turn instanceof InferString
        ? { text: String(turn), toolCalls: [...turn.__toolCalls__], reasoning: turn.__reasoning__ || undefined }
        : { text: String(turn ?? ""), toolCalls: [] };
    },
    dispatch: async (call, progress) => {
      const server = serverOf.get(call.name);
      invariant(
        server !== undefined,
        () => `infer/agentic/end-to-end: model called unknown tool "${call.name}" — not in the :tools set`,
      );
      return dispatchThroughChain(
        server,
        "tools/call",
        { tool: call.name, args: call.arguments },
        mcpResolve,
        mcpCtx,
        progress,
      );
    },
    isHalt: isMcpBreak,
  });
  return new InferString(result.text, "", result.chunks);
}

// ── the capabilities ──────────────────────────────────────────────────────────

type McpActivation = Activation<{ mcp: z.ZodOptional<z.ZodType<McpEffectResolver>> }, Record<string, never>>;

/** The resolver-bearing MCP DISPATCH verbs (`mcp/call`, `mcp/list`) — the program-initiated
 *  membrane crossing. The resolver is CONFIG (optional — INERT until the host arms `mcp`).
 *  `deps: [derive]` brings the entity getters + `mcp/break` into the same scope. */
export const arrivalMcpCapability = new EnvCapability("arrival/mcp", {
  configuration: { mcp: z.custom<McpEffectResolver>().optional() },
  deps: [arrivalDeriveCapability],
  symbols: {
    "mcp/call": {
      withContext: true,
      type: "(server: unknown, tool: unknown, args?: unknown): unknown",
      fn(this: McpActivation, ctx: unknown, server: unknown, tool: unknown, args?: unknown): Promise<unknown> {
        return (this.configuration.mcp ?? inertMcpResolver)(ctx as McpEffectContext, {
          kind: "mcp",
          server: String(server),
          method: "tools/call",
          request: { tool: String(tool), args: mcpArgs(args) },
        });
      },
    },
    "mcp/list": {
      withContext: true,
      type: "(server: unknown): unknown",
      fn(this: McpActivation, ctx: unknown, server: unknown): Promise<unknown> {
        return (this.configuration.mcp ?? inertMcpResolver)(ctx as McpEffectContext, {
          kind: "mcp",
          server: String(server),
          method: "tools/list",
          request: {},
        });
      },
    },
  },
});

type AgenticActivation = Activation<
  {
    infer: z.ZodType<InferFn>;
    mcp: z.ZodOptional<z.ZodType<McpEffectResolver>>;
  },
  Record<string, never>
>;

/** Agentic inference (`infer/agentic/end-to-end`) — MCP-tool use over inference, the
 *  EXTENDED capability. `deps: [infer, mcp]`: it loops the infer verb against the mcp
 *  dispatch surface, so assemble linearizes both before it. `infer` is required config;
 *  `mcp` is optional (absent ⇒ the inert resolver's teaching error). */
export const arrivalAgenticCapability = new EnvCapability("arrival/infer-agentic", {
  configuration: {
    infer: z.custom<InferFn>(),
    mcp: z.custom<McpEffectResolver>().optional(),
  },
  deps: [arrivalInferCapability, arrivalMcpCapability],
  symbols: {
    "infer/agentic/end-to-end": {
      withContext: true,
      options: { provenancePoint: true },
      type: "(model: unknown, messages: unknown, servers: unknown): List<SStr>",
      async fn(this: AgenticActivation, ctx: unknown, model: unknown, messages: unknown, servers: unknown) {
        const mcpResolve = this.configuration.mcp ?? inertMcpResolver;
        const serverVals = (Array.isArray(servers) ? servers : [servers])
          .filter(isDerivableEntity)
          .filter((s) => s.kind === "mcp");
        return inferList(
          await runAgenticInfer(
            this.configuration.infer,
            mcpResolve,
            ctx,
            model,
            parseSchemeChatMessages(messages),
            serverVals,
          ),
        );
      },
    },
  },
});
