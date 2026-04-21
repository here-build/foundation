import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import { omit, zip } from "lodash-es";
import invariant from "tiny-invariant";
import type { SetRequired } from "type-fest";
import * as z from "zod";

import { ToolInteraction, type MCPClientInfo } from "./ToolInteraction";

type Dezod<T extends Record<string, z.ZodType>> = {
  [key in keyof T]: Awaited<z.infer<T[key]>>;
};

type ActionDeclaration<T, TT extends Record<string, z.ZodType>, Context extends [...Array<keyof T>] = []> = {
  name: string;
  description: string | (() => Promise<string>);
  context?: Context;
  optionalContext?: Array<keyof T>;
  props: TT;
  handler: (context: SetRequired<T, Context[number]>, props: Dezod<TT>) => any;
};

type ActionDefinition<T, TT extends Record<string, z.ZodType>, Context extends [...Array<keyof T>] = []> = {
  description: string | (() => Promise<string>);
  context: Context;
  optionalContext: Array<keyof T>;
  args: z.ZodType[];
  argNames: string[];
  handler: (context: SetRequired<T, Context[number]>, props: Dezod<TT>) => any;
};

export type ActionCall = [string, ...any];

// we may transform values inside context schema, so it's fair to assume that types may change
export abstract class ActionToolInteraction<
  ExecutionContext extends Record<string, any>,
  CallContext extends Record<keyof ExecutionContext, any> = ExecutionContext,
