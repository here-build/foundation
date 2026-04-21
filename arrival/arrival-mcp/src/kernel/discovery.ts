import type { Environment } from "@here.build/arrival";
import { execSerialized, SAFE_BUILTINS, sandboxedEnv } from "@here.build/arrival";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";

import type { FieldSpec, InferProps } from "./refs";
import { fieldJsonSchema, fieldParse } from "./refs";

/**
 * Discovery tool — Scheme sandbox, read-only, polymorphic by first scheme argument.
 *
 * Actions do NOT live here. This tool type only exposes fns and entity symbols into
 * a Scheme environment. Intent is optional (browsing is casual).
 *
 * Three generics:
 *   - BaseCtx — per-request context the LLM supplies (projectId, etc.)
 *   - Svc     — ambient services extracted from Hono context (api, token, etc.)
 *   - Prep    — prepared ctx extension; defaults to Svc (services passthrough)
 *
 * Tools that only need services (no heavy setup) skip `prepare`. Services
 * automatically spread into the ctx seen by fn impls. No bucket-brigade.
 */

export type ExactClass = abstract new (...args: any[]) => unknown;

// ─── Services ───────────────────────────────────────────────────────────────

export type Services = Record<string, any>;
export type MCPClientInfo = Record<string, any>;

// ─── Description ────────────────────────────────────────────────────────────

export type DiscoveryDesc = string | { dynamic: true; value: string };

// ─── DiscoveryFn — typed by Ctx (for impl) and Svc (for desc) ───────────────

export interface DiscoveryFn<
  Ctx,
  Svc extends Services = Services,
  P extends Record<string, FieldSpec<Ctx>> = Record<string, FieldSpec<Ctx>>,
> {
  name: string;
  aliases?: readonly string[];
  /** Exact-class match on first scheme argument. Undefined = standalone. */
  on?: ExactClass;
  /** Static string or dynamic closure over services (not ctx — runs at schema-gen time). */
  desc: string | ((svc: Svc) => Promise<DiscoveryDesc> | DiscoveryDesc);
  params?: P;
  impl(
    ctx: Ctx,
    receiver: unknown,
    params: InferProps<P>,
  ): unknown | Promise<unknown>;
}

export interface MethodSpec {
  alias?: string;
  aliases?: readonly string[];
  desc?: string;
}

// ─── Builder: typed-Ctx-carrying factory for fns + methodsOf ────────────────

export interface FnBuilder<Ctx, Svc extends Services> {
  fn<P extends Record<string, FieldSpec<Ctx>> = Record<string, FieldSpec<Ctx>>>(
    spec: DiscoveryFn<Ctx, Svc, P>,
  ): DiscoveryFn<Ctx, Svc, P>;
  methodsOf<C extends ExactClass>(
    cls: C,
    methods: Record<string, MethodSpec | true>,
  ): DiscoveryFn<Ctx, Svc>[];
}

function makeFnBuilder<Ctx, Svc extends Services>(): FnBuilder<Ctx, Svc> {
  return {
    fn(spec) {
      return spec;
    },
    methodsOf<C extends ExactClass>(
      cls: C,
      methods: Record<string, MethodSpec | true>,
    ): DiscoveryFn<Ctx, Svc>[] {
      const out: DiscoveryFn<Ctx, Svc>[] = [];
      for (const [key, raw] of Object.entries(methods)) {
        const entry: MethodSpec = raw === true ? {} : raw;
        out.push({
          name: entry.alias ?? key,
          aliases: entry.aliases,
          on: cls,
          desc: entry.desc ?? `${cls.name}.${key}`,
          impl: async (_ctx: Ctx, receiver: unknown) => {
            const member = (receiver as any)?.[key];
            return typeof member === "function" ? member.call(receiver) : member;
          },
        });
      }
      return out;
    },
  };
}

// ─── DiscoveryTool — value shape ────────────────────────────────────────────

export interface DiscoveryToolSpec<
  BaseCtx,
  Svc extends Services,
  Prep,
