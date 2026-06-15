// ActionTool — the mutation tier as a VALUE, not a subclass. The sibling of DiscoveryTool: where that
// runs a Scheme REPL over a capability, this dispatches a BATCH of tuple-invoked, typed actions
// (`["place-node", {position, target}]`) sharing one context scope, with rollback-report on failure.
//
// `new ActionTool(name, { description, context, clusters?, actions?, prepare?, ... })`. Actions are
// declared as `FieldSpec`-typed `Act`s — props are a NAMED object (not positional) and a context field
// may be a `Ref` that resolves a UUID/name/instance against the live ctx (a Component UUID → the live
// `Component` off the plexus). That ctx-aware resolution is why props/context are `FieldSpec`, not bare
// zod (a zod `.transform` can't see the runtime ctx). One action NAME may dispatch to different handlers
// by RECEIVER class (`on`/`receiverKey`, exact-class) — e.g. `set-style` on a TplTag vs a TplComponent.
//
// The context is twice load-bearing: it's the AWARENESS wiring (actions reference shared fields by name;
// handlers get them typed via `needs`) AND the token saver — the shared scope is declared ONCE at the
// top and validated/resolved ONCE per batch, so N actions don't re-declare projectId/component/element.
// That is the "all actions in a batch share exactly the same context scope" constraint.
//
// (This absorbed the interim `kernel.defineActionTool`: FieldSpec/refs, receiver-dispatch, clusters,
// prepare/beforeDispatch/shapeResponse, and per-phase timeouts/limits are now first-class here. The
// only departure from the old kernel is the value shape — `new ActionTool(…)` + `describe()`/`call()`
// (the `McpTool` contract) instead of `defineActionTool(…)` + `compile()`.)

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";

import type { InteractionLog, ToolCallCtx } from "./DiscoveryTool.js";
import { checkSizeLimit, classifyError, DEFAULT_SIZE_LIMITS, type SizeLimits, withTimeout } from "./errors.js";
import { type FieldSpec, fieldJsonSchema, fieldParse, type InferProps } from "./refs.js";

/** A class usable as an exact-class receiver match (`ctx[receiverKey].constructor === on`). */
export type ExactClass = abstract new (...args: any[]) => object;

// ─── Act declaration ────────────────────────────────────────────────────────
//
// Act is parameterized by three shapes used for type-level narrowing:
//   - Ctx — full ctx the tool provides (tool's BaseCtx ∪ Prep ∪ {intent})
//   - N   — needs tuple; narrows Ctx by making listed keys non-optional
//   - P   — props schema; InferProps<P> types the destructured props arg
//
// Handlers get `Ctx & Required<Pick<Ctx, N[number]>>` — ctx with needed fields guaranteed
// non-undefined — plus a typed props object and the resolved receiver. No runtime casts.

type NarrowNeeds<Ctx, N extends readonly (keyof Ctx)[]> = Ctx & Required<Pick<Ctx, N[number]>>;

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
  handle(ctx: NarrowNeeds<Ctx, N>, receiver: unknown, props: InferProps<P>): unknown | Promise<unknown>;
}

// ─── Action builder — typed-Ctx-carrying factory ────────────────────────────

export interface ActBuilder<Ctx> {
  act<const N extends readonly (keyof Ctx)[], P extends Record<string, FieldSpec<Ctx>> = Record<string, FieldSpec<Ctx>>>(
    spec: Act<Ctx, N, P>,
  ): Act<Ctx, N, P>;
}

