import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import { omit, zip } from "lodash-es";
import * as z from "zod";

import { ToolInteraction } from "./ToolInteraction";
import invariant from "tiny-invariant";
import { MCPClientInfo } from "./hono/HonoMCPServer";
import { SetRequired } from "type-fest";

type Dezod<T extends Record<string, z.ZodType>> = {
  [key in keyof T]: Awaited<z.infer<T[key]>>
}

type ActionDeclaration<T, TT extends Record<string, z.ZodType>, Context extends [...Array<keyof T>] = []> = {
  name: string;
  description: string | (() => Promise<string>);
  context?: Context,
  optionalContext?: Array<keyof T>
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

export type ActionCall = [string, ...any]

// we may transform values inside context schema, so it's fair to assume that types may change
export abstract class ActionToolInteraction<ExecutionContext extends Record<string, any>, CallContext extends Record<keyof ExecutionContext, any> = ExecutionContext> extends ToolInteraction<Record<keyof CallContext, any> & { actions: ActionCall[] }> {
  declare readonly contextSchema: {
    [key in keyof ExecutionContext]: z.ZodType<ExecutionContext[key], CallContext[key], any>;
  };

  additionalNotes = "";

  actions: Record<string, ActionDefinition<ExecutionContext, any, [...Array<keyof ExecutionContext>]>> = {};

  registerAction<TT extends Record<string, z.ZodType>, Context extends [...Array<keyof ExecutionContext>]>({ name, description, context, optionalContext = [], props, handler }: ActionDeclaration<ExecutionContext, TT, Context>) {
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
        actions: {
          type: "array",
          description: dedent`
            List of actions to execute within current tool invocation context.
            Actions are invoked in ["actionName", ...arguments] tuples and executed sequentially.
            This tool is designed to let you perform long sequences of actions over singular entity, allowing you to use context and time efficiently. 

            Context constraint: All actions in a batch share the exactly same context scope.
            Every field in context must be consumable by EVERY action.
            Examples:
            ✓ Valid: {component, actions: [action<component>, action<component>]} - same required context
            ✗ Invalid: {component, item, actions: [action<component, item>, action<component>] - mismatched required context
            ✓ Valid: {component, item, actions: [action<component, item, elementId?>, action<component, item?>] - since all actions are valid with current context, it will be executed.
          ` + this.additionalNotes ? dedent`\n${this.additionalNotes}` : '',
          items: {
            type: {
              oneOf: await Promise.all(
                Object.entries(this.actions).map(
                  async ([action, { description, context, optionalContext, args }]) => ({
                    type: "array",
                    description: dedent`
                      ${typeof description === "string" ? description : await description()}.
                      ${context.length > 0 ? `Required context: ${context.join(", ")}` : ''}
                      ${optionalContext.length > 0 ? `Optional context: ${[...optionalContext].join(", ")})` : ""}
                    `,
                    items: [
                      {
                        const: action,
                      },
                      ...args.map((arg) => omit(z.toJSONSchema(arg, {io: "input"}), "$schema")),
                    ],
                  }),
                ),
              ),
            },
          },
        },
        ...Object.fromEntries(
          this.contextSchema
            ? Object.entries(this.contextSchema).map(([key, value]) => {
              const {$schema, ...schema} = z.toJSONSchema(value, {io: "input"}) as any;
              return [
                key,
                {
                  ...schema,
                  description: schema.description ? `Context property. ${dedent(schema.description)}` : 'Context property',
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

  async executeTool(clientInfo?: MCPClientInfo) {
    invariant(this.executionContext, "execution context should be provided for tool execution");
    const {actions, ...contextInput} = this.executionContext;
    this.loadingExecutionContext = {};

    // Ensure actions are initialized (defensive)
    this.actions ??= {};

    type ValidationError =
      | { actionIndex: number; action: string; argument: string; path?: string; error: string; received?: string }
      | { actionIndex: number; action: string; error: string }
      | { property: keyof ExecutionContext; path?: string; error: string; received?: string }
      | { property: keyof ExecutionContext; error: string };

    const validationErrors: ValidationError[] = [];

    for (const [key, validator] of Object.entries(this.contextSchema) as [keyof ExecutionContext, z.ZodType<ExecutionContext[keyof ExecutionContext], CallContext[keyof ExecutionContext], any>][]) {
      try {
        const input = (contextInput as any)[key];
        if (typeof input === "string" && input.trim().startsWith("{")){
          try {
            // some
            this.loadingExecutionContext[key] = await validator.parseAsync(JSON.parse(input));
          } catch {}
        } else {
          this.loadingExecutionContext[key] ??= await validator.parseAsync(input);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          // Detailed per-issue errors for context properties
          for (const issue of error.issues) {
            const pathStr = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';

            // Extract received value from different issue types
            let received: string | undefined;
            if ('received' in issue) {
              received = String((issue as any).received);
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

    for (const [i, [actionName, ...actionArgs]] of actions.entries()) {
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
          const transformed = await z.tuple(action.args as any).parseAsync(actionArgs);
          transformedActionArgs.push(transformed);
        } catch (error) {
          if (error instanceof z.ZodError) {
            // Detailed per-issue errors with arg names and paths
            for (const issue of error.issues) {
              const argIndex = typeof issue.path[0] === 'number' ? issue.path[0] : null;
              const argName = argIndex !== null ? action.argNames[argIndex] : null;
              const subPath = argIndex !== null ? issue.path.slice(1) : issue.path;
              const pathStr = subPath.length > 0 ? `.${subPath.join('.')}` : '';

              // Extract received value from different issue types
              let received: string | undefined;
              if ('received' in issue) {
                received = String((issue as any).received);
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
      console.log(validationErrors)

      // Format errors as S-expression for better Claude readability
      const formatError = (err: ValidationError): string => {
        if ('actionIndex' in err) {
          const parts: string[] = [`action ${err.actionIndex} "${err.action}"`];
          if ('argument' in err) {
            const argParts: string[] = [`"${err.argument}"`];
            if (err.path) argParts.push(`"${err.path}"`);
            argParts.push(`(error "${err.error}"${err.received ? ` (received "${err.received}")` : ''})`);
            parts.push(`(argument ${argParts.join(' ')})`);
          } else {
            parts.push(`(error "${err.error}")`);
          }
          return `(${parts.join(' ')})`;
        } else {
          const parts: string[] = [`context "${String(err.property)}"`];
          if ('path' in err && err.path) {
            parts.push(`"${err.path}"`);
          }
          const received = 'received' in err ? err.received : undefined;
          if ("property" in err) {
            parts.push(`(context-error ${err.property.toString()} "${err.error}"${received ? ` (received "${received}")` : ''})`);
          } else {
            // @ts-expect-error
            parts.push(`(error "${err.error}"${received ? ` (received "${received}")` : ''})`);
          }
          return `(${parts.join(' ')})`;
        }
      };

      const sexpr = `(validation-error\n  ${validationErrors.map(formatError).join('\n  ')})`;

      return {
        success: false,
        validation: "failed",
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
          await action.handler(this.loadingExecutionContext as any, Object.fromEntries(zip(action.argNames, actionArgs)) as any),
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