> {
  name: string;
  description: string;
  /** Per-request context primitives. Keys are validated via FieldSpec. */
  context: Record<string, FieldSpec<any>>;
  /**
   * Optional setup phase. If omitted, services are passed through as prep
   * (no boilerplate needed for tools that just want services in ctx).
   */
  prepare?: (ctx: BaseCtx, svc: Svc) => Prep | Promise<Prep>;
  /** Fn declarations — callback receives typed builder to avoid per-fn generics. */
  fns: (b: FnBuilder<BaseCtx & Prep, Svc>) => readonly DiscoveryFn<BaseCtx & Prep, Svc>[];
  /** Bindings injected into scheme sandbox under `entities.<name>` (H7 Option B). */
  symbols?: (ctx: BaseCtx & Prep) => Record<string, unknown>;
  personalize?: (clientInfo: MCPClientInfo | undefined) => string;
}

export interface DiscoveryTool<BaseCtx, Svc extends Services, Prep> {
  readonly kind: "discovery";
  readonly name: string;
  readonly description: string;
  readonly context: Record<string, FieldSpec<any>>;
  readonly prepare?: (ctx: BaseCtx, svc: Svc) => Prep | Promise<Prep>;
  readonly fns: readonly DiscoveryFn<BaseCtx & Prep, Svc>[];
  readonly symbols?: (ctx: BaseCtx & Prep) => Record<string, unknown>;
  readonly personalize?: (clientInfo: MCPClientInfo | undefined) => string;
}

export function defineDiscoveryTool<
  BaseCtx = Record<string, unknown>,
  Svc extends Services = Services,
  Prep = Svc,
>(spec: DiscoveryToolSpec<BaseCtx, Svc, Prep>): DiscoveryTool<BaseCtx, Svc, Prep> {
  const builder = makeFnBuilder<BaseCtx & Prep, Svc>();
  const fns = spec.fns(builder);
  validateFns(fns);
  return {
    kind: "discovery",
    name: spec.name,
    description: spec.description,
    context: spec.context,
    prepare: spec.prepare,
    fns,
    symbols: spec.symbols,
    personalize: spec.personalize,
  };
}

// ─── Validation: duplicate name+receiver ────────────────────────────────────

function validateFns<Ctx, Svc extends Services>(
  fns: readonly DiscoveryFn<Ctx, Svc>[],
): void {
  const seen = new Set<string>();
  for (const f of fns) {
    for (const n of [f.name, ...(f.aliases ?? [])]) {
      const key = f.on ? `${n}@${f.on.name}` : `${n}@<standalone>`;
      if (seen.has(key)) {
        throw new Error(
          `discovery: duplicate fn "${n}"${f.on ? ` on ${f.on.name}` : ""}`,
        );
      }
      seen.add(key);
    }
  }
}

// ─── Compilation ────────────────────────────────────────────────────────────

export interface CompiledDiscoveryTool<BaseCtx, Svc extends Services, Prep> {
  getToolDescription(clientInfo: MCPClientInfo | undefined, svc?: Svc): Promise<Tool>;
  execute(
    request: {
      contextInput: unknown;
      expr: string;
      history?: readonly string[];
    },
    svc: Svc,
    clientInfo?: MCPClientInfo,
  ): Promise<{ result: unknown; replay: string }>;
}

