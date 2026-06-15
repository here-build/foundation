// ActionTool — the mutation tier as a VALUE, not a subclass. The sibling of DiscoveryTool: where
// that runs a Scheme REPL over a capability, this dispatches a BATCH of tuple-invoked, typed actions
// (`["set-styles", {…}]`) sharing one context scope, with rollback-on-failure.
//
// `new ActionTool(name, { description, contextSchema, actions: (action) => ({ … }) })`. The `action`
// factory is bound to the contextSchema's RESOLVED type, so each handler's `context` is narrowed to
// the fields it declares and its `props` are inferred from the zod — no runtime casts.
//
// The contextSchema is twice load-bearing: it's the AWARENESS wiring (actions reference shared fields
// by name; handlers get them typed) AND the token saver — the shared context is declared ONCE at the
// top of the schema and validated/transformed ONCE per batch, so N actions don't each re-declare
// projectId/element; they reference it. That is the "all actions in a batch share exactly the same
// context scope" constraint, and the reason the preamble stays small.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import { omit, zip } from "lodash-es";
import invariant from "tiny-invariant";
import type { SetRequired } from "type-fest";
import * as z from "zod";

import type { InteractionLog, ToolCallCtx } from "./DiscoveryTool.js";

type Dezod<T extends Record<string, z.ZodType>> = { [K in keyof T]: Awaited<z.infer<T[K]>> };
type InferCtx<CS extends Record<string, z.ZodType>> = { [K in keyof CS]: Awaited<z.infer<CS[K]>> };

/** One action as written in the builder. `props` are the positional args (a zod record; positional
 *  order = insertion order); `context` names the shared-context fields the handler requires (so its
 *  `context` arg is narrowed to have them present). */
export interface ActionSpec<Ctx, Props extends Record<string, z.ZodType>, Need extends keyof Ctx> {
  description: string | (() => Promise<string>);
  context?: readonly Need[];
  optionalContext?: readonly (keyof Ctx)[];
  props: Props;
  handler: (context: SetRequired<Ctx, Need>, props: Dezod<Props>) => unknown | Promise<unknown>;
}

/** The erased, executor-ready form — props split into ordered args + names (indexed in lockstep). */
interface ActionDef {
  description: string | (() => Promise<string>);
  context: readonly string[];
  optionalContext: readonly string[];
  args: z.ZodType[];
  argNames: string[];
  handler: (context: any, props: any) => unknown | Promise<unknown>;
}

/** The context-bound factory the `actions` builder receives — infers each action's `props` + required
 *  context, type-checking the handler against them, and erases to an {@link ActionDef}. */
export type ActionFactory<Ctx> = <Props extends Record<string, z.ZodType>, Need extends keyof Ctx = never>(
  spec: ActionSpec<Ctx, Props, Need>,
) => ActionDef;

function actionFactory<Ctx>(): ActionFactory<Ctx> {
  return (spec) => {
    const entries = Object.entries(spec.props);
    return {
      description: spec.description,
      context: (spec.context ?? []) as readonly string[],
      optionalContext: (spec.optionalContext ?? []) as readonly string[],
      args: entries.map(([, v]) => v),
      argNames: entries.map(([k]) => k),
      handler: spec.handler as ActionDef["handler"],
    };
  };
}

type ActionCall = [string, ...unknown[]];

export interface ActionToolOptions<CS extends Record<string, z.ZodType>> {
  description: string;
  /** The shared context scope — validated + transformed ONCE per batch. Doubles as the awareness
   *  wiring (actions reference these by name) and the token saver (declared once, not per action). */
  contextSchema: CS;
  /** Builder receiving the context-bound `action` factory; returns the action map (name → spec). */
  actions: (action: ActionFactory<InferCtx<CS>>) => Record<string, ActionDef>;
  /** Appended to the `actions` field description (e.g. domain notes). */
  additionalNotes?: string;
}

/** Coerce an array-like value (a real array, a JSON-encoded one, or an object with numeric keys) —
 *  models double-encode containers in surprising ways; meet them where they are. */
function coerceToArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      value = parsed;
    } catch {
      /* not valid JSON */
    }
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys.sort((a, b) => Number(a) - Number(b)).map((k) => (value as Record<string, unknown>)[k]);
    }
  }
  invariant(false, `${label}: expected array, got ${typeof value}: ${JSON.stringify(value)?.slice(0, 200)}`);
}

type ActionArgs = { actions: unknown; intent?: string } & Record<string, unknown>;

/** A mutation tool over a batch of typed actions. Construct once per CONNECTION (the host arms
 *  `contextSchema`'s transforms with its infra); `call` runs one batch per request. */
