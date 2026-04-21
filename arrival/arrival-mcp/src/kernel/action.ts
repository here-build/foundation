import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";

import type { FieldSpec, InferProps } from "./refs";
import { fieldJsonSchema, fieldParse } from "./refs";
import type { ExactClass, MCPClientInfo, Services } from "./discovery";

/**
 * Action tool — tuple-invoked JSON dispatch. NOT installed in any Scheme env.
 *
 * Receivers come from context (typically `element`), resolved by their ref during
 * validation. Dispatch is `ctx[receiverKey].constructor === act.on` — exact-class,
 * no MRO.
 *
 * Three generics (matching discovery.ts):
 *   - BaseCtx  — per-request context the LLM supplies
 *   - Svc      — ambient services from Hono context
 *   - Prep     — prep ctx extension; defaults to Svc (services passthrough)
 *
 * Composed from ActionClusters. Each cluster is authored independently against
 * a minimum Ctx; the tool composes clusters whose MinCtx ⊆ tool's Ctx.
 */

// ─── Act declaration ────────────────────────────────────────────────────────
//
// Act is parameterized by three shapes used for type-level narrowing:
//   - Ctx  — full ctx the tool provides (tool's BaseCtx ∪ Prep ∪ {intent})
//   - N    — needs tuple; narrows Ctx by making listed keys non-optional
//   - P    — props schema; InferProps<P> types the destructured props arg
//
// Handlers get `Ctx & Required<Pick<Ctx, N[number]>>` — ctx with needed fields
// guaranteed non-undefined — plus a typed props object. No runtime casts.

type NarrowNeeds<Ctx, N extends readonly (keyof Ctx)[]> =
  Ctx & Required<Pick<Ctx, N[number]>>;

export interface Act<
  Ctx,
  N extends readonly (keyof Ctx)[] = readonly (keyof Ctx)[],
  P extends Record<string, FieldSpec<Ctx>> = Record<string, FieldSpec<Ctx>>,
> {
  name: string;
  aliases?: readonly string[];
  needs: N;
  /** Exact-class receiver match on ctx[receiverKey]. Undefined = standalone. */
  on?: ExactClass;
  /** Which ctx field supplies the receiver. Default "element" when `on` is set. */
  receiverKey?: keyof Ctx;
  desc: string;
  props?: P;
  handle(
    ctx: NarrowNeeds<Ctx, N>,
    receiver: unknown,
    props: InferProps<P>,
  ): unknown | Promise<unknown>;
}

// ─── Action builder — typed-Ctx-carrying factory ────────────────────────────

export interface ActBuilder<Ctx> {
  act<
    const N extends readonly (keyof Ctx)[],
    P extends Record<string, FieldSpec<Ctx>> = Record<string, FieldSpec<Ctx>>,
  >(
    spec: Act<Ctx, N, P>,
  ): Act<Ctx, N, P>;
}

function makeActBuilder<Ctx>(): ActBuilder<Ctx> {
  return {
    act(spec) {
      if (spec.on && !spec.receiverKey) {
        return { ...spec, receiverKey: "element" as keyof Ctx };
      }
      return spec;
    },
  };
}

// ─── ActionCluster — named group, independently typed ───────────────────────

export interface ActionCluster<Ctx> {
  readonly name: string;
  readonly description?: string;
  readonly actions: readonly Act<Ctx>[];
}

export interface ActionClusterSpec<Ctx> {
  name: string;
  description?: string;
  actions: (b: ActBuilder<Ctx>) => readonly Act<Ctx>[];
}

/**
 * A cluster is authored against a specific Ctx shape. That Ctx must be
 * compatible with (a subtype of) every tool that composes it — TS enforces
 * via standard assignment.
 */
export function defineCluster<Ctx>(
  spec: ActionClusterSpec<Ctx>,
): ActionCluster<Ctx> {
  const builder = makeActBuilder<Ctx>();
  return {
    name: spec.name,
    description: spec.description,
    actions: spec.actions(builder),
  };
}

// ─── ActionTool — value shape ───────────────────────────────────────────────

export interface ActionToolSpec<BaseCtx, Svc extends Services, Prep> {
  name: string;
  description: string;
  context: Record<string, FieldSpec<any>>;
  /**
   * Optional setup. If omitted, services pass through as prep.
   * Returns { prep, cleanup } — cleanup runs in finally regardless of success.
   */
  prepare?: (
    ctx: BaseCtx,
    svc: Svc,
  ) => Promise<{ prep: Prep; cleanup?: () => Promise<void> | void }>;
  /** Clusters whose Ctx is assignable from BaseCtx & Prep & {intent}. */
  clusters?: readonly ActionCluster<any>[];
  /** Inline actions authored directly on this tool (typed via builder callback). */
  actions?: (
    b: ActBuilder<BaseCtx & Prep & { intent: string }>,
  ) => readonly Act<BaseCtx & Prep & { intent: string }>[];
  additionalNotes?: string;
}