function makeActBuilder<Ctx>(): ActBuilder<Ctx> {
  return {
    act(spec) {
      if (spec.on && !spec.receiverKey) return { ...spec, receiverKey: "element" as keyof Ctx };
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

/** A cluster is authored against a specific Ctx shape; that Ctx must be a supertype of every tool's
 *  full ctx that composes it (TS enforces via standard assignment at the `clusters:` site). */
export function defineCluster<Ctx>(spec: ActionClusterSpec<Ctx>): ActionCluster<Ctx> {
  return { name: spec.name, description: spec.description, actions: spec.actions(makeActBuilder<Ctx>()) };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ActionToolOptions<BaseCtx, Prep> {
  description: string;
  /** The shared context scope — validated + resolved ONCE per batch. Doubles as the awareness wiring
   *  (actions reference these by name) and the token saver (declared once, not per action). A field may
   *  be a `Ref` whose resolver consults the post-prepare ctx (plexus/site). */
  context: Record<string, FieldSpec<any>>;
  /** Clusters whose Ctx is a supertype of `BaseCtx & Prep & {intent}`. */
  clusters?: readonly ActionCluster<any>[];
  /** Inline actions authored directly on this tool (typed via the builder callback). */
  actions?: (b: ActBuilder<BaseCtx & Prep & { intent: string }>) => readonly Act<BaseCtx & Prep & { intent: string }>[];
  /** Appended to the `actions` field description (e.g. domain notes). */
  additionalNotes?: string;
  /**
   * Optional setup, run after the PRIMITIVE context fields parse, before ref fields resolve. Returns
   * `{ prep, cleanup? }` — `prep` merges into the ctx every handler (and every ref resolver) sees, and
   * `cleanup` runs in `finally` regardless of success. Closes over the host's infra (the tool factory
   * is armed per connection with its `api`), so there is NO separate services injection.
   */
  prepare?: (ctx: BaseCtx) => Promise<{ prep: Prep; cleanup?: () => void | Promise<void> }>;
  /**
   * Runs after refs resolve, before handler dispatch. Use for ctx normalization (auto-defaulting a
   * field, e.g. element → component.tplTree) or materializing ephemeral entities. May mutate ctx.
   */
  beforeDispatch?: (ctx: BaseCtx & Prep & { intent: string }) => void | Promise<void>;
  /**
   * Wraps the batch run (after validation, before the result is shaped) to make the whole burst ATOMIC.
   * The canonical CRDT case: pause the project's sync for the burst so each mutation isn't a round-trip,
   * run the actions, then bring sync back online and AWAIT one flush — N edits land as one synced commit
   * (the transactional analogue is a `plexus.transact`). MUST invoke `runBatch()` and return its results.
   * A handler failure inside `runBatch` throws THROUGH the wrap — so a `finally` brings sync back online
   * even on failure — and is reported as a partial batch; a failure in the wrap itself (e.g. the flush)
   * is a diagnosable `<batch>` error, not a raw throw.
   */
  wrapBatch?: (
    ctx: BaseCtx & Prep & { intent: string },
    runBatch: () => Promise<unknown[]>,
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  /**
   * Customizes the success-response shape. Receives the final ctx + handler results. Default:
   * `{ results }` under the outer `{ success, intent }` envelope.
   */
  shapeResponse?: (ctx: BaseCtx & Prep & { intent: string }, results: unknown[]) => Record<string, unknown>;
  /** Per-phase deadlines (ms). prepare 5000, handler 30000, batch 60000 by default. */
  timeouts?: { prepare?: number; handler?: number; batch?: number };
  /** Size limits. Omitted → {@link DEFAULT_SIZE_LIMITS}. */
  limits?: SizeLimits;
}

const DEFAULT_TIMEOUTS = { prepare: 5000, handler: 30_000, batch: 60_000 } as const;

// ─── Result ───────────────────────────────────────────────────────────────────

export interface ValidationError {
  actionIndex?: number;
  actionName?: string;
  field?: string;
  path?: string[];
  message: string;
  received?: string;
}

export type ActionResult =
  | ({ success: true; intent: string } & ({ results: unknown[] } | Record<string, unknown>))
  | {
      success: false;
      partial: true;
      executed: number;
      total: number;
      results: unknown[];
      failedAction: { index: number; name: string; error: string };
      intent: string;
    }
  | { success: false; validation: "failed"; errors: ValidationError[]; intent: string };

/** Internal marker: a handler threw inside the batch. Thrown THROUGH `wrapBatch` so the wrap's finally
 *  (e.g. bring CRDT sync back online) still runs, then caught and reported as a partial. */
class BatchFailureError extends Error {
  readonly executed: number;
  constructor(
    readonly actionIndex: number,
    readonly actionName: string,
    readonly errorMessage: string,
    readonly priorResults: unknown[],
    readonly total: number,
  ) {
    super(errorMessage);
    this.executed = priorResults.length;
  }
}

type ActionArgs = { actions?: unknown; intent?: string } & Record<string, unknown>;

/** A mutation tool over a batch of typed, receiver-dispatched actions. Construct once per CONNECTION
 *  (the factory arms `prepare` with the host's infra); `call` runs one batch per request. Structurally
 *  an `McpTool` (name/describe/call), so it registers on the official server beside DiscoveryTool. */
export class ActionTool<BaseCtx = Record<string, unknown>, Prep = Record<string, unknown>> {
  private readonly clusters: readonly ActionCluster<any>[];
  /** name (and alias) → the receiver-overload bucket, built once. */
  private readonly byName: Map<string, Act<any>[]>;

  constructor(
    readonly name: string,
    private readonly options: ActionToolOptions<BaseCtx, Prep>,
  ) {
    const clusters: ActionCluster<any>[] = [...(options.clusters ?? [])];
    if (options.actions) {
      const inline = options.actions(makeActBuilder<BaseCtx & Prep & { intent: string }>());
      if (inline.length > 0) clusters.push({ name: "<inline>", actions: inline });
    }
    validateClusters(clusters);
    this.clusters = clusters;
    this.byName = new Map();
    for (const cluster of clusters) {
      for (const a of cluster.actions) {
        for (const n of [a.name, ...(a.aliases ?? [])]) {
          const bucket = this.byName.get(n) ?? [];
          bucket.push(a);
          this.byName.set(n, bucket);
        }
      }
    }
  }

  /** The MCP `Tool` definition — the actions oneOf + the shared context fields, declared once. */
  async describe(_clientInfo?: Record<string, unknown>): Promise<Tool> {
    return {
      name: this.name,
      description: this.options.description,
      inputSchema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Required. What you're accomplishing. Shown in the studio UI as live AI presence.",
          },
          actions: {
            type: "array",
            description: renderActionsDescription(this.byName, this.options.additionalNotes),
            items: { oneOf: renderActionItemSchemas(this.byName) },
          },
          ...contextProps(this.options.context),
        },
        required: ["intent", "actions"],
      },
    };
  }

  /** Validate the shared context (two-phase: primitives → prepare → refs), resolve every action's
   *  receiver + props, then run the batch with rollback-report on the first runtime failure. Returns a
   *  validation-error object, the shaped success, or a partial-failure report — the transport serializes
   *  it. `cleanup` (from prepare) always runs in `finally`. */
  async call(args: ActionArgs, ctx: ToolCallCtx = {}): Promise<ActionResult> {
    const startTime = Date.now();
    const intent = typeof args.intent === "string" ? args.intent : "";
    const { actions: rawActions, intent: _i, ...contextInput } = args;
    const result = await this.dispatch(intent, Array.isArray(rawActions) ? rawActions : [], contextInput, ctx);
    this.log(ctx, args, startTime, result.success ? { success: true } : { success: false });
    return result;
  }

  private async dispatch(
    intent: string,
    actions: readonly unknown[],
    contextInput: Record<string, unknown>,
    ctx: ToolCallCtx,
  ): Promise<ActionResult> {
    const timeouts = { ...DEFAULT_TIMEOUTS, ...this.options.timeouts };
    const limits = { ...DEFAULT_SIZE_LIMITS, ...this.options.limits };

    if (!intent) {
      return { success: false, validation: "failed", intent: "", errors: [{ field: "intent", message: "intent is required (string)" }] };
    }

    // Size gate before any work.
    try {
      checkSizeLimit(actions.length, limits.maxActions, "batch action count");
    } catch (error) {
      return { success: false, validation: "failed", intent, errors: [{ field: "actions", message: classifyError(error).message }] };
    }

    // Phase 1: primitive context fields (need no ctx).
    const primResult = parseContextFields(this.options.context, contextInput, {}, "primitive");
    if (!primResult.ok) return { success: false, validation: "failed", intent, errors: primResult.errors };

    // Phase 2: prepare — produce prep + cleanup from the primitive ctx (closes over host infra).
    let prep: Prep;
    let cleanup: (() => void | Promise<void>) | undefined;
    if (this.options.prepare) {
      try {
        const prepared = await withTimeout(() => this.options.prepare!(primResult.value as BaseCtx), timeouts.prepare, "prepare", this.name);
        prep = prepared.prep;
        cleanup = prepared.cleanup;
      } catch (error) {
        return { success: false, validation: "failed", intent, errors: [{ field: "<prepare>", message: classifyError(error, "prepare").message }] };
      }
    } else {
      prep = {} as Prep;
    }

    try {
      // Phase 3: ref context fields — resolvers now see prim ∪ prep ∪ {intent}.
      const refCtxSoFar = { ...(primResult.value as object), ...(prep as object), intent };
      const refResult = parseContextFields(this.options.context, contextInput, refCtxSoFar, "ref");
      if (!refResult.ok) return { success: false, validation: "failed", intent, errors: refResult.errors };

      const fullCtx = {
        ...(primResult.value as object),
        ...(refResult.value as object),
        ...(prep as object),
        intent,
      } as BaseCtx & Prep & { intent: string };

      // Resolve each call: receiver pick → needs check → props parse.
      const resolved: Array<{ act: Act<any>; receiver: unknown; props: Record<string, unknown> }> = [];
      const errors: ValidationError[] = [];
      for (const [i, action] of actions.entries()) {
        const call = normalizeActionCall(action);
        if ("error" in call) {
          errors.push({ actionIndex: i, message: call.error });
          continue;
        }
        const bucket = this.byName.get(call.name);
        if (!bucket) {
          errors.push({ actionIndex: i, actionName: call.name, message: `unknown action "${call.name}" — available: ${[...this.byName.keys()].join(", ")}` });
          continue;
        }
        const pick = pickReceiver(bucket, fullCtx as Record<string, unknown>);
        if ("error" in pick) {
          errors.push({ actionIndex: i, actionName: call.name, message: pick.error });
          continue;
        }
        const missing = pick.act.needs.filter((k) => (fullCtx as Record<string, unknown>)[k as string] == null);
        if (missing.length > 0) {
          errors.push({ actionIndex: i, actionName: call.name, message: `missing context: ${missing.map(String).join(", ")}` });
          continue;
        }
        const propsResult = parseProps(pick.act.props ?? {}, call.props, fullCtx, limits.maxStringFieldSize);
        if (!propsResult.ok) {
          for (const e of propsResult.errors) errors.push({ actionIndex: i, actionName: call.name, ...e });
          continue;
        }
        resolved.push({ act: pick.act, receiver: pick.receiver, props: propsResult.value });
      }
      if (errors.length > 0) return { success: false, validation: "failed", intent, errors };

      if (this.options.beforeDispatch) await this.options.beforeDispatch(fullCtx);

      // Run the batch sequentially; rollback-report on the first runtime failure. The signal cancels
      // BETWEEN actions. An optional `wrapBatch` makes the whole burst atomic; a handler failure throws
      // THROUGH it as a `BatchFailureError`, so the wrap's finally still runs.
      const runBatch = async (): Promise<unknown[]> => {
        const results: unknown[] = [];
        for (let i = 0; i < resolved.length; i++) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("aborted", "AbortError");
          const { act, receiver, props } = resolved[i]!;
          try {
            results.push(await withTimeout(() => Promise.resolve(act.handle(fullCtx, receiver, props)), timeouts.handler, "handler", act.name));
          } catch (error) {
            throw new BatchFailureError(i, act.name, error instanceof Error ? error.message : String(error), results, resolved.length);
          }
        }
        return results;
      };

      let rawResults: unknown[];
      try {
        rawResults = await withTimeout(
          () => (this.options.wrapBatch ? this.options.wrapBatch(fullCtx, runBatch, ctx.signal) : runBatch()),
          timeouts.batch,
          "dispatch",
          this.name,
        );
      } catch (error) {
        if (error instanceof BatchFailureError) {
          return {
            success: false,
            partial: true,
            intent,
            executed: error.executed,
            total: error.total,
            results: error.priorResults,
            failedAction: { index: error.actionIndex, name: error.actionName, error: error.errorMessage },
          };
        }
        if (ctx.signal?.aborted) throw error; // cancellation propagates — not a batch report
        // Timeout or wrap-level failure (e.g. the CRDT flush) — diagnosable `<batch>` error, not a raw throw.
        return {
          success: false,
          partial: true,
          intent,
          executed: 0,
          total: resolved.length,
          results: [],
          failedAction: { index: -1, name: "<batch>", error: classifyError(error).message },
        };
      }

      if (this.options.shapeResponse) {
        return { success: true, intent, ...this.options.shapeResponse(fullCtx, rawResults) };
      }
      return { success: true, intent, results: rawResults };
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (error) {
          console.error(`[action] cleanup failed for ${this.name}:`, error);
        }
      }
    }
  }

  private log(ctx: ToolCallCtx, args: ActionArgs, startTime: number, outcome: { success: boolean }) {
    const { actions: _a, intent, ...rest } = args;
    ctx.record?.({
      sessionId: ctx.session?.id ?? "unknown",
      userSub: ctx.user?.sub,
      tool: this.name,
      intent: typeof intent === "string" ? intent : undefined,
      arguments: rest,
      durationMs: Date.now() - startTime,
      ...outcome,
    } satisfies InteractionLog);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateClusters(clusters: readonly ActionCluster<any>[]): void {
  const seen = new Map<string, string>();
  for (const cluster of clusters) {
    for (const a of cluster.actions) {
      const receiver = a.on ? a.on.name : "<standalone>";
      for (const n of [a.name, ...(a.aliases ?? [])]) {
        const key = `${n}@${receiver}`;
        const existing = seen.get(key);
        if (existing) throw new Error(`action: duplicate "${n}"${a.on ? ` on ${a.on.name}` : ""} — clusters "${existing}" and "${cluster.name}"`);
        seen.set(key, cluster.name);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeActionCall(raw: unknown): { name: string; props: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: `expected [name, propsObject] tuple, got ${typeOf(raw)}` };
  const [name, ...rest] = raw;
  if (typeof name !== "string") return { error: `expected action name (string), got ${typeOf(name)}` };
  const propsRaw = rest.length === 0 ? {} : rest[0];
  const props = propsRaw && typeof propsRaw === "object" && !Array.isArray(propsRaw) ? (propsRaw as Record<string, unknown>) : {};
  return { name, props };
}

function pickReceiver(bucket: Act<any>[], ctx: Record<string, unknown>): { act: Act<any>; receiver: unknown } | { error: string } {
  for (const act of bucket) {
    if (!act.on) return { act, receiver: undefined };
    const receiver = ctx[act.receiverKey as string];
    if (receiver == null) continue;
    if ((receiver as object).constructor === act.on) return { act, receiver };
  }
  const receivers = bucket.filter((a) => a.on).map((a) => `${String(a.receiverKey ?? "?")}: ${a.on!.name}`).join(" | ");
  return { error: `no receiver match — expected ${receivers || "<none>"}` };
}

/** Parse a subset of context fields: primitives (phase 1, pre-prepare) or refs (phase 3, post-prepare
 *  with full ctx). Fields in the "other" set are left untouched. */
function parseContextFields(
  schema: Record<string, FieldSpec<any>>,
  input: unknown,
  ctx: Record<string, unknown>,
  phase: "primitive" | "ref",
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const obj = typeof input === "object" && input != null ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const isPrimitive = "kind" in field;
    if (phase === "primitive" && !isPrimitive) continue;
    if (phase === "ref" && isPrimitive) continue;
    const result = fieldParse(field, obj[key], ctx);
    if (result.ok) out[key] = result.value;
    else for (const e of result.errors) errors.push({ field: key, path: e.path, message: e.message, received: e.received });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

function parseProps<Ctx>(
  schema: Record<string, FieldSpec<Ctx>>,
  input: Record<string, unknown>,
  ctx: Ctx,
  maxStringSize?: number,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const out: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const result = fieldParse(field, input[key], ctx);
    if (result.ok) {
      if (maxStringSize != null && typeof result.value === "string" && result.value.length > maxStringSize) {
        errors.push({ field: key, message: `string field "${key}" exceeded ${maxStringSize} chars: ${result.value.length}` });
        continue;
      }
      out[key] = result.value;
    } else {
      for (const e of result.errors) errors.push({ field: key, path: e.path, message: e.message, received: e.received });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

function contextProps(schema: Record<string, FieldSpec<any>>): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [key, field] of Object.entries(schema)) out[key] = fieldJsonSchema(field);
  return out;
}

function renderActionsDescription(byName: Map<string, Act<any>[]>, additionalNotes?: string): string {
  const lines: string[] = [];
  for (const [name, bucket] of byName.entries()) {
    const receivers = bucket.filter((a) => a.on).map((a) => a.on!.name);
    const receiverNote = receivers.length > 0 ? ` — receiver: ${receivers.join(" | ")}` : "";
    lines.push(`  ["${name}", {...props}]${receiverNote} — ${bucket[0]!.desc}`);
  }
  return `${dedent`
      List of actions to execute sequentially.
      Each action is a tuple: [name, propsObject].
      Batch is stop-on-first-failure — a failing action halts the rest; prior actions persist.

      Available:
    `}\n${lines.join("\n")}${additionalNotes ? `\n\n${dedent(additionalNotes)}` : ""}`;
}

function renderActionItemSchemas(byName: Map<string, Act<any>[]>): object[] {
  const out: object[] = [];
  for (const [name, bucket] of byName.entries()) {
    out.push({
      type: "array",
      // draft 2020-12 tuple keyword (the Anthropic tool-use API rejects the draft-07 `items`-array).
      prefixItems: [{ const: name }, propsRecordSchema(bucket[0]!.props ?? {})],
      minItems: 1,
      maxItems: 2,
      description: bucket[0]!.desc,
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
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

function typeOf(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}