export function compileDiscoveryTool<BaseCtx, Svc extends Services, Prep>(
  tool: DiscoveryTool<BaseCtx, Svc, Prep>,
): CompiledDiscoveryTool<BaseCtx, Svc, Prep> {
  return {
    async getToolDescription(clientInfo, svc) {
      const aiName = tool.personalize?.(clientInfo) ?? "";
      const signatures = await renderSignatures(tool.fns, svc);
      const anyDynamic = signatures.some((s) => s.dynamic);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description: "What you're exploring and why. Shown to collaborators in the studio UI.",
            },
            expr: {
              type: "string",
              description: renderExprDescription(signatures, anyDynamic, aiName),
            },
            ...contextProps(tool.context),
          },
          required: ["expr"],
        },
        annotations: { readOnlyHint: true },
      };
    },

    async execute(request, svc, _clientInfo) {
      // Two-phase parse (see action.ts for rationale): primitives → prepare → refs.
      const primCtx = await parseContextFields(tool.context, request.contextInput, {}, "primitive");
      const prep = tool.prepare
        ? await tool.prepare(primCtx as BaseCtx, svc)
        : (svc as unknown as Prep);
      const refCtxSoFar = { ...(primCtx as object), ...(prep as object) };
      const refCtx = await parseContextFields(tool.context, request.contextInput, refCtxSoFar, "ref");
      const fullCtx = { ...(primCtx as object), ...(refCtx as object), ...(prep as object) } as BaseCtx & Prep;

      const env = await buildEnvironment(tool, fullCtx);
      const history = request.history ?? [];
      if (history.length > 0) {
        await execSerialized(history.join("\n"), { env });
      }
      const result = await execSerialized(request.expr, { env });
      return { result, replay: request.expr };
    },
  };
}

// ─── Scheme environment construction ────────────────────────────────────────

async function buildEnvironment<BaseCtx, Svc extends Services, Prep>(
  tool: DiscoveryTool<BaseCtx, Svc, Prep>,
  ctx: BaseCtx & Prep,
): Promise<Environment> {
  const env = sandboxedEnv.inherit(`Discovery: ${tool.name}`, {});

  // H7 Option B: symbols under `entities` namespace — no bare-name shadowing.
  if (tool.symbols) {
    const entities = tool.symbols(ctx);
    env.set("entities", entities);
  }

  const byName = new Map<string, DiscoveryFn<BaseCtx & Prep, Svc>[]>();
  for (const f of tool.fns) {
    for (const n of [f.name, ...(f.aliases ?? [])]) {
      const bucket = byName.get(n) ?? [];
      bucket.push(f);
      byName.set(n, bucket);
    }
  }

  for (const [name, bucket] of byName.entries()) {
    env.defineRosetta(name, {
      fn: async (...args: unknown[]) => dispatch(bucket, args, ctx),
    });
  }

  return env;
}

async function dispatch<Ctx, Svc extends Services>(
  bucket: DiscoveryFn<Ctx, Svc>[],
  args: unknown[],
  ctx: Ctx,
): Promise<unknown> {
  const standalone = bucket.find((f) => !f.on);

  if (args.length === 0 && standalone) {
    const params = standalone.params ? await parseParams(standalone.params, [], ctx) : {};
    return standalone.impl(ctx, undefined, params);
  }

  const first = args[0];
  for (const f of bucket) {
    if (!f.on) continue;
    // Exact-class match, not instanceof.
    if (first != null && (first as any).constructor === f.on) {
      const params = f.params ? await parseParams(f.params, args.slice(1), ctx) : {};
      return f.impl(ctx, first, params);
    }
  }

  if (standalone) {
    const params = standalone.params ? await parseParams(standalone.params, args, ctx) : {};
    return standalone.impl(ctx, undefined, params);
  }

  const expected = bucket
    .filter((f) => f.on)
    .map((f) => f.on!.name)
    .join(" | ");
  throw new Error(
    `${bucket[0]?.name}: no receiver match (expected ${expected}, got ${describeRuntime(first)})`,
  );
}

async function parseParams<Ctx>(
  params: Record<string, FieldSpec<Ctx>>,
  args: unknown[],
  ctx: Ctx,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(params);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [key, field] = entries[i];
    const result = fieldParse(field, args[i], ctx);
    if (result.ok) out[key] = result.value;
    else errors.push(`${key}: ${result.errors.map((e) => e.message).join(", ")}`);
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return out;
}

/**
 * Parse only one phase's worth of context fields (primitives pre-prepare,
 * refs post-prepare). Matches action.ts's parseContextFields in spirit.
 */