export interface ActionTool<BaseCtx, Svc extends Services, Prep> {
  readonly kind: "action";
  readonly name: string;
  readonly description: string;
  readonly intentRequired: true;
  readonly context: Record<string, FieldSpec<any>>;
  readonly prepare?: ActionToolSpec<BaseCtx, Svc, Prep>["prepare"];
  readonly clusters: readonly ActionCluster<any>[];
  readonly additionalNotes?: string;
  /** Add a cluster post-construction. Returns a new tool; does not mutate. */
  register(cluster: ActionCluster<any>): ActionTool<BaseCtx, Svc, Prep>;
}

export function defineActionTool<
  BaseCtx = Record<string, unknown>,
  Svc extends Services = Services,
  Prep = Svc,
>(spec: ActionToolSpec<BaseCtx, Svc, Prep>): ActionTool<BaseCtx, Svc, Prep> {
  // Inline actions become an anonymous cluster.
  const clusters: ActionCluster<any>[] = [...(spec.clusters ?? [])];
  if (spec.actions) {
    const builder = makeActBuilder<BaseCtx & Prep & { intent: string }>();
    const inlineActions = spec.actions(builder);
    if (inlineActions.length > 0) {
      clusters.push({
        name: "<inline>",
        actions: inlineActions,
      });
    }
  }
  validateClusters(clusters);
  return makeActionTool<BaseCtx, Svc, Prep>({
    name: spec.name,
    description: spec.description,
    context: spec.context,
    prepare: spec.prepare,
    clusters,
    additionalNotes: spec.additionalNotes,
  });
}

