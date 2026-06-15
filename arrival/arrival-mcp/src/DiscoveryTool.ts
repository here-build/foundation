// DiscoveryTool — a discovery tool as a VALUE, not a subclass.
//
// `new DiscoveryTool(name, capability, { description })`. Everything the old
// `DiscoveryToolInteraction` subclass hand-declared now derives from the one
// aggregating `McpEnvCapability` (`env`):
//   • input schema = { expr, intent } ∪ the capability's `configuration` (the actor's typed args)
//   • catalog      = `capability.allAnnotations()` (verbs, descriptions, dynamicDescription, aliases)
//   • eval         = assembleEnv(base, [capability.lower({ config })]) then execSerialized
//
// The three host concerns enter at three membrane TIMES, never co-mingled:
//   • eval-time  → the capability's `resources` (provider reads the per-call config; verbs read
//                  `this.resources.x.live`). Authorization = a resource that won't spawn.
//   • dispatch-time → the `ToolCallCtx` (session, user, abort signal, record sink). It lives ABOVE
//                  the eval membrane — a run can't reach it, so session/other-call state stays out.
//   • describe-time → infra closed over when the host built the capability (the welcome).

import { type Environment, execSerialized, jsToScheme, sandboxedEnv, schemeToJs, tokenize } from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { format } from "date-fns";
import dedent from "dedent";
import * as z from "zod";

import type { McpAnnotation, McpCapabilitySpec, McpEnvCapability } from "./McpEnvCapability.js";

/** One positional zod arg rendered as a Scheme-doc type token for the catalog. */
function argTypeName(item: z.ZodType): string {
  const opt = (() => {
    try {
      return item.safeParse(undefined).success ? "?" : "";
    } catch {
      return "";
    }
  })();
  const desc = item.description ? ` (${item.description})` : "";
  if (item instanceof z.ZodString) return `string${opt}${desc}`;
  if (item instanceof z.ZodNumber) return `number${opt}${desc}`;
  if (item instanceof z.ZodBoolean) return `boolean${opt}${desc}`;
  if (item instanceof z.ZodArray) return `list${opt}${desc}`;
  if (item instanceof z.ZodEnum) return item.options.map((v) => `"${v}"`).join("|");
  return `value${opt}${desc}`;
}

// ── REPL replay: structural cache per top-level statement ──────────────────────────────────────
// A REPL session re-establishes its bindings each call (the env is per-call). Rather than re-running
// every prior statement (which would re-fire its membrane penetrations), each statement is cached by
// its canonical SOURCE: a `(define …)` whose value is wire-safe is RESTORED from cache (its statement
// is never re-run, so the penetration never re-fires); a closure/uncacheable define is re-run, which
// is penetration-free because defining a lambda doesn't evaluate its body. The wire-safe membrane is
// what makes this sound — every penetrating statement yields a cacheable value, every uncacheable one
// is a closure. No verb-wrap, no interpreter tap: the statement source IS the structural key.

