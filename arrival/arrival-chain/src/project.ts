import "@here.build/plexus/mobx/register";
import {
  createRosettaWrapper,
  execGeneratorFromString as exec,
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  sandboxedEnv,
  lipsToJs,
  Nil,
} from "@here.build/arrival-scheme";
import { docPlexus, PlexusModel, syncing } from "@here.build/plexus";
import Handlebars from "handlebars";
import invariant from "tiny-invariant";

import type { InferenceCache } from "./cache.js";
import { Draft } from "./draft.js";
import { Program, ProgramVersion } from "./program.js";
import { formatRunError, Hypothesis, Run, RunError, RunResult } from "./run.js";
import {
  defineImportRosetta,
  defineRequireRosetta,
  loaderFromResolver,
  makeProjectLoader,
  type Loader,
  type PromptUnit,
  type RequireResolver,
} from "./loader.js";
import { analyzeTemplate, coerceShape, type TemplateInfo, validateShape } from "./template-analyze.js";
import type { EvalTrace } from "./trace.js";

// The brand arrival-scheme tags keyword-accessor pluck functions with (see
// Environment.ts). Read via the same registered symbol so it matches across the
// package boundary — an explicit check, not a valueOf/string-shape heuristic.
const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

/**
 * Resolve a `dict` key. A keyword key (e.g. `:tagline`) evaluates to a branded
 * pluck function carrying its bare field name; use that so `(dict :tagline v)`
 * is symmetric with `(:tagline obj)` access (and templates `{{tagline}}` still
 * resolve). Plain string keys pass through unchanged.
 */