export class ActionTool<CS extends Record<string, z.ZodType> = Record<string, z.ZodType>> {
  private readonly actions: Record<string, ActionDef>;

  constructor(
    readonly name: string,
    private readonly options: ActionToolOptions<CS>,
  ) {
    this.actions = options.actions(actionFactory<InferCtx<CS>>());
  }

  /** The MCP `Tool` definition — the actions oneOf + the shared context fields, declared once. */
  async describe(): Promise<Tool> {
    return { name: this.name, description: this.options.description, inputSchema: await this.inputSchema() };
  }

  /** Validate the shared context + every action's args (transforms run), then run the batch
   *  sequentially with rollback-report on the first runtime failure. Returns a validation-error
   *  object, the action results, or a partial-failure report — the transport serializes it. */
  async call(args: ActionArgs, ctx: ToolCallCtx = {}): Promise<unknown> {
    const startTime = Date.now();
    const { actions: rawActions, intent, ...contextInput } = args;

    // Coerce + un-nest the model's action shapes: a flat tuple → a one-element batch; nested batches
    // (some models wrap groups in an extra array) → flattened.
    let actions = coerceToArray(rawActions, "actions") as ActionCall[];
    if (actions.length > 0 && typeof actions[0] === "string") actions = [actions] as unknown as ActionCall[];
    actions = actions.flatMap((a) => (Array.isArray(a) && Array.isArray(a[0]) ? a : [a])) as ActionCall[];

    const result = await this.validateAndAct(actions, contextInput, intent, ctx);
    const failed = result !== null && typeof result === "object" && "success" in result && result.success === false;
    this.log(ctx, args, startTime, failed ? { success: false } : { success: true });
    return result;
  }

  private async validateAndAct(
    actions: ActionCall[],
    contextInput: Record<string, unknown>,
    intent: string | undefined,
    ctx: ToolCallCtx,
  ): Promise<unknown> {
    type ValidationError =
      | { actionIndex: number; action: string; argument?: string; path?: string; error: string; received?: string }
      | { property: string; path?: string; error: string; received?: string };
    const errors: ValidationError[] = [];

    // 1) Shared context — validated + transformed ONCE (the scope every action shares).
    const context: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(this.options.contextSchema)) {
      try {
        let input = contextInput[key];
        if (typeof input === "string" && (input.startsWith("{") || input.startsWith("["))) {
          try {
            input = JSON.parse(input);
          } catch {
            /* not JSON — use as-is */
          }
        }
        context[key] = await validator.parseAsync(input);
      } catch (error) {
        for (const issue of zodIssues(error, key)) errors.push(issue);
      }
    }

    // 2) Each action's positional args — validated + transformed (so a transform resolves pre-handler).
    const transformedArgs: unknown[][] = [];
    for (const [i, rawAction] of actions.entries()) {
      const [actionName, ...actionArgs] = coerceToArray(rawAction, `actions[${i}]`) as [string, ...unknown[]];
      const action = this.actions[actionName];
      if (!action) {
        errors.push({ actionIndex: i, action: actionName, error: `Unknown action "${actionName}". Available: ${Object.keys(this.actions).join(", ")}` });
        transformedArgs.push(actionArgs);
        continue;
      }
      if (action.args.length === 0) {
        transformedArgs.push([]);
        continue;
      }
      try {
        transformedArgs.push([...(await z.tuple(action.args as [z.ZodType, ...z.ZodType[]]).parseAsync(actionArgs))]);
      } catch (error) {
        for (const issue of zodArgIssues(error, i, actionName, action.argNames)) errors.push(issue);
        transformedArgs.push(actionArgs);
      }
    }

    if (errors.length > 0) {
      const sexpr = `(validation-error\n  ${errors.map(formatError).join("\n  ")})`;
      return { success: false as const, validation: "failed", ...(intent ? { intent } : {}), errors, sexpr,
        message: `Validation failed for ${errors.length} issue(s). No actions were executed. See 'sexpr' for details.` };
    }

