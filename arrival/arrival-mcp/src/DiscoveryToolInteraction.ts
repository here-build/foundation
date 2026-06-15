import { Environment, execSerialized, sandboxedEnv } from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { format } from "date-fns";
import dedent from "dedent";
import invariant from "tiny-invariant";
import * as z from "zod";

import { ToolInteraction, type MCPClientInfo } from "./ToolInteraction.js";
import type { McpEnvCapability } from "./McpEnvCapability.js";

export interface DiscoveryQuery {
  expr: string;
}

/** Render one positional zod arg as a Scheme-doc type token for the verb catalog. */
function argTypeName(item: z.ZodType): string {
  let postfix = "";
  try {
    if (item.safeParse(undefined).success) postfix += "?";
  } catch {
    // some complex transforms throw on a probe parse — treat as required
  }
  if (item.description) postfix += ` (${item.description})`;
  if (item instanceof z.ZodString) return `string${postfix}`;
  if (item instanceof z.ZodNumber) return `number${postfix}`;
  if (item instanceof z.ZodBoolean) return `boolean${postfix}`;
  if (item instanceof z.ZodArray) return `list${postfix}`;
  if (item instanceof z.ZodEnum) return item.options.map((v) => `"${v}"`).join("|");
  if (item instanceof z.ZodAny) return `any`;
  return `value${postfix}`;
}

type DiscoveryFunctionDescription = string | { dynamic: true; value: string };

export abstract class DiscoveryToolInteraction<ExecutionContext extends Record<string, any>> extends ToolInteraction<
  DiscoveryQuery & ExecutionContext