function dictKey(k: unknown): string {
  if (typeof k === "function") {
    const field = (k as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(k);
}

/** Fold alternating key/value call args into a dict — the `dict` rosetta body,
 *  reused by the `.prompt` proc to build its `:k v …` kwargs dict at JS level
 *  (so `(run-x key :k v)` folds exactly as the old `(apply dict kv)` did). */
function buildDict(args: unknown[]): Record<string, unknown> {
  invariant(args.length % 2 === 0, "dict: needs an even number of args (alternating keys/values)");
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) out[dictKey(args[i])] = args[i + 1];
  return out;
}

/** Canonicalise a `(role content)` message list to the single prompt string used
 *  as a task's content key (the cache/dedup identity). Shared by `infer/chat` and
 *  the `.prompt` proc, so both mint IDENTICAL task keys for the same messages —
 *  the property that keeps a `.prompt` run replayable against the same cache. */
function canonicalizeMessages(messages: unknown): string {
  invariant(Array.isArray(messages), "infer/chat: messages must be a list");
  return JSON.stringify(
    messages.map((m) => {
      invariant(Array.isArray(m) && m.length === 2, "infer/chat: each message must be (role content)");
      return { role: String(m[0]), content: String(m[1]) };
    }),
  );
}

/**
 * Execution circuit-breaker, threaded into `exec`/`execExpr` and checked at the
 * evaluator's TICK boundary (≈ every 1000 iterations or 5ms). It bounds runaway
 * recursion AND runaway macro expansion alike (the expander rides the same TICK)
 * — which is what makes enabling user `syntax-rules` safe: a macro adds no new
 * threat class beyond the infinite recursion any program could already write,
 * and the same breaker caps both.
 *
 * The two fields are NOT interchangeable:
 *   budgetMs — a SYNCHRONOUS wall-clock deadline (`performance.now() > deadline`)
 *              checked at the TICK. Because it needs no event loop, it cuts even a
 *              pure-CPU runaway (tight loop, expansion bomb) when the loop never
 *              breathes. THIS is the breaker for runaway CPU. Opt-in: the deadline
 *              counts IO too, and an LLM-bound program spends most of its
 *              wall-clock awaiting inference, so there's no sane global default —
 *              the caller who knows the workload sets it.
 *   signal   — cooperative cancellation, observed at the TICK abort-check. Lands
 *              at IO/await boundaries (e.g. between infer calls) and as a
 *              pre-aborted fast-fail. It does NOT preempt a pure-CPU spin: the
 *              TICK yield is a microtask (`await Promise.resolve()`), which starves
 *              the macrotask timer queue, so a timer-based abort can't fire
 *              mid-spin. For runaway CPU, reach for budgetMs.
 */
export interface ExecBudget {
  signal?: AbortSignal;
  budgetMs?: number;
}

// Cache compiled+analyzed templates by source string. Templates are pure
// functions of their source; safe to share across runs and projects.
interface CompiledTemplate {
  render: HandlebarsTemplateDelegate;
  info: TemplateInfo;
}
const TEMPLATE_CACHE = new Map<string, CompiledTemplate>();

function compileTemplate(source: string): CompiledTemplate {
  let tm = TEMPLATE_CACHE.get(source);
  if (!tm) {
    tm = {
      render: Handlebars.compile(source, { noEscape: true }),
      info: analyzeTemplate(source),
    };
    TEMPLATE_CACHE.set(source, tm);
  }
  return tm;
}

const isPrimitiveLike = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  Array.isArray(v) ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean";

const isDictLike = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Build the input dict from a list of call-site args, per the three modes:
 *
 *   1. (template dict)       — dict-like single arg: pass through (validated)
 *   2. (template primitive)  — primitive single arg + single-var template:
 *                              wrap as `{<singleVarName>: arg}`
 *   3. (template k1 v1 k2 v2 …) — even args, every even index is a string
 *                                 matching a template root field: build dict
 *
 * Anything else throws with a structured message.
 */
function resolveTemplateInput(args: unknown[], info: TemplateInfo): Record<string, unknown> {
  if (args.length === 0) {
    throw new Error("template: expected at least one argument");
  }
  if (args.length === 1) {
    const a = args[0];
    if (isDictLike(a)) return a;
    if (isPrimitiveLike(a)) {
      if (!info.singleVarName) {
        throw new Error(
          `template: single primitive arg passed to a template with ${info.rootFields.length} fields ` +
            `(${info.rootFields.join(", ")}); either pass a dict, or use alternating keyword/value args`,
        );
      }
      return { [info.singleVarName]: a };
    }
    throw new Error(`template: unsupported single-arg type ${typeName(a)}`);
  }
  // Multi-arg: alternating string-key / value pairs.
  if (args.length % 2 !== 0) {
    throw new Error(`template: expected even number of args (alternating key/value), got ${args.length}`);
  }
  const fieldSet = new Set(info.rootFields);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (typeof k !== "string") {
      throw new TypeError(`template: key at position ${i} is not a string (got ${typeName(k)})`);
    }
    if (info.rootFields.length > 0 && !fieldSet.has(k)) {
      throw new Error(`template: unknown field "${k}"; template root fields are: ${info.rootFields.join(", ")}`);
    }
    out[k] = args[i + 1];
  }
  return out;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Single-entry rosetta the require-expansion calls. Takes the template
 * source and the rest-list of call-site args, dispatches to one of the three
 * call modes, validates, and renders.
 */
/** Nil-like for the array→`[]` failsafe: a scheme empty-list crosses the rosetta
 *  membrane as `nil` (`instanceof Nil` also catches provenance-bearing clones),
 *  plus JS null/undefined for an absent field. */
const isNilLike = (v: unknown): boolean => v == null || v instanceof Nil;

function renderTemplateCall(source: string, args: unknown[]): string {
  const tm = compileTemplate(source);
  // Coerce array-shaped fields that arrived nil (empty scheme list) to `[]` before
  // validating, so `{{#each}}` over an empty collection renders nothing rather than
  // tripping the array check — the cross-lang membrane can't make an empty list a
  // JS array on its own (see coerceShape).
  const data = coerceShape(tm.info.shape, resolveTemplateInput(args, tm.info), isNilLike);
  const ok = validateShape(tm.info.shape, data);
  if (!ok.ok) {
    throw new Error(`template input mismatch: ${ok.message}`);
  }
  return tm.render(data);
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

/** Coerce a scheme value to a nullable scalar string (false/null/undefined → null). */
const nullable = (v: unknown): string | null => (v === undefined || v === false || v === null ? null : String(v));

/** Canonicalise a schema arg (string marker | tagged-list DSL | nothing) to the
 *  single string used as the schema slot of a task's content key. */
const schemaSlot = (v: unknown): string | null => {
  if (v === undefined || v === false || v === null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
};

/**
 * The infer-resolution seam: resolve ONE `(infer …)` call site to its value. The
 * caller decides where the task lives (the project's content-addressed cache, or
 * host's per-File tasks) and how it resolves. Returns the RAW value;
 * `buildArrivalEnv` wraps it to a list for scheme. Args arrive already coerced
 * (tier/prompt stringified, schema via schemaSlot, cacheKey via nullable).
 */
export type InferFn = (
  ctx: { currentInvocation?: unknown } | undefined,
  tier: string,
  prompt: string,
  schema: string | null,
  cacheKey: string | null,
) => Promise<unknown>;

/**
 * Build a sandboxed arrival-chain environment with the standard rosettas —
 * `infer`, `infer/chat`, `json/parse`, `dict`, `template/handlebars`, plus
 * `require`/`import` — EXCEPT inference resolution, which is injected via `infer`.
 *
 * This is the seam that lets a host route `(infer …)` into its own task store
 * without arrival-chain hardcoding where tasks live: `Project.run` passes a
 * cache-backed resolver; host passes a per-File one. The caller execs
 * `BUILTIN_PREAMBLE` (+ its source) against the returned env.
 */
export function buildArrivalEnv(opts: {
  name: string;
  infer: InferFn;
  loader: Loader;
  /** Tap for `require`d module internals — `run` passes the trace; `runTraced`
   *  omits it so library internals don't explode the live trace. */
  tap?: EvalTrace;
  /** Base dir for resolving relative `(require …)`. */
  dirname?: string;
}): ReturnType<typeof sandboxedEnv.inherit> {
  const env = sandboxedEnv.inherit(opts.name);
  // Every (infer …) yields a list to scheme; the resolver returns the raw value.
  const list = (v: unknown): unknown => (Array.isArray(v) ? v : [v]);

  env.defineRosetta("infer", {
    withContext: true,
    options: { provenancePoint: true },
    fn: async (ctx, tier, prompt, schema, cacheKey) =>
      list(await opts.infer(ctx, String(tier), String(prompt), schemaSlot(schema), nullable(cacheKey))),
  });
  env.defineRosetta("json/parse", { fn: (s: unknown) => JSON.parse(String(s)) });
  env.defineRosetta("dict", { fn: (...args: unknown[]) => buildDict(args) });
  env.defineRosetta("template/handlebars", {
    fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
  });
  env.defineRosetta("infer/chat", {
    withContext: true,
    options: { provenancePoint: true },
    fn: async (ctx, tier, messages, schema, cacheKey) =>
      list(await opts.infer(ctx, String(tier), canonicalizeMessages(messages), schemaSlot(schema), nullable(cacheKey))),
  });
  // Seal a `.prompt` PromptUnit into a provenance-point native proc. The output
  // schema is evaluated ONCE here (the `s/…` rosettas live on this env) and
  // slotted exactly as `infer/chat` would. Calling the proc `(run-x key :k v …)`
  // folds the kwargs, renders its sections, and infers AT JS LEVEL — and because
  // it's a `provenancePoint`, ITS OWN call-site invocation becomes the provenance
  // point. So a `.prompt` traces as ONE node at the real `(run-x …)` site with
  // the infer sealed inside it — no unwrapped line-1 `(infer/chat …)` lambda. The
  // task it mints is byte-identical to the equivalent `infer/chat` (shared
  // canonicalize + schemaSlot + nullable), so cache + replay are preserved.
  const compileInferUnit = async (unit: PromptUnit): Promise<unknown> => {
    let schemaSlotStr: string | null = null;
    if (unit.schemaSrc !== null) {
      const [form] = await parse(unit.schemaSrc);
      schemaSlotStr = schemaSlot(lipsToJs(await execExpr(form, { env })));
    }
    return createRosettaWrapper({
      withContext: true,
      options: { provenancePoint: true },
      fn: async (ctx, key, ...kv: unknown[]) => {
        const inputs = buildDict(kv);
        // Bind the node's story (file, model, the structured inputs) to its
        // provenance node NOW, before the inference runs. It's all known at call
        // time, so the card renders its header + init fields WHILE the answer is
        // still streaming — not only once it resolves. (`resultWithProvenance`
        // binds at return, which is too late for a streamed result.) `result`
        // flows on as the ordinary value. Same setMetadata-vs-POJO story as the
        // rosetta wrapper: a real Invocation is a MobX observable (action), a plain
        // test ctx is a bare object.
        const inv = (ctx as { currentInvocation?: { setMetadata?(m: unknown): void; metadata?: unknown } } | undefined)
          ?.currentInvocation;
        if (inv) {
          const meta = { kind: "prompt", path: unit.path, model: unit.tier, inputs };
          if (typeof inv.setMetadata === "function") inv.setMetadata(meta);
          else inv.metadata = meta;
        }
        const messages = unit.sections.map((s) => [s.role, renderTemplateCall(s.source, [inputs])]);
        return opts.infer(ctx, unit.tier, canonicalizeMessages(messages), schemaSlotStr, nullable(key));
      },
    });
  };
  defineImportRosetta({ env, loader: opts.loader });
  defineRequireRosetta({ env, loader: opts.loader, tap: opts.tap, baseDir: opts.dirname ?? "", compileInferUnit });
  return env;
}

/**
 * Doc root.
 *   `files`    — owns Programs by path (the filesystem of this project)
 *   `programs` — non-owning refs into `files`, in explicit execution order
 *
 * Inference results live in a sibling `InferenceCache` doc — bind one via
 * `project.bindCache(cache)` before running programs or workers. The
 * separation keeps authored intent (this doc) decoupled from derived
 * facts (cache doc) so ephemeral runs can share a cache without
 * polluting any project doc, and projects can share caches.
 *
 * A file in `files` but NOT in `programs` is a library — imported by
 * other files, never executed standalone. Workers consume `programs`
 * in array order.
 */
@syncing("ArrivalChainProject")
export class Project extends PlexusModel<null> {
  // Model resolution lives in a separate `ModelRouter` passed to the
  // orchestrator at startup — see `registry.ts`. Project is pure model
  // state (no API keys, no SDK instances, no tier mappings — programs
  // call `(infer "model-id" …)` with the literal model name the runner
  // knows how to route).

  @syncing.child.map /** path → Program. Owning child map. */ accessor files: Map<string, Program> = new Map();

  // ── Cache binding (runtime, not synced) ───────────────────────────
  //
  // The sibling `InferenceCache` doc that holds `tasks`. Bound at
  // orchestration time (runner / CLI / test setup); not part of the
  // synced model because (a) docs don't reference each other in plexus
  // by entity-pointer — different state vectors — and (b) the same
  // project may bind different caches across processes (e.g. team
  // cache in prod, scratch cache in tests).

  #cache: InferenceCache | null = null;

  bindCache(cache: InferenceCache): void {
    this.#cache = cache;
  }

  get cache(): InferenceCache {
    invariant(this.#cache, "Project: no cache bound — call project.bindCache(cache) before running programs or workers");
    return this.#cache;
  }

  // Config-as-code: per-run configuration is no longer a project-env map.
  // A program `(require "config.scm")`s a file of `(define config/<name> …)`
  // forms, which spill ordinary bindings into the run env. There is no
  // scheme-side write path and no host-injected env — execution stays a pure
  // function of the project's files, which is what makes replay sound.

  transact(fn: () => void): void {
    const plexus = docPlexus.get(this.__doc__!);
    invariant(plexus, "Project: doc has no Plexus instance");
    plexus.transact(fn);
  }

  // ── Files + programs ──────────────────────────────────────────────

  addFile(path: string, initialSource?: string): Program {
    const program = new Program();
    this.transact(() => {
      this.files.set(path, program);
      if (initialSource !== undefined) program.publish(initialSource);
    });
    return program;
  }

  /** Backwards-compat alias for addFile; "program" used to be a distinct concept. */
  addProgram(path: string, initialSource?: string): Program {
    return this.addFile(path, initialSource);
  }

  findFile(path: string): Program | undefined {
    return this.files.get(path);
  }

  /** Reverse lookup: which path holds this Program? */
  findFilePath(program: Program): string | undefined {
    for (const [path, p] of this.files) if (p === program) return path;
    return undefined;
  }

  // ── Execution ─────────────────────────────────────────────────────

  /**
   * Run an arrival-scheme program against this project's task cache.
   *
   * `infer` is bound via defineRosetta: each call ↔ find-or-create a
   * task entity in `tasks` keyed by the content tuple `[m,p,s]`, then
   * await its resolution. Resolution happens out-of-band — a
   * `runProjectWorker` (or any peer) observes `tasks` and drains
   * pending ones. There is no orchestration between `run` and the
   * worker beyond the doc.
   *
   * Parallelism falls out of LIPS's promise-aware evaluator: a missing
   * cell returns a Promise; `(map infer xs)` collects them; the
   * program's consumer (`promise_all` inside map/string-append) is
   * where the wait happens. Force at observation, not at the call.
   */
  async run(
    source: string,
    opts: {
      trace?: EvalTrace;
      resolver?: RequireResolver;
      /** Override the module loader for `(require …)`. Defaults to the project VFS. */
      loader?: Loader;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Per-run curated `import` registry — `(import "name")` resolves here.
       *  Merged onto the loader's defaults (per-run entries win). */
      imports?: Map<string, unknown>;
      /** Called with the canonical tuple-key for every `(infer …)` invocation. */
      onInfer?: (tupleKey: string) => void;
      /**
       * Override inference resolution by content tuple — keyed by canonical
       * JSON of `[tier, prompt, schema, cacheKey]`. Hypothesis re-runs pass
       * tweaks here so chosen tuples short-circuit without hitting the LLM.
       */
      tweaks?: Map<string, string>;
    } & ExecBudget = {},
  ): Promise<unknown> {
    // The cache-backed infer resolver: find-or-create a task in this project's
    // content-addressed cache, bind the trace, await its result. The rosetta
    // wiring + list-wrapping live in buildArrivalEnv (shared with runTraced +
    // host); this closure is the project-specific seam.
    const inferAndWait: InferFn = async (ctx, tier, prompt, schema, cacheKey) => {
      // Hypothesis tweaks short-circuit before any cache lookup — the whole
      // point is to NOT consult the LLM for these tuples.
      const tweakKey = JSON.stringify([tier, prompt, schema, cacheKey]);
      const tweak = opts.tweaks?.get(tweakKey);
      if (tweak !== undefined) return JSON.parse(tweak); // buildArrivalEnv wraps to a list
      const task = this.cache.upsertTask(tier, prompt, schema, cacheKey);
      opts.onInfer?.(tweakKey);
      const inv = ctx?.currentInvocation;
      if (inv && opts.trace) {
        opts.trace.bindTask(task, inv as never);
        // A task already holding a result at bind time was paid for by an earlier
        // run — colour this invocation a cache hit. Read before the await resolves.
        opts.trace.markInferCached(inv as never, task.isResolved);
        // Every (infer …) is a fresh provenance singleton {self.id}.
        opts.trace.markProvenancePoint(inv as never);
      }
      return task.waitFor();
    };

    const loader = opts.loader ?? (opts.resolver ? loaderFromResolver(opts.resolver) : makeProjectLoader(this));
    // `import` is the curated host-capability registry (FS-free). Merge the
    // per-run set onto the loader's defaults; the require rosetta taps this run.
    if (opts.imports) for (const [name, value] of opts.imports) loader.imports.set(name, value);
    const env = buildArrivalEnv({ name: "arrival-chain", infer: inferAndWait, loader, tap: opts.trace, dirname: opts.dirname });
    const results = await exec(BUILTIN_PREAMBLE + source, {
      env,
      tap: opts.trace,
      signal: opts.signal,
      budgetMs: opts.budgetMs,
    });
    let last: unknown = results.at(-1);
    if (isThenable(last)) last = await last;
    return lipsToJs(last, {});
  }

  /**
   * Reverse-membrane entry: evaluate a named `(define …)` from `file`
   * with supplied `args`. Mints an apiCall Run under that file's Program,
   * populated with the version snapshot, input, inference references as
   * they fire, and final output. Returns the Run synchronously so the
   * API layer can hand its id back to the client immediately.
   */
  invoke(opts: { id: string; file: string; name: string; args: readonly unknown[] }): Run {
    const program = this.files.get(opts.file);
    invariant(program, `Project.invoke: file "${opts.file}" not found`);
    invariant(!program.apiCalls.has(opts.id), `Project.invoke: id "${opts.id}" already exists`);

    const run = new Run();
    this.transact(() => {
      program.apiCalls.set(opts.id, run);
      run.versionIndex = program.versions.length - 1;
      run.hasInput = true;
      run.name = opts.name;
      run.argsJson = JSON.stringify(opts.args);
      run.startedAt = Date.now();
      run.status = "pending";
    });

    const body = program.versions.at(-1)?.source ?? "";
    void this.#executeRun(run, body, opts.name, opts.args);
    return run;
  }

  // ── Drafts ─────────────────────────────────────────────────────────
  //
  // `.scm` files are deployed (read-only at rest). Edits go through a
  // Draft — one in-flight mutable head per file. Sandbox runs live
  // under the draft, not under the Program. Promoting a draft appends
  // a new version and clears the draft slot.

  /** Mint a new draft from the program's latest version. Throws if a draft already exists. */
  createDraft(opts: { file: string }): Draft {
    const program = this.files.get(opts.file);
    invariant(program, `Project.createDraft: file "${opts.file}" not found`);
    invariant(!program.draft, `Project.createDraft: draft already exists on "${opts.file}"`);
    const latestIndex = program.versions.length - 1;
    const draft = new Draft();
    this.transact(() => {
      program.draft = draft;
      draft.source = program.versions[latestIndex]?.source ?? "";
      draft.basedOnVersion = latestIndex;
    });
    console.log(`[draft] createDraft "${opts.file}" basedOnVersion=${latestIndex} sourceLen=${draft.source.length}`);
    return draft;
  }

  /** Mutate the draft's source. Auto-creates a draft from latest version if missing. */
  editDraftSource(opts: { file: string; source: string }): Draft {
    const program = this.files.get(opts.file);
    invariant(program, `Project.editDraftSource: file "${opts.file}" not found`);
    const draft = program.draft ?? this.createDraft({ file: opts.file });
    if (draft.source !== opts.source) {
      this.transact(() => { draft.source = opts.source; });
      console.log(`[draft] editDraftSource "${opts.file}" sourceLen=${opts.source.length}`);
    }
    return draft;
  }

  /** Publish the draft's source as a new version; clear the draft slot. */
  promoteDraft(opts: { file: string }): ProgramVersion {
    const program = this.files.get(opts.file);
    invariant(program, `Project.promoteDraft: file "${opts.file}" not found`);
    const draft = program.draft;
    invariant(draft, `Project.promoteDraft: no draft on "${opts.file}"`);
    let version!: ProgramVersion;
    this.transact(() => {
      version = program.publish(draft.source);
      program.draft = null;
    });
    return version;
  }

  /** Throw the draft away, including all its sandbox runs. */
  discardDraft(opts: { file: string }): void {
    const program = this.files.get(opts.file);
    invariant(program, `Project.discardDraft: file "${opts.file}" not found`);
    this.transact(() => { program.draft = null; });
  }

  /**
   * Forward-membrane entry: studio is re-evaluating the draft of a file.
   * Mints a sandbox Run under the file's Draft (auto-creates the draft
   * if missing). Returns the Run + the finished promise.
   */
  sandboxRun(opts: {
    id: string;
    file: string;
    trace?: EvalTrace;
    resolver?: RequireResolver;
  }): { run: Run; finished: Promise<unknown> } {
    const program = this.files.get(opts.file);
    invariant(program, `Project.sandboxRun: file "${opts.file}" not found`);
    const draft = program.draft ?? this.createDraft({ file: opts.file });
    invariant(!draft.sandbox.has(opts.id), `Project.sandboxRun: id "${opts.id}" already exists`);

    const run = new Run();
    this.transact(() => {
      draft.sandbox.set(opts.id, run);
      run.versionIndex = draft.basedOnVersion;
      run.hasInput = false;
      run.startedAt = Date.now();
      run.status = "pending";
    });

    const body = draft.source;
    const finished = this.#executeSandbox(run, body, opts.trace, opts.resolver);
    return { run, finished };
  }

  async #executeRun(
    run: Run,
    body: string,
    name: string,
    args: readonly unknown[],
  ): Promise<void> {
    // Failure is already recorded on the Run by #runIntoRun; swallow here
    // so the void-call from invoke() doesn't produce an unhandled rejection.
    try {
      await this.#runIntoRun(run, body + "\n" + this.#callForm(name, args));
    } catch {
      /* recorded on run.output */
    }
  }

  async #executeSandbox(
    run: Run,
    body: string,
    trace?: EvalTrace,
    resolver?: RequireResolver,
  ): Promise<unknown> {
    return this.#runIntoRun(run, body, { trace, resolver });
  }

  async #runIntoRun(
    run: Run,
    source: string,
    opts: { trace?: EvalTrace; resolver?: RequireResolver; tweaks?: Map<string, string> } = {},
  ): Promise<unknown> {
    try {
      const value = await this.run(source, {
        ...opts,
        onInfer: (tupleKey) => {
          // Each inference key appended in its own micro-transact so peers
          // see the trace grow as it happens (not just on finish).
          this.transact(() => run.inferences.push(tupleKey));
        },
      });
      this.transact(() => {
        run.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
        run.status = "resolved";
        run.finishedAt = Date.now();
      });
      return value;
    } catch (error) {
      this.transact(() => {
        run.output = new RunError({
          message: formatRunError(error),
        });
        run.status = "failed";
        run.finishedAt = Date.now();
      });
      throw error;
    }
  }

  /**
   * Counterfactual replay. Re-executes the given Run against a tweak map
   * (canonical-tuple-string → override-value-JSON) and records the result
   * as a Hypothesis child of that Run. Source comes from the Run's pinned
   * `versionIndex` snapshot — not the file's latest — so hypotheses stay
   * faithful even if the file has since been edited.
   */
  runHypothesis(opts: {
    id: string;
    run: Run;
    tweaks: Map<string, string>;
  }): { hypothesis: Hypothesis; finished: Promise<unknown> } {
    const run = opts.run;
    invariant(!run.hypotheses.has(opts.id), `Project.runHypothesis: id "${opts.id}" already exists`);
    // Run.parent is Program (apiCall) or Draft (sandbox). For hypothesis
    // replay we always want the Program so we can address its versions[].
    const parentNode = run.parent;
    invariant(parentNode, "Project.runHypothesis: Run is detached");
    const program: Program = parentNode instanceof Program ? parentNode : parentNode.parent!;
    invariant(program, "Project.runHypothesis: could not resolve owning Program");
    const version = program.versions[run.versionIndex];
    invariant(version, `Project.runHypothesis: version ${run.versionIndex} missing from program`);

    const hypothesis = new Hypothesis();
    this.transact(() => {
      run.hypotheses.set(opts.id, hypothesis);
      hypothesis.tweaksJson = JSON.stringify(Object.fromEntries(opts.tweaks));
      hypothesis.startedAt = Date.now();
      hypothesis.status = "pending";
    });

    const body = version.source;
    const source = run.hasInput
      ? body + "\n" + this.#callForm(run.name, run.args)
      : body;
    const finished = (async () => {
      try {
        const value = await this.run(source, {
          tweaks: opts.tweaks,
          onInfer: (tupleKey) => this.transact(() => hypothesis.inferences.push(tupleKey)),
        });
        this.transact(() => {
          hypothesis.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
          hypothesis.status = "resolved";
          hypothesis.finishedAt = Date.now();
        });
        return value;
      } catch (error) {
        this.transact(() => {
          hypothesis.output = new RunError({
            message: formatRunError(error),
          });
          hypothesis.status = "failed";
          hypothesis.finishedAt = Date.now();
        });
        throw error;
      }
    })();
    return { hypothesis, finished };
  }

  /**
   * Studio sandbox entry that ALSO produces the tap-attached `userForms`
   * (for live counter rendering). Auto-creates a draft if missing, syncs
   * the draft's source to the buffer, then mints a sandbox Run under the
   * draft. The Run's `versionIndex` pins to the draft's `basedOnVersion`
   * — the deployed version this experimentation diverged from.
   */
  async sandboxRunTraced(opts: {
    id: string;
    file: string;
    source: string;
    trace: EvalTrace;
    resolver?: RequireResolver;
  }): Promise<{ run: Run; userForms: unknown[]; finished: Promise<unknown> }> {
    console.log(`[sandbox] sandboxRunTraced enter id=${opts.id} file="${opts.file}" sourceLen=${opts.source.length}`);
    const program = this.files.get(opts.file);
    invariant(program, `Project.sandboxRunTraced: file "${opts.file}" not found`);
    const draft = this.editDraftSource({ file: opts.file, source: opts.source });
    invariant(
      !draft.sandbox.has(opts.id),
      `Project.sandboxRunTraced: id "${opts.id}" already exists`,
    );

    const run = new Run();
    this.transact(() => {
      draft.sandbox.set(opts.id, run);
      run.versionIndex = draft.basedOnVersion;
      run.hasInput = false;
      run.startedAt = Date.now();
      run.status = "pending";
    });
    console.log(`[sandbox] sandboxRunTraced minted run id=${opts.id}, draft.sandbox.size=${draft.sandbox.size}`);

    const { userForms, finished } = await this.runTraced(opts.source, {
      trace: opts.trace,
      resolver: opts.resolver,
      onInfer: (tupleKey) => this.transact(() => run.inferences.push(tupleKey)),
    });

    const tracked = (async () => {
      try {
        const value = await finished;
        this.transact(() => {
          run.output = new RunResult({ valueJson: JSON.stringify(value ?? null) });
          run.status = "resolved";
          run.finishedAt = Date.now();
        });
        return value;
      } catch (error) {
        this.transact(() => {
          run.output = new RunError({
            message: formatRunError(error),
          });
          run.status = "failed";
          run.finishedAt = Date.now();
        });
        throw error;
      }
    })();

    return { run, userForms, finished: tracked };
  }

  #callForm(name: string, args: readonly unknown[]): string {
    const argExprs = args.map((a) => `(json/parse ${JSON.stringify(JSON.stringify(a))})`);
    return `(${name}${argExprs.length ? " " + argExprs.join(" ") : ""})`;
  }

  /**
   * Run a program for live inspection: parses the user body separately and
   * returns the parsed top-level forms so callers (the monitor UI) can render
   * the same Pair objects that the evaluator will populate the trace with.
   *
   * The builtin preamble + (require ...) preamble are evaluated tap-free so
   * the trace's records map contains only user-program forms.
   *
   * Returns immediately with `{ userForms, finished }` — `finished` resolves
   * to the program's last value when (and if) all infer cells resolve.
   */
  async runTraced(
    source: string,
    opts: {
      trace: EvalTrace;
      resolver?: RequireResolver;
      /** Override the module loader for `(require …)`. Defaults to the project VFS. */
      loader?: Loader;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Per-run curated `import` registry — `(import "name")` resolves here.
       *  Merged onto the loader's defaults (per-run entries win). */
      imports?: Map<string, unknown>;
      /** Called with the canonical tuple-key for every `(infer …)` invocation. */
      onInfer?: (tupleKey: string) => void;
      /** Hypothesis-style infer-result overrides keyed by canonical tuple JSON. */
      tweaks?: Map<string, string>;
    } & ExecBudget,
  ): Promise<{ userForms: unknown[]; finished: Promise<unknown> }> {
    // Reuse the same rosetta wiring as run() by going through run() for the
    // preamble half, then parsing and tap-evaluating the user body ourselves.
    // To avoid duplicating the env-setup, we set up the env inline here.
    const inferAndWait: InferFn = async (ctx, tier, prompt, schema, cacheKey) => {
      const tupleKey = JSON.stringify([tier, prompt, schema, cacheKey]);
      const tweak = opts.tweaks?.get(tupleKey);
      if (tweak !== undefined) return JSON.parse(tweak); // buildArrivalEnv wraps to a list
      const task = this.cache.upsertTask(tier, prompt, schema, cacheKey);
      opts.onInfer?.(tupleKey);
      const inv = ctx?.currentInvocation;
      if (inv) {
        opts.trace.bindTask(task, inv as never);
        opts.trace.markInferCached(inv as never, task.isResolved);
        opts.trace.markProvenancePoint(inv as never);
      }
      return task.waitFor();
    };

    const loader = opts.loader ?? (opts.resolver ? loaderFromResolver(opts.resolver) : makeProjectLoader(this));
    if (opts.imports) for (const [name, value] of opts.imports) loader.imports.set(name, value);
    // `require` internals are NOT tapped (tap omitted) so a required library
    // doesn't explode the live trace — the (require …) call still appears as a
    // top-level user form; provenance for library infers rides the plain run().
    const env = buildArrivalEnv({ name: "arrival-chain-traced", infer: inferAndWait, loader, tap: undefined, dirname: opts.dirname });
    // Evaluate the builtin preamble first, tap-free, so the records map starts
    // with only user-program forms.
    await exec(BUILTIN_PREAMBLE, { env, signal: opts.signal, budgetMs: opts.budgetMs });
    // Parse the whole user source — these are the Pair identities the UI renders
    // AND the ones the evaluator taps. A `(require …)` resolves when its form runs.
    const userForms = await parse(source, env);

    // Kick off evaluation of each user form sequentially, with the tap attached.
    // A `(require …)` spills its defines/macros before the next form (eager-seq).
    const finished = (async () => {
      let last: unknown = undefined;
      for (const form of userForms) {
        last = await execExpr(form, { env, tap: opts.trace, signal: opts.signal, budgetMs: opts.budgetMs });
        if (isThenable(last)) last = await last;
      }
      return lipsToJs(last, {});
    })();

    return { userForms, finished };
  }
}