    // 3) Run the batch sequentially; rollback-report on the first runtime failure. The signal cancels
    //    BETWEEN actions (a partial batch is reported, not silently half-applied).
    const results: unknown[] = [];
    for (let i = 0; i < actions.length; i++) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("aborted", "AbortError");
      const [actionName] = actions[i]!;
      const action = this.actions[actionName]!;
      try {
        results.push(await action.handler(context, Object.fromEntries(zip(action.argNames, transformedArgs[i]))));
      } catch (error) {
        return { success: false as const, partial: true, executed: i, total: actions.length, results,
          failedAction: { actionIndex: i, action: actionName, error: error instanceof Error ? error.message : String(error) },
          message: `Executed ${i} of ${actions.length} actions before runtime failure; full rollback due to ${actionName}.` };
      }
    }
    return results;
  }

  private async inputSchema(): Promise<Tool["inputSchema"]> {
    // Required at the batch level = the fields EVERY action requires (intersection) — a batch shares
    // one scope, so only universally-required context can be marked required.
    const universallyRequired = Object.values(this.actions).reduce(
      (acc, { context }) => acc.intersection(new Set(context)),
      new Set(Object.keys(this.options.contextSchema)),
    );
    return {
      type: "object",
      properties: {
        intent: { type: "string", description: "What you're trying to accomplish. Shown to collaborating users." },
        actions: {
          type: "array",
          description:
            dedent`
              Actions to run in this invocation, as ["actionName", ...args] tuples, executed sequentially.
              All actions in a batch share EXACTLY the same context scope — every context field must be
              consumable by every action.
            ` + (this.options.additionalNotes ? `\n${dedent(this.options.additionalNotes)}` : ""),
          items: {
            oneOf: await Promise.all(
              Object.entries(this.actions).map(async ([action, { description, context, optionalContext, args }]) => ({
                type: "array",
                description: dedent`
                  ${typeof description === "string" ? description : await description()}.
                  ${context.length > 0 ? `Required context: ${context.join(", ")}` : ""}
                  ${optionalContext.length > 0 ? `Optional context: ${optionalContext.join(", ")}` : ""}
                `,
                // Draft 2020-12 (the Anthropic tool-use API) uses `prefixItems` for positional tuples,
                // NOT the draft-07 `items`-array form (which it rejects).
                prefixItems: [{ const: action }, ...args.map((arg) => omit(z.toJSONSchema(arg, { io: "input" }), "$schema"))],
              })),
            ),
          },
        },
        ...Object.fromEntries(
          Object.entries(this.options.contextSchema).map(([key, value]) => {
            const { $schema: _drop, ...schema } = z.toJSONSchema(value, { io: "input" });
            return [key, { ...schema, description: schema.description ? `Context property. ${dedent(schema.description)}` : "Context property" }];
          }),
        ),
      },
      required: ["actions", ...universallyRequired],
    };
  }

  private log(ctx: ToolCallCtx, args: ActionArgs, startTime: number, outcome: { success: boolean }) {
    const { actions: _a, intent, ...rest } = args;
    ctx.record?.({
      sessionId: ctx.session?.id ?? "unknown",
      userSub: ctx.user?.sub,
      tool: this.name,
      intent,
      arguments: rest,
      durationMs: Date.now() - startTime,
      ...outcome,
    } satisfies InteractionLog);
  }
}

// ── error formatting (S-expression — Claude reads it more reliably than nested JSON) ──

type CtxIssue = { property: string; path?: string; error: string; received?: string };
type ArgIssue = { actionIndex: number; action: string; argument?: string; path?: string; error: string; received?: string };

function zodIssues(error: unknown, property: string): CtxIssue[] {
  if (!(error instanceof z.ZodError)) return [{ property, error: String(error) }];
  return error.issues.map((issue) => ({
    property,
    path: issue.path.length > 0 ? `.${issue.path.join(".")}` : undefined,
    error: issue.message,
    received: "received" in issue ? String((issue as { received: unknown }).received) : undefined,
  }));
}

function zodArgIssues(error: unknown, actionIndex: number, action: string, argNames: string[]): ArgIssue[] {
  if (!(error instanceof z.ZodError)) return [{ actionIndex, action, error: String(error) }];
  return error.issues.map((issue) => {
    const argIndex = typeof issue.path[0] === "number" ? issue.path[0] : null;
    const subPath = argIndex === null ? issue.path : issue.path.slice(1);
    return {
      actionIndex,
      action,
      argument: argIndex === null ? undefined : (argNames[argIndex] ?? `arg[${argIndex}]`),
      path: subPath.length > 0 ? `.${subPath.join(".")}` : undefined,
      error: issue.message,
      received: "received" in issue ? String((issue as { received: unknown }).received) : undefined,
    };
  });
}

function formatError(err: CtxIssue | ArgIssue): string {
  const recv = err.received ? ` (received "${err.received}")` : "";
  if ("actionIndex" in err) {
    const arg = err.argument ? ` (argument "${err.argument}"${err.path ? ` "${err.path}"` : ""})` : "";
    return `(action ${err.actionIndex} "${err.action}"${arg} (error "${err.error}"${recv}))`;
  }
  return `(context "${err.property}"${err.path ? ` "${err.path}"` : ""} (error "${err.error}"${recv}))`;
}