const DEFINE_NAME = /^\(define\s+(?:\(\s*)?([^\s()]+)/;

/** The bound name of a `(define x …)` / `(define (f …) …)`, or undefined for a bare expression. */
function defineName(canonicalSrc: string): string | undefined {
  return DEFINE_NAME.exec(canonicalSrc.trim())?.[1];
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const QUOTE_PREFIX = new Set(["'", "`", ",", ",@"]);
const isSkippable = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

/** Split scheme source into top-level statements via the real lexer (so `#\(`, `#|…|#`, string
 *  literals, and quote prefixes are tokenized correctly — a hand-scanner would miscount `#\(`).
 *  Each statement's EXACT source is its structural cache key + the re-executable unit; we slice by
 *  token start-offsets, so a list stays `(a b)` (the value-printer would render it `(list a b)`). */
function splitTopLevel(source: string): string[] {
  const tokens = tokenize(source, true) as { token: string; offset: number }[];
  const starts: number[] = [];
  let depth = 0;
  let between = true; // not currently inside a statement
  for (const { token, offset } of tokens) {
    if (isSkippable(token)) continue;
    if (between) {
      starts.push(offset);
      between = false;
    }
    if (OPEN.has(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      if (depth === 0) between = true;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      between = true; // a depth-0 atom/string completes its statement; a quote prefix waits for the next form
    }
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length).trim()).filter(Boolean);
}

/** Can this JS value (already `schemeToJs`-peeled) round-trip through JSON faithfully? True for
 *  primitives, plain arrays/objects of the same; FALSE for functions/symbols/bigint and non-plain
 *  objects (bytevectors, class instances) — those statements re-run rather than restore. */
function jsonRoundTrippable(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null) return true;
  switch (typeof v) {
    case "number":
    case "string":
    case "boolean":
      return true;
    case "object": {
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) return v.every((x) => jsonRoundTrippable(x, seen));
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return false; // bytevector / class instance
      return Object.values(v as Record<string, unknown>).every((x) => jsonRoundTrippable(x, seen));
    }
    default:
      return false; // function / symbol / bigint / undefined
  }
}

/** The dispatch-time context the host threads per call — ABOVE the eval membrane, so a run can't
 *  reach session identity or another call's state (the invariant the run isolation rests on). */
export interface ToolCallCtx {
  /** The MCP session: its id + replay/state bag (`state.__repl__` is the honest-replay history). */
  session?: { id: string; state: Record<string, unknown> };
  /** The authenticated principal (verified claims, never the request body) — stamped on the record. */
  user?: { sub: string; teamIds?: readonly string[] };
  /** Caller cancellation, fanned into the eval (TICK-checked) + any host requests it spawns. */
  signal?: AbortSignal;
  /** Fire-and-forget interaction sink — never blocks the response. */
  record?: (interaction: InteractionLog) => void;
}

/** What a single tool call records (a structural subset of the store's InteractionRecord). */
export interface InteractionLog {
  sessionId: string;
  userSub?: string;
  tool: string;
  intent?: string;
  arguments: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

export interface DiscoveryToolOptions {
  /** The tool's stable identity prose (the MCP `description`). Per-session/personalized text is the
   *  verbs' `dynamicDescription` (it rides the catalog), so this is static. */
  description: string;
  /** Wall-clock eval budget (the interpreter TICK-checks it). Defaults to {@link DEFAULT_BUDGET_MS}. */
  budgetMs?: number;
}

type DiscoveryArgs = { expr: string; intent?: string } & Record<string, unknown>;

/** Default wall-clock eval budget — the interpreter TICK-checks it (the SDK gives the SERVER no
 *  handler timeout; this is the server-side bound). */
export const DEFAULT_BUDGET_MS = 5000;

/** A discovery tool bound to one aggregating capability. Construct once per CONNECTION (the host
 *  builds `capability` with its infra armed into the resources); `call` runs once per request. */
export class DiscoveryTool {
  constructor(
    readonly name: string,
    private readonly capability: McpEnvCapability,
    private readonly options: DiscoveryToolOptions,
  ) {}

  /** The MCP `Tool` definition — name, description, input schema. Read-only hint by construction. */
  async describe(clientInfo?: Record<string, unknown>): Promise<Tool> {
    return {
      name: this.name,
      description: this.options.description,
      inputSchema: await this.inputSchema(clientInfo),
      annotations: { readOnlyHint: true },
    };
  }

  /** Evaluate `args.expr` in the env assembled from the capability, under the dispatch-time ctx.
   *  Re-establishes the session's prior bindings (structural cache), runs the new input statement
   *  by statement — REPL-style, so earlier statements' values stand even if a later one crashes —
   *  and threads `ctx.signal` + a wall-clock budget into every eval. A cancellation propagates; a
   *  runtime crash is surfaced as an `(error …)` form and stops the rest of the input. */
  async call(args: DiscoveryArgs, ctx: ToolCallCtx = {}): Promise<string[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? DEFAULT_BUDGET_MS;
    const { signal } = ctx;
    const env = await this.environment(args);
    const state = ctx.session?.state ?? {};
    const history = (state.__repl__ as string[] | undefined) ?? [];
    const cache = (state.__cache__ as Record<string, string> | undefined) ?? {};

    // Re-establish prior bindings: restore a wire-safe define from the structural cache (NOT re-run →
    // its membrane penetration never re-fires); re-run a closure/uncacheable define (penetration-free,
    // since defining a lambda doesn't evaluate its body). A re-run that no longer reproduces is dropped
    // rather than allowed to poison the session. History holds only define statements.
    for (const src of history) {
      const name = defineName(src);
      if (cache[src] !== undefined && name) {
        env.set(name, jsToScheme(JSON.parse(cache[src])));
        continue;
      }
      try {
        await execSerialized(src, { env, budgetMs, signal });
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation, not a dead binding
      }
    }

    // Run the new input statement-by-statement; cache each wire-safe define's value by its source.
    const out: string[] = [];
    let crashed: string | undefined;
    for (const src of splitTopLevel(args.expr)) {
      try {
        out.push(...(await execSerialized(src, { env, budgetMs, signal })));
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation propagates — not a REPL crash
        crashed = error instanceof Error ? error.message : String(error);
        out.push(`(error ${JSON.stringify(crashed)})`); // REPL-style: earlier values stand; stop here
        break;
      }
      const name = defineName(src);
      if (!name) continue; // bare expression — output only, nothing to replay
      if (!history.includes(src)) history.push(src);
      const js = schemeToJs(env.get(name));
      if (jsonRoundTrippable(js)) cache[src] = JSON.stringify(js);
    }
    state.__repl__ = history;
    state.__cache__ = cache;

    this.log(ctx, args, startTime, crashed ? { success: false, errorMessage: crashed } : { success: true });
    return out;
  }

  // ── env assembly: config from the actor args, resources armed by the capability ──

  private environment(args: DiscoveryArgs): Promise<Environment> {
    // The base is the constant safe floor (SAFE_BUILTINS) — vocabulary is added ONLY by the
    // capability's deps (the audited grant), never by swapping the base out from under it.
    const base = sandboxedEnv.inherit(this.name, {});
    return assembleEnv(base, [
      this.capability.lower({
        config: this.config(args),
        evalScheme: (e, src) => execSerialized(src, { env: e }),
      }),
    ]).then(({ env }) => env as Environment);
  }

  /** The capability's `configuration` fields, picked out of the call args (validated by `lower`). */
  private config(args: DiscoveryArgs): Record<string, unknown> {
    const schema = (this.capability.spec as McpCapabilitySpec<never, never>).configuration ?? {};
    return Object.fromEntries(Object.keys(schema).map((k) => [k, args[k]]));
  }

  // ── catalog + input schema: both derived from the capability ──

  private async inputSchema(clientInfo?: Record<string, unknown>): Promise<Tool["inputSchema"]> {
    const verbs = await this.catalog();
    const dynamic = verbs.some((v) => v.dynamic);
    const aiName = clientInfo?.name === "claude-ai" ? "Claude" : "";

    // ONE zod object is the source — the capability's `configuration` (transforms and all) merged
    // with expr/intent. `toJSONSchema` derives the wire shape; nothing hand-assembled, and the
    // required config args land in `required` (the hand-built version wrongly required only `expr`).
    const configShape = (this.capability.spec as McpCapabilitySpec<never, never>).configuration ?? {};
    const input = z.object({
      intent: z
        .string()
        .describe("What you're exploring and why. Shown to collaborating users in the studio UI.")
        .optional(),
      expr: z.string().describe(this.exprDescription(verbs, dynamic, aiName)),
      ...(configShape as z.ZodRawShape),
    });
    const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(input);
    return jsonSchema as Tool["inputSchema"];
  }

  /** The `expr` field's prose — the logic-bearing description an actor reads to use the REPL: the
   *  sandbox's base-env vocabulary (chain-walked, so the docs stay FAITHFUL to the env we run), the
   *  batch-query contract, the domain verbs, and — when any verb is live — the personalized,
   *  timestamped welcome-screen note. Ported from the original DiscoveryToolInteraction.getToolSchema
   *  so the migration to the value shape preserves it exactly. */
  private exprDescription(verbs: { text: string }[], dynamic: boolean, aiName: string): string {
    const baseSymbols = this.baseEnvSymbols().join(", ");
    const base = `${dedent`
        Expr is an input for Scheme (Lisp dialect) REPL that will be executed in sandboxed environment.
        This sandbox is providing access to the actual system state snapshot at the moment of request.
        This snapshot is stored locally and can be traversed in full.
        You can do anything you want, do any data transformations, lenses, views of any complexity.
        Sandbox provides the following base-environment symbols (use freely):
        ${baseSymbols}

        This REPL supports batch queries. You can express your curiosity like this in single \`expr\` request (e.g.):
        \`\`\`
        (user)
        (all-projects)
        \`\`\`
        and this server will provide response in two messages per each top-level expression.
        You can use any lisp features to obtain data you need: filter, map

        Domain-specific functions available in sandbox:
      `}\n${verbs.map((v) => v.text).join("\n")}`;
    if (!dynamic) return base;
    return `${base}\n${dedent`
        NOTE${aiName ? ` FOR ${aiName.toUpperCase()}` : ""} ON LIVE DESCRIPTION:
        The data provided above IS NOT STATIC.
        It is dynamically generated at every MCP session start. <timestamp>${format(new Date(), "MMM do, HH:MM X")}</timestamp>

        Some descriptions have user- and session-personalized, actual state at session start directly in description.
        That data is generated dynamically${aiName ? ` (yes, ${aiName}, this tool description is not static and was generated personally for you right now)` : ""} on description fetch to provide instant basic awareness even before session starts.
        Consider it as a dashboard or welcome screen for this MCP application.
      `}`;
  }

  /** The base env's full symbol set (chain-walked, sorted) — advertised in the schema in place of a
   *  hardcoded builtin constant, so the docs are FAITHFUL to the real env `environment()` assembles. */
  private baseEnvSymbols(): string[] {
    const names = new Set<string>();
    for (let e: Environment | null = sandboxedEnv.inherit(this.name, {}); e; e = e.__parent__) {
      for (const k of e.list()) if (typeof k === "string") names.add(k);
    }
    return [...names].sort();
  }

  /** The verb catalog reflected off the capability's dep-closure annotations. A STATIC `inputSchema`
   *  renders a sig; a getter (resource-resolving) is NOT invoked here (no live activation). A
   *  `dynamicDescription` thunk resolves live (and flags the entry session-generated). */
  private async catalog(): Promise<{ text: string; dynamic: boolean }[]> {
    return Promise.all(
      Object.entries(this.capability.allAnnotations()).map(async ([name, a]: [string, McpAnnotation]) => {
        const d = Object.getOwnPropertyDescriptor(a, "inputSchema");
        const sig = d && !d.get && Array.isArray(d.value) ? (d.value as z.ZodType[]).map(argTypeName).join(" ") : "";
        const live = await a.dynamicDescription?.();
        return { text: `(${name}${sig ? ` ${sig}` : ""}) - ${live ?? a.description}`, dynamic: live !== undefined };
      }),
    );
  }

  private log(
    ctx: ToolCallCtx,
    args: DiscoveryArgs,
    startTime: number,
    outcome: { success: boolean; errorMessage?: string },
  ) {
    const { expr: _e, intent, ...rest } = args;
    ctx.record?.({
      sessionId: ctx.session?.id ?? "unknown",
      userSub: ctx.user?.sub,
      tool: this.name,
      intent,
      arguments: rest,
      durationMs: Date.now() - startTime,
      ...outcome,
    });
  }
}
