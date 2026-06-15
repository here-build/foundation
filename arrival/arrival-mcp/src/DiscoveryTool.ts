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

import { type Environment, execSerialized, sandboxedEnv } from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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
  description: string | Promise<string>;
  /** The base env capabilities assemble onto. Defaults to a fresh sandbox. */
  baseEnv?: () => Environment;
  /** Wall-clock eval budget (the interpreter TICK-checks it). */
  budgetMs?: number;
}

type DiscoveryArgs = { expr: string; intent?: string } & Record<string, unknown>;

/** A discovery tool bound to one aggregating capability. Construct once per CONNECTION (the host
 *  builds `capability` with its infra armed into the resources); `call` runs once per request. */
export class DiscoveryTool {
  private readonly MAX_EXECUTION_TIME = 5000;

  constructor(
    readonly name: string,
    private readonly capability: McpEnvCapability,
    private readonly options: DiscoveryToolOptions,
  ) {}

  /** The MCP `Tool` definition — name, description, input schema. Read-only hint by construction. */
  async describe(clientInfo?: Record<string, unknown>): Promise<Tool> {
    return {
      name: this.name,
      description: await this.options.description,
      inputSchema: await this.inputSchema(clientInfo),
      annotations: { readOnlyHint: true },
    };
  }

  /** Evaluate `args.expr` in the env assembled from the capability, under the dispatch-time ctx.
   *  Replays the session's prior pure `(define …)`s first (honest replay against CURRENT state),
   *  threads `ctx.signal` + a wall-clock budget into the eval, and records the interaction. */
  async call(args: DiscoveryArgs, ctx: ToolCallCtx = {}): Promise<string[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? this.MAX_EXECUTION_TIME;
    const { signal } = ctx;
    const env = await this.environment(args);
    const state = ctx.session?.state ?? {};

    try {
      // Replay ONLY pure top-level `(define …)` (never a run-channel form) to re-establish bindings
      // against current state — a define that no longer reproduces is dropped, not allowed to poison.
      const history = (state.__repl__ as string[] | undefined) ?? [];
      const survived: string[] = [];
      for (const past of history) {
        if (!/^\(define\b/.test(past.trim()) || /\brequire\/(eval|call)\b/.test(past)) continue;
        try {
          await execSerialized(past, { env, budgetMs, signal });
          survived.push(past);
        } catch {
          /* dead binding — drop from history */
        }
      }

      const result = await execSerialized(args.expr, { env, budgetMs, signal });
      survived.push(args.expr);
      state.__repl__ = survived;

      this.log(ctx, args, startTime, { success: true });
      return result;
    } catch (error) {
      this.log(ctx, args, startTime, {
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ── env assembly: config from the actor args, resources armed by the capability ──

  private environment(args: DiscoveryArgs): Promise<Environment> {
    const base = this.options.baseEnv?.() ?? sandboxedEnv.inherit("Discovery sandbox", {});
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
    const exprDoc =
      ["Scheme (Lisp dialect) REPL over the system-state snapshot. Domain verbs:", ...verbs.map((v) => v.text)].join(
        "\n",
      ) +
      (dynamic
        ? `\n\nNOTE${aiName ? ` FOR ${aiName.toUpperCase()}` : ""}: some verb descriptions are session-generated live — treat this as a welcome screen.`
        : "");

    const configSchema = (this.capability.spec as McpCapabilitySpec<never, never>).configuration ?? {};
    const configProps = Object.fromEntries(
      Object.entries(configSchema as Record<string, z.ZodType>).map(([key, value]) => {
        const { $schema: _drop, ...schema } = z.toJSONSchema(value);
        return [key, schema];
      }),
    );

    return {
      type: "object",
      properties: {
        intent: { type: "string", description: "What you're exploring and why. Shown to collaborating users." },
        expr: { type: "string", description: exprDoc },
        ...configProps,
      },
      required: ["expr"],
    };
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

  private log(ctx: ToolCallCtx, args: DiscoveryArgs, startTime: number, outcome: { success: boolean; errorMessage?: string }) {
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
