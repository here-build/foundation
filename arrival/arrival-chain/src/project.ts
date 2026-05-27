import "@here.build/plexus/mobx/register";
import {
  execGeneratorFromString as exec,
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  sandboxedEnv,
  lipsToJs,
} from "@here.build/arrival-scheme";
import { docPlexus, PlexusModel, syncing } from "@here.build/plexus";
import Handlebars from "handlebars";
import invariant from "tiny-invariant";

import type { InferenceCache } from "./cache.js";
import { Draft } from "./draft.js";
import { Program, ProgramVersion } from "./program.js";
import { Hypothesis, Run, RunError, RunResult } from "./run.js";
import { resolveRequires, type RequireResolver } from "./require.js";
import { analyzeTemplate, type TemplateInfo, validateShape } from "./template-analyze.js";
import type { EvalTrace } from "./trace.js";

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
function renderTemplateCall(source: string, args: unknown[]): string {
  const tm = compileTemplate(source);
  const data = resolveTemplateInput(args, tm.info);
  const ok = validateShape(tm.info.shape, data);
  if (!ok.ok) {
    throw new Error(`template input mismatch: ${ok.message}`);
  }
  return tm.render(data);
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

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

  /**
   * Read-only environment surface for scheme programs. Keyed by a path
   * tuple, values are JSON primitives. Reachable from a program via
   *
   *   (project/get "audience" "count")
   *
   * which delegates to `this.env.get(["audience", "count"])`. There is
   * deliberately NO scheme-side write path — execution stays a pure
   * function of the project's state, which is what makes replay sound.
   */
  @syncing.map accessor env: Map<string[], string | number | boolean> = new Map();

  setEnv(...args: [...path: string[], value: string | number | boolean]): void {
    invariant(args.length >= 2, "setEnv: need at least one path component and a value");
    const value = args.at(-1) as string | number | boolean;
    const path = args.slice(0, -1) as string[];
    this.env.set(path, value);
  }

  getEnv(...path: string[]): string | number | boolean {
    const v = this.env.get(path);
    invariant(v !== undefined, `project/get: no env entry at path [${path.join(", ")}]`);
    return v;
  }

  /**
   * Fallback resolver that turns bare `project/<seg>[/<seg>…]` symbols into
   * env lookups. `project/replays` IS the value stored at env path
   * `["replays"]`; `project/audience/count` IS the value at
   * `["audience", "count"]`. Misses fall through to "Unbound variable",
   * which is the right signal — the program named something that simply
   * doesn't exist in this project's env.
   */
  #installProjectEnvResolver(env: {
    registerResolver: (r: { id: string; resolve: (name: string) => unknown }) => unknown;
  }): void {
    env.registerResolver({
      id: "project-env",
      resolve: (name: string) => {
        if (!name.startsWith("project/")) return undefined;
        const rest = name.slice("project/".length);
        // `project/get` and any other `project/*` rosetta are direct
        // bindings and resolve before fallback resolvers fire — but
        // guard the empty/single-segment edge anyway.
        if (rest.length === 0) return undefined;
        return this.env.get(rest.split("/"));
      },
    });
  }

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
      /** Called with the canonical tuple-key for every `(infer …)` invocation. */
      onInfer?: (tupleKey: string) => void;
      /**
       * Override inference resolution by content tuple — keyed by canonical
       * JSON of `[tier, prompt, schema, cacheKey]`. Hypothesis re-runs pass
       * tweaks here so chosen tuples short-circuit without hitting the LLM.
       */
      tweaks?: Map<string, string>;
    } = {},
  ): Promise<unknown> {
    const env = sandboxedEnv.inherit("arrival-chain");
    this.#installProjectEnvResolver(env);

    const nullable = (v: unknown): string | null => (v === undefined || v === false || v === null ? null : String(v));

    /**
     * Schema may arrive as a string (legacy marker) or a nested list
     * (the tagged-list DSL: `'("object" ("name" "string") ...)`). Both
     * canonicalise to a single string used as the schema slot in the
     * cache tuple. Backend impls parse the JSON form to render JSON
     * schema / drive JSON mode.
     */
    const schemaSlot = (v: unknown): string | null => {
      if (v === undefined || v === false || v === null) return null;
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    };

    const inferAndWait = async (
      ctx: { currentInvocation?: unknown } | undefined,
      tier: string,
      prompt: string,
      schema: string | null,
      cacheKey: string | null,
    ): Promise<unknown> => {
      // Hypothesis tweaks short-circuit before any cache lookup — the whole
      // point is to NOT consult the LLM for these tuples.
      const tweakKey = JSON.stringify([tier, prompt, schema, cacheKey]);
      const tweak = opts.tweaks?.get(tweakKey);
      if (tweak !== undefined) {
        const v = JSON.parse(tweak);
        return Array.isArray(v) ? v : [v];
      }
      const task = this.cache.upsertTask(tier, prompt, schema, cacheKey);
      opts.onInfer?.(tweakKey);
      const inv = ctx?.currentInvocation;
      if (inv && opts.trace) opts.trace.bindTask(task, inv as never);
      const value = await task.waitFor();
      return Array.isArray(value) ? value : [value];
    };

    env.defineRosetta("infer", {
      withContext: true,
      fn: (ctx, tier, prompt, schema, cacheKey) =>
        inferAndWait(ctx, String(tier), String(prompt), schemaSlot(schema), nullable(cacheKey)),
    });

    // ── json/parse — cross-boundary JSON loader ───────────────────────
    //
    // Returns plain JS values. The rosetta wrapper auto-routes:
    //   - JS arrays → scheme lists (jsToLips wraps as Pair chain)
    //   - JS objects → SchemeJSObject, access via `@`
    //   - primitives → pass through
    //
    // Used by `(require "x.json")` so JSON objects are dict-shaped on
    // arrival (no alist hand-rolling needed).
    env.defineRosetta("json/parse", {
      fn: (s: unknown) => JSON.parse(String(s)),
    });

    // ── dict — build a plain JS object from alternating key/value args ─
    //
    // `(dict "name" name "lang" "french")` returns `{name, lang: "french"}`.
    // Useful for constructing template input on the call site, e.g.
    // `(my-template (dict "phrase" phrase))`.
    env.defineRosetta("dict", {
      fn: (...args: unknown[]) => {
        invariant(args.length % 2 === 0, "dict: needs an even number of args (alternating keys/values)");
        const out: Record<string, unknown> = {};
        for (let i = 0; i < args.length; i += 2) {
          out[String(args[i])] = args[i + 1];
        }
        return out;
      },
    });

    // ── template/handlebars — string template rendering with dispatch ───
    //
    // `(template/handlebars "<src>" args-list)` renders the Handlebars
    // template against args, which the dispatcher (see `renderTemplateCall`)
    // converts to a dict via one of three call modes. The compiled template
    // is cached by source, and the inferred input shape is validated before
    // rendering — mismatches throw with a path-oriented error.
    env.defineRosetta("template/handlebars", {
      fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
    });

    // ── project/get — read-only env access ────────────────────────────
    //
    // `(project/get "audience" "count")` resolves to the env entry at
    // path ["audience", "count"]. Throws on miss. No project/set —
    // scheme execution remains a pure function of project state.
    env.defineRosetta("project/get", {
      fn: (...path: unknown[]) => this.getEnv(...path.map(String)),
    });

    // ── infer/chat — role-tagged message list ─────────────────────────
    //
    // Constructors (defined in the scheme preamble below) return
    // pairs `(role content)`. infer/chat canonicalises the list to
    // a JSON-stringified [{role, content}, ...] and uses that as the
    // cache prompt — the cache key still rides on a single string,
    // so caching, dedup and replay all work identically to `infer`.
    env.defineRosetta("infer/chat", {
      withContext: true,
      fn: (ctx, tier, messages, schema, cacheKey) => {
        const msgs = messages as unknown[];
        invariant(Array.isArray(msgs), "infer/chat: messages must be a list");
        const canonical = JSON.stringify(
          msgs.map((m) => {
            invariant(Array.isArray(m) && m.length === 2, "infer/chat: each message must be (role content)");
            return { role: String(m[0]), content: String(m[1]) };
          }),
        );
        return inferAndWait(ctx, String(tier), canonical, schemaSlot(schema), nullable(cacheKey));
      },
    });

    const { preamble: requirePreamble, body } = resolveRequires(this, source, opts.resolver);
    const results = await exec(BUILTIN_PREAMBLE + requirePreamble + body, {
      env,
      tap: opts.trace,
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
          message: error instanceof Error ? error.message : String(error),
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
            message: error instanceof Error ? error.message : String(error),
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
            message: error instanceof Error ? error.message : String(error),
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
      /** Called with the canonical tuple-key for every `(infer …)` invocation. */
      onInfer?: (tupleKey: string) => void;
      /** Hypothesis-style infer-result overrides keyed by canonical tuple JSON. */
      tweaks?: Map<string, string>;
    },
  ): Promise<{ userForms: unknown[]; finished: Promise<unknown> }> {
    // Reuse the same rosetta wiring as run() by going through run() for the
    // preamble half, then parsing and tap-evaluating the user body ourselves.
    // To avoid duplicating the env-setup, we set up the env inline here.
    const env = sandboxedEnv.inherit("arrival-chain-traced");
    this.#installProjectEnvResolver(env);

    const nullable = (v: unknown): string | null => (v === undefined || v === false || v === null ? null : String(v));
    const schemaSlot = (v: unknown): string | null => {
      if (v === undefined || v === false || v === null) return null;
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    };
    const inferAndWait = async (
      ctx: { currentInvocation?: unknown } | undefined,
      tier: string,
      prompt: string,
      schema: string | null,
      cacheKey: string | null,
    ): Promise<unknown> => {
      const tupleKey = JSON.stringify([tier, prompt, schema, cacheKey]);
      const tweak = opts.tweaks?.get(tupleKey);
      if (tweak !== undefined) {
        const v = JSON.parse(tweak);
        return Array.isArray(v) ? v : [v];
      }
      const task = this.cache.upsertTask(tier, prompt, schema, cacheKey);
      opts.onInfer?.(tupleKey);
      const inv = ctx?.currentInvocation;
      if (inv) opts.trace.bindTask(task, inv as never);
      const value = await task.waitFor();
      return Array.isArray(value) ? value : [value];
    };
    env.defineRosetta("infer", {
      withContext: true,
      fn: (ctx, tier, prompt, schema, cacheKey) =>
        inferAndWait(ctx, String(tier), String(prompt), schemaSlot(schema), nullable(cacheKey)),
    });
    env.defineRosetta("json/parse", { fn: (s: unknown) => JSON.parse(String(s)) });
    env.defineRosetta("dict", {
      fn: (...args: unknown[]) => {
        invariant(args.length % 2 === 0, "dict: needs an even number of args");
        const out: Record<string, unknown> = {};
        for (let i = 0; i < args.length; i += 2) out[String(args[i])] = args[i + 1];
        return out;
      },
    });
    env.defineRosetta("template/handlebars", {
      fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
    });
    env.defineRosetta("project/get", { fn: (...path: unknown[]) => this.getEnv(...path.map(String)) });
    env.defineRosetta("infer/chat", {
      withContext: true,
      fn: (ctx, tier, messages, schema, cacheKey) => {
        const msgs = messages as unknown[];
        invariant(Array.isArray(msgs), "infer/chat: messages must be a list");
        const canonical = JSON.stringify(
          msgs.map((m) => {
            invariant(Array.isArray(m) && m.length === 2, "infer/chat: each message must be (role content)");
            return { role: String(m[0]), content: String(m[1]) };
          }),
        );
        return inferAndWait(ctx, String(tier), canonical, schemaSlot(schema), nullable(cacheKey));
      },
    });

    const { preamble: requirePreamble, body } = resolveRequires(this, source, opts.resolver);
    // Evaluate builtin + require preamble first, tap-free, so records map
    // contains only user-program forms.
    await exec(BUILTIN_PREAMBLE + requirePreamble, { env });
    // Parse user body separately — these are the Pair identities the UI renders
    // AND the ones the evaluator will tap on.
    const userForms = await parse(body, env);

    // Kick off evaluation of each user form sequentially, with the tap attached.
    const finished = (async () => {
      let last: unknown = undefined;
      for (const form of userForms) {
        last = await execExpr(form, { env, tap: opts.trace });
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
const BUILTIN_PREAMBLE = `
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