async function parseContextFields(
  schema: Record<string, FieldSpec<any>>,
  input: unknown,
  ctx: Record<string, unknown>,
  phase: "primitive" | "ref",
): Promise<Record<string, unknown>> {
  const obj =
    typeof input === "object" && input != null
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const isPrimitive = "kind" in field;
    if (phase === "primitive" && !isPrimitive) continue;
    if (phase === "ref" && isPrimitive) continue;
    const result = fieldParse(field, obj[key], ctx);
    if (result.ok) out[key] = result.value;
    else errors.push(`${key}: ${result.errors.map((e) => e.message).join(", ")}`);
  }
  if (errors.length > 0) throw new Error(`context: ${errors.join("; ")}`);
  return out;
}

function contextProps(schema: Record<string, FieldSpec<any>>): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [key, field] of Object.entries(schema)) {
    out[key] = fieldJsonSchema(field);
  }
  return out;
}

// ─── Signature rendering ────────────────────────────────────────────────────

interface RenderedSignature {
  line: string;
  dynamic: boolean;
}

async function renderSignatures<Ctx, Svc extends Services>(
  fns: readonly DiscoveryFn<Ctx, Svc>[],
  svc: Svc | undefined,
): Promise<RenderedSignature[]> {
  const primaries = new Map<string, DiscoveryFn<Ctx, Svc>[]>();
  for (const f of fns) {
    const bucket = primaries.get(f.name) ?? [];
    bucket.push(f);
    primaries.set(f.name, bucket);
  }
  const out: RenderedSignature[] = [];
  for (const [name, bucket] of primaries.entries()) {
    out.push(await renderFnGroup(name, bucket, svc));
  }
  return out;
}

async function renderFnGroup<Ctx, Svc extends Services>(
  name: string,
  bucket: DiscoveryFn<Ctx, Svc>[],
  svc: Svc | undefined,
): Promise<RenderedSignature> {
  const lines: string[] = [];
  let dynamic = false;
  for (const f of bucket) {
    const descResolved =
      typeof f.desc === "function"
        ? svc
          ? await f.desc(svc)
          : `${f.name}`
        : f.desc;
    if (typeof descResolved === "object" && descResolved.dynamic) dynamic = true;
    const descText = typeof descResolved === "object" ? descResolved.value : descResolved;
    const receiverStr = f.on ? `${f.on.name} ` : "";
    const paramsStr = f.params ? renderParams(f.params) : "";
    lines.push(
      `(${name}${receiverStr ? ` ${receiverStr.trim()}` : ""}${paramsStr ? ` ${paramsStr}` : ""}) — ${descText}`,
    );
  }
  return { line: lines.join("\n"), dynamic };
}

function renderParams(params: Record<string, FieldSpec>): string {
  return Object.entries(params)
    .map(([_key, field]) => {
      if ("kind" in field) {
        const opt = field.optional ? "?" : "";
        return `${field.kind}${opt}${field.desc ? ` (${field.desc})` : ""}`;
      }
      return `${field.typeName}${field.desc ? ` (${field.desc})` : ""}`;
    })
    .join(" ");
}

function renderExprDescription(
  signatures: readonly RenderedSignature[],
  dynamic: boolean,
  aiName: string,
): string {
  const base = dedent`
    Expr is an input for Scheme (Lisp dialect) REPL that will be executed in sandboxed environment.
    This sandbox is providing access to the actual system state snapshot at the moment of request.
    You can do anything you want — data transformations, lenses, views of any complexity.
    Sandbox provides following standard symbols:
    ${SAFE_BUILTINS}

    Batch queries supported — put multiple top-level expressions, one per line.
    Use Fantasy Land combinators (fmap, chain, filter, compose) for compositional queries.

    Domain-specific functions available in sandbox:
    ${signatures.map((s) => s.line).join("\n")}

    Entity bindings available under \`entities.<name>\` (UUIDs, component names).
  `;
  if (!dynamic) return base;
  return `${base}\n\nNOTE${aiName ? ` FOR ${aiName.toUpperCase()}` : ""} ON LIVE DESCRIPTION:
The data above IS NOT STATIC. Some descriptions are generated at session start with personalized state.`;
}

function describeRuntime(value: unknown): string {
  if (value == null) return String(value);
  return Object.getPrototypeOf(value)?.constructor?.name ?? typeof value;
}