/**
 * Built-in scheme bindings that every Project.run() program gets,
 * before any user (require ...) preambles. Defines the chat-message
 * constructors and the schema-DSL helpers. Keeping these in the
 * runtime (instead of forcing every program to `(require "_lib.scm")`)
 * keeps short programs short and makes the DSL feel native.
 */
export const BUILTIN_PREAMBLE =`
;; ── numeric helpers ────────────────────────────────────────────────
;; (range 3) → (0 1 2)
(define (range n)
  (define (loop i acc) (if (>= i n) (reverse acc) (loop (+ i 1) (cons i acc))))
  (loop 0 '()))

;; ── list helpers (used by fold-based pipelines like the GEPA loop) ─
;; All four are textbook one-liners; live in the preamble so they're
;; available without each program redefining them.
;;
;; (take 3 '(a b c d e))   → (a b c)
;; (drop 2 '(a b c d e))   → (c d e)
;; (count-if odd? '(1 2 3 4)) → 2
;; (max-by car '((1 x) (3 y) (2 z))) → (3 y)
;;
;; LIPS \`reduce\` is element-first: callback signature is (x acc), not (acc x).
(define (take n xs)
  (if (or (= n 0) (null? xs)) '() (cons (car xs) (take (- n 1) (cdr xs)))))
(define (drop n xs)
  (if (or (= n 0) (null? xs)) xs (drop (- n 1) (cdr xs))))
(define (count-if pred xs)
  (reduce (lambda (x acc) (if (pred x) (+ acc 1) acc)) 0 xs))
;; max-by: ties go to the first encountered walking cdr from (car xs).
;; With history that's most-recent-first, that means the most-recent
;; tied-at-max element wins — the "converged here" semantic.
(define (max-by f xs)
  (reduce (lambda (x best) (if (> (f x) (f best)) x best)) (car xs) (cdr xs)))

;; ── dict helpers ───────────────────────────────────────────────────
;;
;; \`(require "x.json")\` produces JS objects (SchemeJSObject) via
;; json/parse. Three equivalent ways to read a field:
;;   (@ obj "key")    explicit accessor, works on variable keys
;;   (:key obj)       keyword as fn, idiomatic for fixed keys
;;   (field obj key)  polymorphic — also walks alists, returns "" on miss
;;                    (useful where the same code reads both shapes)
;;
;; @keys returns a JS array; keys-of converts to a scheme list.
;; values-of and entries-of parallel JS Object.values/.entries.
(define (field container key)
  (cond ((null? container) "")
        ((pair? container)
          (let ((p (assoc key container))) (if (pair? p) (cdr p) "")))
        (else (@ container key))))

(define (keys-of obj)    (vector->list (@keys obj)))
(define (values-of obj)  (map (lambda (k) (@ obj k))          (keys-of obj)))
(define (entries-of obj) (map (lambda (k) (list k (@ obj k))) (keys-of obj)))

;; ── chat message constructors ──────────────────────────────────────
(define (infer/chat/system content)    (list "system"    content))
(define (infer/chat/user content)      (list "user"      content))
(define (infer/chat/assistant content) (list "assistant" content))

;; ── schema DSL ─────────────────────────────────────────────────────
(define (s/object . fields)        (cons "object" fields))
(define (s/array element)          (list "array" element))
(define (s/enum . values)          (cons "enum" values))

(define (s/field name type . desc)
  (if (null? desc) (list name type) (list name type (car desc))))

(define (s/field/string  name . rest) (apply s/field (cons name (cons "string"  rest))))
(define (s/field/number  name . rest) (apply s/field (cons name (cons "number"  rest))))
(define (s/field/integer name . rest) (apply s/field (cons name (cons "integer" rest))))
(define (s/field/boolean name . rest) (apply s/field (cons name (cons "boolean" rest))))

(define (s/field/_composite name . rest)
  (cond ((= (length rest) 1) (s/field name (car rest)))
        ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
        (else (error "s/field/composite: expected (name config) or (name desc config)"))))

(define (s/field/object . args) (apply s/field/_composite args))
(define (s/field/array  . args) (apply s/field/_composite args))
(define (s/field/enum   . args) (apply s/field/_composite args))
`;