> extends ToolInteraction<Record<keyof CallContext, any> & { actions: ActionCall[]; intent?: string }> {
  declare readonly contextSchema: {
    [key in keyof ExecutionContext]: z.ZodType<ExecutionContext[key], CallContext[key], any>;
  };

  additionalNotes = "";

  actions: Record<string, ActionDefinition<ExecutionContext, any, [...Array<keyof ExecutionContext>]>> = {};

  registerAction<TT extends Record<string, z.ZodType>, Context extends [...Array<keyof ExecutionContext>]>({
    name,
    description,
    context,
    optionalContext = [],
    props,
    handler,
  }: ActionDeclaration<ExecutionContext, TT, Context>) {
    // we have some inheritance issues here
    this.actions ??= {};
    // Process props in a predictable order
    const propEntries = Object.entries(props);

    this.actions[name] = {
      description,
      context: context ?? [],
      optionalContext,
      args: propEntries.map(([key, arg]) => arg),
      argNames: propEntries.map(([key]) => key),
      handler,
    };
  }

  async getToolSchema(): Promise<Tool["inputSchema"]> {
    // bare minimum of props that should be in each call
    const universallyRequiredProps = Object.values(this.actions).reduce(
      (acc, { context }) => acc.intersection(new Set(context)),
      new Set(Object.keys(this.contextSchema)),
    );
    return {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            "What you're trying to accomplish with this action. Shown to collaborating users in the studio UI to explain what's happening.",
        },
        actions: {
          type: "array",
          description:
            dedent`
            List of actions to execute within current tool invocation context.
            Actions are invoked in ["actionName", ...arguments] tuples and executed sequentially.
            This tool is designed to let you perform long sequences of actions over singular entity, allowing you to use context and time efficiently. 

            Context constraint: All actions in a batch share the exactly same context scope.
            Every field in context must be consumable by EVERY action.
            Examples:
            ✓ Valid: {component, actions: [action<component>, action<component>]} - same required context
            ✗ Invalid: {component, item, actions: [action<component, item>, action<component>] - mismatched required context
            ✓ Valid: {component, item, actions: [action<component, item, elementId?>, action<component, item?>] - since all actions are valid with current context, it will be executed.
          ` + (this.additionalNotes ? dedent`\n${this.additionalNotes}` : ""),
          items: {
            oneOf: await Promise.all(
              Object.entries(this.actions).map(async ([action, { description, context, optionalContext, args }]) => ({
                type: "array",
                description: dedent`
                    ${typeof description === "string" ? description : await description()}.
                    ${context.length > 0 ? `Required context: ${context.join(", ")}` : ""}
                    ${optionalContext.length > 0 ? `Optional context: ${[...optionalContext].join(", ")})` : ""}
                  `,
                items: [
                  {
                    const: action,
                  },
                  ...args.map((arg) => omit(z.toJSONSchema(arg, { io: "input" }), "$schema")),
                ],
              })),
            ),
          },
        },
        ...Object.fromEntries(
          this.contextSchema
            ? Object.entries(this.contextSchema).map(([key, value]) => {
                const { $schema: _, ...schema } = z.toJSONSchema(value, { io: "input" });
                return [
                  key,
                  {
                    ...schema,
                    description: schema.description
                      ? `Context property. ${dedent(schema.description)}`
                      : "Context property",
                  },
                ];
              })
            : [],
        ),
      },
      required: ["actions", ...universallyRequiredProps],
    };
  }

  // this may be incorrect in parallel computations, but here each interaction gets its own place
  loadingExecutionContext: Partial<ExecutionContext> = {};

  // hook for inherited elements
  protected async beforeAct(context: ExecutionContext) {}

  /** Override to include context state in action responses. Called after successful act(). */
  protected reflectContext(): Record<string, any> | null {
    return null;
  }

  /** Coerce array-like values. Handles JSON-encoded containers, objects with numeric keys. */
  private coerceToArray(value: unknown, label: string): unknown[] {
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

  async executeTool(clientInfo?: MCPClientInfo) {
    invariant(this.executionContext, "execution context should be provided for tool execution");
    const { actions: rawActions, intent, ...contextInput } = this.executionContext;
    let actions = this.coerceToArray(rawActions, "actions") as ActionCall[];
    // Auto-wrap flat tuple: ["set-styles", {...}] → [["set-styles", {...}]]
    if (actions.length > 0 && typeof actions[0] === "string") {
      console.log(`[actions] auto-wrap flat tuple: first element was string "${actions[0]}"`);
      actions = [actions] as unknown as ActionCall[];
    }
    // Flatten nested batches: [[["a",...],["b",...]],["c",...]] → [["a",...],["b",...],["c",...]]
    // Some models (Claude-distilled) nest groups of related actions inside extra arrays
    const beforeFlatten = actions.length;
    actions = actions.flatMap((a) => (Array.isArray(a) && Array.isArray(a[0]) ? a : [a])) as ActionCall[];
    if (actions.length !== beforeFlatten) {
      console.log(`[actions] flattened nested batches: ${beforeFlatten} → ${actions.length} actions`);
    }
    // Log final shape for debugging
    console.log(
      `[actions] ${actions.length} actions: [${actions.map((a) => (Array.isArray(a) ? a[0] : typeof a)).join(", ")}]`,
    );
    this.loadingExecutionContext = {};

    // Ensure actions are initialized (defensive)
    this.actions ??= {};

    type ValidationError =
      | { actionIndex: number; action: string; argument: string; path?: string; error: string; received?: string }
      | { actionIndex: number; action: string; error: string }
      | { property: keyof ExecutionContext; path?: string; error: string; received?: string }
      | { property: keyof ExecutionContext; error: string };

    const validationErrors: ValidationError[] = [];

    for (const [key, validator] of Object.entries(this.contextSchema) as [
      keyof ExecutionContext,
      z.ZodType<ExecutionContext[keyof ExecutionContext], CallContext[keyof ExecutionContext], any>,
    ][]) {
      try {
        let input = (contextInput as Record<string, unknown>)[key as string];
        // Some models double-serialize nested values as JSON strings
        if (typeof input === "string" && (input.startsWith("{") || input.startsWith("["))) {
          try {
            input = JSON.parse(input);
          } catch {
            /* not valid JSON, use as-is */
          }
        }
        this.loadingExecutionContext[key] ??= await validator.parseAsync(input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          // Detailed per-issue errors for context properties
          for (const issue of error.issues) {
            const pathStr = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";

            // Extract received value from different issue types
            let received: string | undefined;
            if ("received" in issue) {
              received = String((issue as { received: unknown }).received);
            }

            validationErrors.push({
              property: key,
              path: pathStr || undefined,
              error: issue.message,
              received,
            });
          }
        } else {
          validationErrors.push({
            property: key,
            error: String(error),
          });
        }
      }
    }

    // Validate and transform all action arguments
    const transformedActionArgs: any[][] = [];

    for (const [i, rawAction] of actions.entries()) {
      const coerced = this.coerceToArray(rawAction, `actions[${i}]`);
      const [actionName, ...actionArgs] = coerced as [string, ...any];
      const action = this.actions[actionName];
      if (!action) {
        validationErrors.push({
          actionIndex: i,
          action: actionName,
          error: `Unknown action "${actionName}". Available actions: ${Object.keys(this.actions).join(", ")}`,
        });
        transformedActionArgs.push(actionArgs); // Store even if unknown action
        continue;
      }

      if (action.args.length > 0) {
        try {
          // Use parseAsync to handle async transforms, store transformed values
          const transformed = await z.tuple(action.args as [z.ZodType, ...z.ZodType[]]).parseAsync(actionArgs);
          transformedActionArgs.push(transformed);
        } catch (error) {
          if (error instanceof z.ZodError) {
            // Detailed per-issue errors with arg names and paths
            for (const issue of error.issues) {
              const argIndex = typeof issue.path[0] === "number" ? issue.path[0] : null;
              const argName = argIndex === null ? null : action.argNames[argIndex];
              const subPath = argIndex === null ? issue.path : issue.path.slice(1);
              const pathStr = subPath.length > 0 ? `.${subPath.join(".")}` : "";

              // Extract received value from different issue types
              let received: string | undefined;
              if ("received" in issue) {
                received = String((issue as { received: unknown }).received);
              }

              validationErrors.push({
                actionIndex: i,
                action: actionName,
                argument: argName ?? `arg[${argIndex}]`,
                path: pathStr || undefined,
                error: issue.message,
                received,
              });
            }
          } else {
            validationErrors.push({
              actionIndex: i,
              action: actionName,
              error: String(error),
            });
          }
          transformedActionArgs.push(actionArgs); // Store untransformed on error
        }
      } else {
        transformedActionArgs.push([]);
      }
    }

    if (validationErrors.length > 0) {
      // Format errors as S-expression for better Claude readability
      const formatError = (err: ValidationError): string => {
        if ("actionIndex" in err) {
          const parts: string[] = [`action ${err.actionIndex} "${err.action}"`];
          if ("argument" in err) {
            const argParts: string[] = [`"${err.argument}"`];
            if (err.path) argParts.push(`"${err.path}"`);
            argParts.push(`(error "${err.error}"${err.received ? ` (received "${err.received}")` : ""})`);
            parts.push(`(argument ${argParts.join(" ")})`);
          } else {
            parts.push(`(error "${err.error}")`);
          }
          return `(${parts.join(" ")})`;
        } else {
          const parts: string[] = [`context "${String(err.property)}"`];
          if ("path" in err && err.path) {
            parts.push(`"${err.path}"`);
          }
          const received = "received" in err ? err.received : undefined;
          if ("property" in err) {
            parts.push(
              `(context-error ${err.property.toString()} "${err.error}"${received ? ` (received "${received}")` : ""})`,
            );
          } else {
            // @ts-expect-error
            parts.push(`(error "${err.error}"${received ? ` (received "${received}")` : ""})`);
          }
          return `(${parts.join(" ")})`;
        }
      };

      const sexpr = `(validation-error\n  ${validationErrors.map(formatError).join("\n  ")})`;

      return {
        success: false,
        validation: "failed",
        ...(intent ? { intent } : {}),
        errors: validationErrors,
        sexpr,
        message: `Validation failed for ${validationErrors.length} issue(s). No actions were executed. See 'sexpr' field for structured error details.`,
      } as const;
    }

    return this.act(actions, transformedActionArgs);
  }

  async act(actions: ActionCall[], transformedActionArgs: any[][]) {
    const results: any[] = [];

    for (let i = 0; i < actions.length; i++) {
      const [actionName] = actions[i];
      const actionArgs = transformedActionArgs[i]; // Use transformed args
      const action = this.actions[actionName]!; // We know it exists from validation

      try {
        results.push(
          await action.handler(
            this.loadingExecutionContext as any,
            Object.fromEntries(zip(action.argNames, actionArgs)) as any,
          ),
        );
      } catch (error) {
        return {
          success: false,
          partial: true,
          executed: i,
          total: actions.length,
          results,
          failedAction: {
            actionIndex: i,
            action: actionName,
            error: error instanceof Error ? error.message : String(error),
          },
          message: `Executed ${i} of ${actions.length} actions before runtime failure; doing full rollback due to failed action ${actionName}.`,
        } as const;
      }
    }

    return results;
  }
}