> {
  /** Wall-clock eval budget (the interpreter TICK-checks it — replaces the old cooperative timeout). */
  private readonly MAX_EXECUTION_TIME = 5000;
  public readonly contextSchema: Record<string, z.ZodType> = {};

  async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
    return {
      ...(await super.getToolDescription(clientInfo)),
      annotations: {
        readOnlyHint: true,
      },
    };
  }

  protected getAIPersonalizedName(clientInfo?: MCPClientInfo) {
    switch (clientInfo?.name) {
      case "claude-ai":
        return `Claude`;
      default:
        return "";
    }
  }

  async getToolSchema(clientInfo?: MCPClientInfo): Promise<Tool["inputSchema"]> {
    const availableFunctions = await this.getAvailableFunctions();
    const availableFunctionStrings = availableFunctions.map((description) =>
      typeof description === "object" ? description.value : description,
    );
    const dynamic = availableFunctions.some((description) => typeof description === "object" && description.dynamic);
    const now = new Date();
    const aiName = this.getAIPersonalizedName(clientInfo);
    const baseSymbols = this.baseEnvSymbols().join(", ");
    return {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "What you're exploring and why. Shown to collaborating users in the studio UI.",
        },
        expr: {
          type: "string",
          description:
            [
              dedent`
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
            `,
              ...availableFunctionStrings,
            ].join("\n") +
            (dynamic
              ? dedent`
              NOTE${aiName ? ` FOR ${aiName.toUpperCase()}` : ""} ON LIVE DESCRIPTION:
              The data provided above IS NOT STATIC.
              It is dynamically generated at every MCP session start. <timestamp>${format(now, "MMM do, HH:MM X")}</timestamp>

              Some descriptions have user- and session-personalized, actual state at session start directly in description.
              That data is generated dynamically${aiName ? ` (yes, ${aiName}, this tool description is not static and was generated personally for you right now)` : ""} on description fetch to provide instant basic awareness even before session starts.
              Consider it as a dashboard or welcome screen for this MCP application.
            `
              : ""),
        },
        ...Object.fromEntries(
          Object.entries(this.contextSchema).map(([key, value]) => {
            const { $schema: _, ...schema } = z.toJSONSchema(value);
            return [
              key,
              {
                ...schema,
                description: `Context property${schema.description ? `. ${schema.description}` : ""}`,
              },
            ];
          }),
        ),
      },
      required: ["expr"],
    };
  }

  async executeTool(): Promise<string | string[]> {
    invariant(this.executionContext, "execution context should be provided for tool execution");
    const env = await this.createEnvironment();
    const budgetMs = this.MAX_EXECUTION_TIME;

    const expr = this.executionContext.expr;

    // Replay previous REPL inputs to re-establish cross-call bindings against CURRENT state.
    //
    // We replay ONLY pure top-level `(define …)` forms — and NEVER ones that invoke the run channel
    // (`require/eval` / `require/call`). Replay exists to re-establish bindings; a query's result was
    // discarded, so re-running it is pointless, and re-running an isolated RUN on every subsequent
    // call is actively harmful — it re-fires effects (infer/http) and re-pays a full pipeline each
    // time, so a long session degrades quadratically (the "stuck" symptom). Run handles are used
    // WITHIN their batched call, not across calls, so dropping run-defines from replay is sound.
    //
    // Replay is also BEST-EFFORT and per-entry: a surviving define that no longer reproduces (it read
    // state an edit since moved) is DROPPED rather than allowed to poison the whole session.
    const isPureDefine = (src: string): boolean => {
      const t = src.trim();
      return t.startsWith("(define") && !/\brequire\/(eval|call)\b/.test(t);
    };
    const history: string[] = this.state.__repl__ ?? [];
    const survived: string[] = [];
    for (const past of history) {
      if (!isPureDefine(past)) continue; // keep in history (below) but don't replay non-bindings
      try {
        await execSerialized(past, { env, budgetMs });
      } catch {
        continue; // dead binding — references state that no longer reproduces; drop from history.
      }
      survived.push(past);
    }
    this.state.__repl__ = survived;

    // Evaluate the new expression and return its result
    const result = await execSerialized(expr, { env, budgetMs });

    // Record this input for future replay (appended to the pruned survivors)
    survived.push(expr);
    this.state.__repl__ = survived;

    return result;
  }

  /** The aggregating MCP capability whose `deps` ARE the verb set — env + catalog both derive
   *  from it (env via `assembleEnv`'s dep-closure; catalog via `allAnnotations`). */
  protected abstract capability(): McpEnvCapability;

  /** Config passed to the capability's `lower()` (e.g. `{ project }`). Defaults to the
   *  execution context; override for a narrower/typed config. */
  protected capabilityConfig(): Record<string, unknown> {
    return (this.executionContext ?? {}) as Record<string, unknown>;
  }

  /** The base env capabilities assemble onto — the foundation vocabulary the tool PROVIDES
   *  alongside the env capabilities. Override to supply a different base. */
  protected baseEnv(): Environment {
    return sandboxedEnv.inherit("Discovery sandbox", {});
  }

  /** The base env's full symbol set (chain-walked, sorted) — advertised in the schema in place
   *  of a hardcoded builtin constant, so the docs are FAITHFUL to the real env we run. */
  private baseEnvSymbols(): string[] {
    const names = new Set<string>();
    for (let e: Environment | null = this.baseEnv(); e; e = e.__parent__) {
      for (const k of e.list()) if (typeof k === "string") names.add(k);
    }
    return [...names].sort();
  }

  /** The verb catalog — reflected off the capability's dep-closure annotations (dynamic
   *  descriptions resolved). One declaration site (the capability), nothing hand-listed. */
  protected getAvailableFunctions(): Promise<DiscoveryFunctionDescription[]> {
    return Promise.all(
      Object.entries(this.capability().allAnnotations()).map(async ([name, a]) => {
        // Only a STATIC inputSchema array renders a sig; a getter (resource-resolving) mustn't
        // be invoked here (no live activation) — read the descriptor, don't access it.
        const d = Object.getOwnPropertyDescriptor(a, "inputSchema");
        const sig = d && !d.get && Array.isArray(d.value) ? d.value.map(argTypeName).join(" ") : "";
        const resolved = typeof a.description === "function" ? await a.description() : a.description;
        const dynamic = typeof resolved === "object" ? resolved.dynamic : false;
        const text = typeof resolved === "object" ? resolved.value : resolved;
        const full = `(${name}${sig ? ` ${sig}` : ""}) - ${text}`;
        return dynamic ? { dynamic: true as const, value: full } : full;
      }),
    );
  }

  /** Assemble the env from the aggregating capability — its `deps` closure (C3-linearized by
   *  `assembleEnv`) IS the verb set; arg-parsing lives in the capability, the eval is
   *  budget-bounded in `executeTool`. `lower()`'s apply is async, hence `assembleEnv`. */
  protected createEnvironment(): Promise<any> {
    const base = this.baseEnv();
    return assembleEnv(base, [
      this.capability().lower({
        config: this.capabilityConfig(),
        evalScheme: (e, src) => execSerialized(src, { env: e }),
      }),
    ]).then(({ env }) => env);
  }
}