function makeActionTool<BaseCtx, Svc extends Services, Prep>(fields: {
  name: string;
  description: string;
  context: Record<string, FieldSpec<any>>;
  prepare?: ActionToolSpec<BaseCtx, Svc, Prep>["prepare"];
  clusters: ActionCluster<any>[];
  additionalNotes?: string;
}): ActionTool<BaseCtx, Svc, Prep> {
  return {
    kind: "action",
    intentRequired: true,
    name: fields.name,
    description: fields.description,
    context: fields.context,
    prepare: fields.prepare,
    clusters: fields.clusters,
    additionalNotes: fields.additionalNotes,
    register(cluster) {
      const next = [...fields.clusters, cluster];
      validateClusters(next);
      return makeActionTool<BaseCtx, Svc, Prep>({ ...fields, clusters: next });
    },
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateClusters(clusters: readonly ActionCluster<any>[]): void {
  const seen = new Map<string, string>();
  for (const cluster of clusters) {
    for (const a of cluster.actions) {
      const receiver = a.on ? a.on.name : "<standalone>";
      for (const n of [a.name, ...(a.aliases ?? [])]) {
        const key = `${n}@${receiver}`;
        const existingCluster = seen.get(key);
        if (existingCluster) {
          throw new Error(
            `action: duplicate "${n}"${a.on ? ` on ${a.on.name}` : ""} — clusters "${existingCluster}" and "${cluster.name}"`,
          );
        }
        seen.set(key, cluster.name);
      }
    }
  }
}

// ─── Compilation ────────────────────────────────────────────────────────────

export type ActionRequest = {
  intent: string;
  actions: readonly unknown[];
  contextInput: unknown;
};

export type ActionResult =
  | { success: true; results: unknown[]; intent: string }
  | {
      success: false;
      partial: true;
      executed: number;
      total: number;
      results: unknown[];
      failedAction: { index: number; name: string; error: string };
      intent: string;
    }
  | {
      success: false;
      validation: "failed";
      errors: ValidationError[];
      intent: string;
    };

export interface ValidationError {
  actionIndex?: number;
  actionName?: string;
  field?: string;
  path?: string[];
  message: string;
  received?: string;
}

export interface CompiledActionTool<Svc extends Services> {
  getToolDescription(clientInfo?: MCPClientInfo): Tool;
  dispatch(
    request: ActionRequest,
    svc: Svc,
    clientInfo?: MCPClientInfo,
  ): Promise<ActionResult>;
}

export function compileActionTool<BaseCtx, Svc extends Services, Prep>(
  tool: ActionTool<BaseCtx, Svc, Prep>,
): CompiledActionTool<Svc> {
  const byName = new Map<string, Act<any>[]>();
  for (const cluster of tool.clusters) {
    for (const a of cluster.actions) {
      for (const n of [a.name, ...(a.aliases ?? [])]) {
        const bucket = byName.get(n) ?? [];
        bucket.push(a);
        byName.set(n, bucket);
      }
    }
  }

  return {
    getToolDescription(_clientInfo) {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description:
                "Required. What you're accomplishing. Shown in the studio UI as live AI presence.",
            },
            actions: {
              type: "array",
              description: renderActionsDescription(byName, tool.additionalNotes),
              items: { oneOf: renderActionItemSchemas(byName) },
            },
            ...contextProps(tool.context),
          },
          required: ["intent", "actions"],
        },
      };
    },

    async dispatch(request, svc, _clientInfo) {
      if (!request.intent || typeof request.intent !== "string") {
        return {
          success: false,
          validation: "failed",
          intent: "",
          errors: [{ field: "intent", message: "intent is required (string)" }],
        };
      }

      // Two-phase context parsing (H2 lifecycle):
      //   1. Parse primitive fields first — these need no ctx.
      //   2. Run prepare with primitive ctx to produce prep + cleanup.
      //   3. Parse ref fields with merged (primitive ∪ prep) ctx — refs can now
      //      consult plexus/site/etc. through the ctx their resolvers need.
      //
      // Doing refs-before-prepare (the prior implementation) broke any ref
      // whose resolver needed prepared state — surfaced by e2e tests.

      const primResult = parseContextFields(tool.context, request.contextInput, {}, "primitive");
      if (!primResult.ok) {
        return {
          success: false,
          validation: "failed",
          intent: request.intent,
          errors: primResult.errors,
        };
      }

      let prep: Prep;
      let cleanup: (() => Promise<void> | void) | undefined;
      if (tool.prepare) {
        const prepared = await tool.prepare(primResult.value as BaseCtx, svc);
        prep = prepared.prep;
        cleanup = prepared.cleanup;
      } else {
        prep = svc as unknown as Prep;
      }

      try {
        const refCtxSoFar = {
          ...(primResult.value as object),
          ...(prep as object),
          intent: request.intent,
        };
        const refResult = parseContextFields(tool.context, request.contextInput, refCtxSoFar, "ref");
        if (!refResult.ok) {
          return {
            success: false,
            validation: "failed",
            intent: request.intent,
            errors: refResult.errors,
          };
        }

        const fullCtx = {
          ...(primResult.value as object),
          ...(refResult.value as object),
          ...(prep as object),
          intent: request.intent,
        } as any;

        const resolved: Array<{
          act: Act<any>;
          receiver: unknown;
          props: Record<string, unknown>;
        }> = [];
        const errors: ValidationError[] = [];

        const actions = Array.isArray(request.actions) ? request.actions : [];
        for (let i = 0; i < actions.length; i++) {
          const call = normalizeActionCall(actions[i]);
          if ("error" in call) {
            errors.push({ actionIndex: i, message: call.error });
            continue;
          }
          const bucket = byName.get(call.name);
          if (!bucket) {
            errors.push({
              actionIndex: i,
              actionName: call.name,
              message: `unknown action "${call.name}" — available: ${[...byName.keys()].join(", ")}`,
            });
            continue;
          }
          const pick = pickReceiver(bucket, fullCtx);
          if ("error" in pick) {
            errors.push({ actionIndex: i, actionName: call.name, message: pick.error });
            continue;
          }
          const missing = pick.act.needs.filter((k) => (fullCtx as any)[k] == null);
          if (missing.length > 0) {
            errors.push({
              actionIndex: i,
              actionName: call.name,
              message: `missing context: ${missing.map(String).join(", ")}`,
            });
            continue;
          }
          const propsResult = parseProps(pick.act.props ?? {}, call.props, fullCtx);
          if (!propsResult.ok) {
            for (const e of propsResult.errors) {
              errors.push({ actionIndex: i, actionName: call.name, ...e });
            }
            continue;
          }
          resolved.push({ act: pick.act, receiver: pick.receiver, props: propsResult.value });
        }

        if (errors.length > 0) {
          return { success: false, validation: "failed", intent: request.intent, errors };
        }

        const results: unknown[] = [];
        for (let i = 0; i < resolved.length; i++) {
          const { act, receiver, props } = resolved[i];
          try {
            results.push(await act.handle(fullCtx, receiver, props));
          } catch (e) {
            return {
              success: false,
              partial: true,
              intent: request.intent,
              executed: i,
              total: resolved.length,
              results,
              failedAction: {
                index: i,
                name: act.name,
                error: e instanceof Error ? e.message : String(e),
              },
            };
          }
        }

        return { success: true, intent: request.intent, results };
      } finally {
        if (cleanup) {
          try {
            await cleanup();
          } catch (e) {
            console.error(`[action] cleanup failed for ${tool.name}:`, e);
          }
        }
      }
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeActionCall(
  raw: unknown,
): { name: string; props: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `expected [name, propsObject] tuple, got ${typeOf(raw)}` };
  }
  const [name, ...rest] = raw as unknown[];
  if (typeof name !== "string") {
    return { error: `expected action name (string), got ${typeOf(name)}` };
  }
  const propsRaw = rest.length === 0 ? {} : rest[0];
  const props =
    propsRaw && typeof propsRaw === "object" && !Array.isArray(propsRaw)
      ? (propsRaw as Record<string, unknown>)
      : {};
  return { name, props };
}

function pickReceiver<Ctx>(
  bucket: Act<Ctx>[],
  ctx: Ctx,
): { act: Act<Ctx>; receiver: unknown } | { error: string } {
  for (const act of bucket) {
    if (!act.on) {
      return { act, receiver: undefined };
    }
    const receiver = (ctx as any)[act.receiverKey!];
    if (receiver == null) continue;
    if (receiver.constructor === act.on) {
      return { act, receiver };
    }
  }
  const receivers = bucket
    .filter((a) => a.on)
    .map((a) => `${String(a.receiverKey ?? "?")}: ${a.on!.name}`)
    .join(" | ");
  return { error: `no receiver match — expected ${receivers || "<none>"}` };
}

/**
 * Parse only a subset of context fields — either the primitive ones (phase 1,
 * pre-prepare) or the ref ones (phase 2, post-prepare with full ctx). Fields
 * in the "other" set are left untouched; a missing ref in phase-1 output is
 * expected and gets filled by phase-2.
 */
function parseContextFields(
  schema: Record<string, FieldSpec<any>>,
  input: unknown,
  ctx: Record<string, unknown>,
  phase: "primitive" | "ref",
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const obj =
    typeof input === "object" && input != null ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const isPrimitive = "kind" in field;
    if (phase === "primitive" && !isPrimitive) continue;
    if (phase === "ref" && isPrimitive) continue;
    const result = fieldParse(field, obj[key], ctx);
    if (result.ok) out[key] = result.value;
    else {
      for (const e of result.errors) {
        errors.push({ field: key, path: e.path, message: e.message, received: e.received });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

function parseProps<Ctx>(
  schema: Record<string, FieldSpec<Ctx>>,
  input: Record<string, unknown>,
  ctx: Ctx,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const out: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const result = fieldParse(field, input[key], ctx);
    if (result.ok) out[key] = result.value;
    else {
      for (const e of result.errors) {
        errors.push({ field: key, path: e.path, message: e.message, received: e.received });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

function contextProps(schema: Record<string, FieldSpec<any>>): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [key, field] of Object.entries(schema)) {
    out[key] = fieldJsonSchema(field);
  }
  return out;
}

function renderActionsDescription(
  byName: Map<string, Act<any>[]>,
  additionalNotes?: string,
): string {
  const lines: string[] = [];
  for (const [name, bucket] of byName.entries()) {
    const receivers = bucket.filter((a) => a.on).map((a) => a.on!.name);
    const receiverNote = receivers.length > 0 ? ` — receiver: ${receivers.join(" | ")}` : "";
    lines.push(`  ["${name}", {...props}]${receiverNote} — ${bucket[0].desc}`);
  }
  return (
    dedent`
      List of actions to execute sequentially.
      Each action is a tuple: [name, propsObject].
      Batch is stop-on-first-failure — a failing action halts the rest; prior actions persist.

      Available:
    ` +
    "\n" +
    lines.join("\n") +
    (additionalNotes ? `\n\n${dedent(additionalNotes)}` : "")
  );
}

function renderActionItemSchemas(byName: Map<string, Act<any>[]>): object[] {
  const out: object[] = [];
  for (const [name, bucket] of byName.entries()) {
    const propsSchema = propsRecordSchema(bucket[0].props ?? {});
    out.push({
      type: "array",
      items: [{ const: name }, propsSchema],
      minItems: 1,
      maxItems: 2,
      description: bucket[0].desc,
    });
  }
  return out;
}

function propsRecordSchema(props: Record<string, FieldSpec>): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(props)) {
    properties[key] = fieldJsonSchema(field);
    const optional = "kind" in field ? field.optional === true : false;
    if (!optional) required.push(key);
  }
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

function typeOf(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}
