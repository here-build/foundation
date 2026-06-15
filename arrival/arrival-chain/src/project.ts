import "@here.build/plexus/mobx/register";
import {
  execGeneratorFromString as exec,
  execGeneratorExpr as execExpr,
  parseGenerator as parse,
  installHeapMeter,
  jsToScheme,
  sandboxedEnv,
  schemeToJs,
  type Environment,
} from "@here.build/arrival-scheme";
import { docPlexus, PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import type { DataEffectResolver, DataEffectResult } from "./data-effects.js";
import { Draft } from "./draft.js";
import { DataBinding, dataEffectKey, type EffectLog, inferEffectKey } from "./effect-log.js";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import type { OnExpose } from "./expose.js";
import { InferBinding, type InferStoreLike } from "@here.build/arrival-inference";

import {
  type BuildArrivalEnvOpts,
  type ExecBudget,
  freshInfer,
  type InferFn,
  inferIdentityKey,
  recordInfer,
  reviveInfer,
} from "./infer-kernel.js";
import { loaderFromResolver, makeProjectLoader, type Loader, type RequireResolver } from "./loader.js";
import { type McpEffectResolver, wrapMcpResolver } from "./mcp-effects.js";
import type { ResolveOverride } from "./overridable.js";
import { defineRegisterExtensionRosetta, sealRegisterExtension } from "./loader-extensions.js";
import { arrivalCapabilities, arrivalLoaderCorePack } from "./packs/index.js";
import { Program, ProgramVersion } from "./program.js";
import { RunSpend } from "@here.build/arrival-inference";

import { formatRunError, Hypothesis, Run, RunError, RunResult } from "./run.js";
import type { EvalTrace } from "@here.build/arrival-provenance";
// The infer/template/dict kernel + env-construction opts now live in `infer-kernel.ts`.
// Re-export `* from` keeps project.js's public surface (the barrel consumes it) identical.
export * from "./infer-kernel.js";
// The capability registries + the raw loader-core pack live in `packs/`. Re-exported so project.js's
// public surface (the barrel consumes it) is unchanged. The capability SINGLETONS are exported by the
// barrel directly from `./packs/*.js`, so they are not re-listed here.
export { arrivalCapabilities, discoveryCapabilities, arrivalLoaderCorePack } from "./packs/index.js";
export { runNamed, runNamedCall } from "./run-isolated.js";
export { whyOf, whereOf, howOf, dagOf } from "./handle-provenance.js";
export { ResultHandle, is_result_handle } from "./result-handle.js";
export { isWireSafe, assertWireSafe, WireUnsafeError } from "./wire-safe.js";

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

/** Directory portion of a project-relative file key, for seeding the entry's
 *  `dirname` (relative `(require …)` resolves against it). "" for a root-level
 *  file. Matches the loader's path math (a leading-slash key has no parent). */
const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
};

export async function buildArrivalEnv(opts: BuildArrivalEnvOpts): Promise<ReturnType<typeof sandboxedEnv.inherit>> {
  // The env = the sandbox base (SAFE_BUILTINS, lexically inherited) assembled with the arrival
  // capability vocabulary via the capability-DAG engine. Each capability lowers to a kernel pack and
  // validates its own slice of the SHARED `opts` config (reference-shared ⇒ closure dedup matches by
  // identity). loader-core is the raw plumbing pack, appended last (lowest precedence). Capability
  // scoping is `arrivalCapabilities()`: lower a reduced root-set to build a narrower env.
  const base = sandboxedEnv.inherit(opts.name);
  // `require/register-extension` is bound for the BOOTSTRAP phase only: every capability's
  // prelude may register a file-type resolver while the env assembles, then it is sealed so
  // a running program cannot teach the loader new file types (a resolver is a capability
  // grant, not runtime data). See loader-extensions.ts for the rationale.
  defineRegisterExtensionRosetta(base);
  // `evalScheme` lets a capability's `prelude` evaluate into the env — e.g. an `ext/*` pack
  // registering a file-type resolver via `(require/register-extension …)`. `exec` is the
  // canonical evaluator; no-op for the prelude-less capabilities. (`env` types as the
  // structural `SchemeEnv`; at runtime it's the concrete `Environment` `exec` wants.)
  const capabilityPacks = arrivalCapabilities().map((cap) =>
    cap.lower({ config: opts, evalScheme: (env, src) => exec(src, { env: env as never }) }),
  );
  // loader-core arms `(require …)`. Include it ONLY when a vfs is granted — a loader-less env has
  // no `require` symbol at all (the isolated run plane), so a program's `(require …)` is an unbound
  // variable, not a policed call. Capability withholding by absence.
  const packs = opts.loader ? [...capabilityPacks, arrivalLoaderCorePack(opts)] : capabilityPacks;
  const { env } = await assembleEnv<typeof base>(base, packs);
  sealRegisterExtension(env);
  return env;
}

/**
 * Doc root.
 *   `files`    — owns Programs by path (the filesystem of this project)
 *   `programs` — non-owning refs into `files`, in explicit execution order
 *
 * Inference is resolved by a runtime-bound `InferStore` — bind one via
 * `project.bindInfer(store)` before running programs. The store is not
 * part of the synced model: a run is a pure function of the project's
 * files, so each host resolves inference through its own store (sharing
 * a disk/HTTP cache as configured) without cross-doc entity pointers.
 *
 * A file in `files` but NOT in `programs` is a library — imported by
 * other files, never executed standalone. Workers consume `programs`
 * in array order.
 */
/**
 * The handle every `Project.run(...)` hands back — the universal spawn result. It is a THENABLE
 * (delegates `then`/`catch`/`finally` to `finished`), so `await project.run(src)` yields the VALUE
 * exactly as before — value-callers need no change. Trace / live-render callers read the fields:
 *   - `userForms` — the parsed top-level forms (resolves once parsed, before `finished`), for the
 *     studio's live counter rendering and uneval (the Pair identities the trace populates).
 *   - `finished`  — the JS-peeled final value (`schemeToJs`).
 *   - `result`    — the RAW final value (an AValue with provenance), for `uneval`/selector replay.
 *   - `env`       — the run environment, for post-run inspection.
 * `run` returns this SYNCHRONOUSLY (a factory) while all evaluation stays unconditionally async behind
 * the promises — there is no synchronous eval path.
 */
export class RunHandle implements PromiseLike<unknown> {
  constructor(
    readonly userForms: Promise<unknown[]>,
    readonly finished: Promise<unknown>,
    readonly result: Promise<unknown>,
    readonly env: Promise<Environment>,
  ) {}
  then<R1 = unknown, R2 = never>(
    onFulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.finished.then(onFulfilled, onRejected);
  }
  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<unknown> {
    return this.finished.catch(onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<unknown> {
    return this.finished.finally(onFinally);
  }
}

@syncing("ArrivalChainProject")
export class Project extends PlexusModel<null> {
  // Model resolution lives in a separate `ModelRouter` passed to the
  // orchestrator at startup — see `registry.ts`. Project is pure model
  // state (no API keys, no SDK instances, no model→endpoint mappings — programs
  // call `(infer "model-id" …)` with the literal model name the runner
  // knows how to route).

  @syncing.child.map /** path → Program. Owning child map. */ accessor files: Map<string, Program> = new Map();

  // ── Inference plane (runtime, not synced) ─────────────────────────
  //
  // The content-keyed single-flight `InferStore` that resolves every
  // `(infer …)` — replacing the CRDT Task plane. Bound at orchestration
  // time (runner / CLI / DO / test setup). Like the old cache it is not
  // synced: a run is a pure function of the project's files, so each host
  // resolves inference through its own store (sharing a disk/HTTP cache as
  // configured) without any cross-doc entity pointers.

  #infer: InferStoreLike | null = null;

  bindInfer(store: InferStoreLike): void {
    this.#infer = store;
  }

  get infer(): InferStoreLike {
    invariant(this.#infer, "Project: no inference store bound — call project.bindInfer(store) before running programs");
    return this.#infer;
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

  /** Is `path` occupied — by a file (exact key) or by an implicit folder (any
   *  descendant file under `${path}/`)? Used to reject name clashes the way a
   *  real filesystem forbids a file and a directory sharing a name. */
  private occupied(path: string): boolean {
    if (this.files.has(path)) return true;
    const prefix = `${path}/`;
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Move/rename a file or an (implicit) folder — the fs `rename` verb.
   *
   * `from` is either a file path (an exact key in `files`) or a folder prefix
   * (no trailing slash) whose every descendant file is re-keyed under `to`.
   * Re-keying preserves each Program instance: the child-map orphans it at the
   * old key and re-adopts the SAME child at the new key, so its version history
   * travels with it. One transaction.
   *
   * Folders are implicit — there is no folder entity, so a folder *is* the set
   * of files whose path starts with `${from}/`. Throws on collision (a
   * destination is already occupied) or cycle (a folder into its own descendant).
   */
  renamePath(from: string, to: string): void {
    if (from === to) return;
    const direct = this.files.get(from);
    if (direct) {
      invariant(!this.occupied(to), `renamePath: destination already exists: ${to}`);
      this.transact(() => {
        this.files.delete(from);
        this.files.set(to, direct);
      });
      return;
    }
    // Folder rename: re-key every descendant under the new prefix.
    const prefix = `${from}/`;
    const entries = [...this.files].filter(([p]) => p.startsWith(prefix));
    invariant(entries.length > 0, `renamePath: no such file or folder: ${from}`);
    invariant(to !== from && !to.startsWith(prefix), `renamePath: cannot move a folder into itself: ${from} → ${to}`);
    invariant(!this.files.has(to), `renamePath: destination already exists as a file: ${to}`);
    const moved = entries.map(([p, prog]) => [`${to}/${p.slice(prefix.length)}`, prog] as const);
    for (const [np] of moved) invariant(!this.files.has(np), `renamePath: destination already exists: ${np}`);
    this.transact(() => {
      for (const [p] of entries) this.files.delete(p);
      for (const [np, prog] of moved) this.files.set(np, prog);
    });
  }

  /**
   * Delete a file (exact key) or an (implicit) folder (every descendant file) —
   * the fs `rm -r` verb. One transaction. No-op if nothing matches.
   */
  removePath(path: string): void {
    const prefix = `${path}/`;
    this.transact(() => {
      if (this.files.has(path)) this.files.delete(path);
      for (const p of this.files.keys()) if (p.startsWith(prefix)) this.files.delete(p);
    });
  }

  /** Reverse lookup: which path holds this Program? */
  findFilePath(program: Program): string | undefined {
    for (const [path, p] of this.files) if (p === program) return path;
    return undefined;
  }

  /**
   * Snapshot every file's CURRENT latest-version index: `{path → versionIndex}`.
   * Taken at invoke-start and recorded on the Run; the replay loader binds it so
   * a run sees ONE coherent cut of the project for its whole duration — a
   * concurrent `promoteDraft` on a `(require)`d library can't tear an in-flight
   * run, and a hypothesis replays the exact bytes the original saw. Files with no
   * published version yet (index `-1`) are skipped — there's nothing to pin, and
   * a require would fail the same way against latest. */
  captureVersionSet(): Map<string, number> {
    const set = new Map<string, number>();
    for (const [path, program] of this.files) {
      const idx = program.versions.length - 1;
      if (idx >= 0) set.set(path, idx);
    }
    return set;
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
  run(
    source: string,
    opts: {
      trace?: EvalTrace;
      resolver?: RequireResolver;
      /** Override the module loader for `(require …)`. Defaults to the project VFS. */
      loader?: Loader;
      /** Set `false` to assemble a NO-REQUIRE env: no vfs is granted, so `(require …)` is an
       *  unbound symbol. The isolated MCP run plane sets this — a dereferenced program is
       *  self-contained and cannot reach back into the filesystem. Defaults to granted. */
      vfs?: boolean;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Called with the kind-tagged effect key for every EXTERNAL effect (infer,
       *  http, sql) as it fires, in evaluation order. The Run/Hypothesis recorders
       *  push these into `.effects` — the per-run effect-log's key sequence. */
      onEffect?: (effectKey: string) => void;
      /** Called when an effect SETTLES with its value: `(taggedKey, valueJson)`.
       *  Feed an `effectLogCollector().record` here to build the run's full
       *  effect-log in one pass (the source a later replay binds via `effectLog`).
       *  Fires for fresh AND replayed effects (replay re-records the identical
       *  value), so the produced log is complete regardless of cache/replay state. */
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      /**
       * Override inference resolution by content tuple — keyed by canonical JSON of
       * the UNTAGGED tuple `[model, prompt, schema, cacheKey]`. The counterfactual
       * surface: `runHypothesis` passes chosen overrides here so a branched tuple
       * short-circuits with a NEW value (never hits the LLM). Partial (only the
       * branched tuples; the rest flow through). Distinct from `effectLog`, which
       * replays RECORDED values across ALL effect kinds — bind both to replay a run
       * yet branch one node. Tweaks win over the log (the counterfactual is the point).
       */
      tweaks?: Map<string, string>;
      /**
       * Deterministic-replay log: kind-tagged effect key → recorded value JSON (see
       * `effect-log.ts`). Before any external call the matching kind+payload is
       * looked up here; a hit short-circuits with the recorded value — so binding a
       * FULL log makes every effect replay with ZERO external hits, and binding a log
       * with a changed node's forward-cone subtracted (`invalidateForwardCone`)
       * re-runs exactly the invalidated effects while the rest replay free. The
       * cross-kind currency is the tagged key, so http/sql/infer share one map
       * without collision.
       */
      effectLog?: EffectLog;
      /**
       * Host capability for DATA EFFECTS (`(http/*)` / `(sql/query)`). Threaded to
       * `buildArrivalEnv` so the verbs (node A3) reach the credentialed resolver,
       * wrapped here so each data effect records into `.effects` and replays from
       * `effectLog` through the SAME seam as infer — one effect membrane, three kinds.
       */
      data?: DataEffectResolver;
      /**
       * Host capability for MCP (`(mcp/call …)` / `(mcp/list …)`). Threaded to
       * `buildArrivalEnv` so the verbs reach the credentialed resolver, wrapped here
       * (POSITIONAL server-tape) so each mcp call records into the effect-log and
       * replays HERMETICALLY — the MCP twin of the `data` seam.
       */
      mcp?: McpEffectResolver;
      /**
       * Host sink for `(declare/expose …)` (node D4). Threaded straight to
       * `buildArrivalEnv` so each declaration that evaluates during the run hands
       * the host its typed {@link OnExpose} declaration (name + evaluated schemas +
       * the JS-bridged handler) — the seam the host's exposed-function INVOCATION
       * uses to capture a sealed skill's handler from a run, then call it. Absent
       * (the default), the form still evaluates + returns its handler; it just
       * registers nowhere — same "capability optional, verb always present" posture
       * as `infer`/`data`/`import`. Evaluating the form does NOT call the handler
       * (it captures the lambda closure), so a registration run is side-effect-free
       * beyond whatever the file's OTHER top-level forms do.
       */
      onExpose?: OnExpose;
      /**
       * Host override channel for `(define/overridable …)`: name →
       * externally-supplied value (deployment env / caller args). A matching,
       * schema-valid value replaces the hole's default; absent or invalid ⇒ the
       * default. Forwarded straight to `buildArrivalEnv` (which wires the
       * overridable rosetta) — the run-level twin of the same `buildArrivalEnv`
       * option, so a `project.run` exposes the override seam the env already
       * supports. v1 per-name; an in-program per-key table is deferred.
       */
      resolveOverride?: ResolveOverride;
      /** Host hook to inject extra rosettas onto the pipeline env after the
       *  standard ones are wired and before the program runs — e.g. a bridge into
       *  another sandbox. Keeps `.prompt`/`require`/trace machinery intact while
       *  letting a host extend the env's capability surface. */
      extendEnv?: (env: Awaited<ReturnType<typeof buildArrivalEnv>>) => void;
      /**
       * Per-run inference plane override. Each `(infer …)` resolves through this
       * store instead of the project-bound `this.infer` when supplied. Lets ONE
       * run carry a plane the others don't — e.g. the host's MCP path overlays the
       * requesting user's own local-model store ($0, reached through their reverse
       * tunnel) atop the team plane, per-caller, WITHOUT mutating the shared
       * `bindInfer` slot (so concurrent runs keep their own planes). Defaults to
       * `this.infer`; absent ⇒ byte-identical to before.
       */
      infer?: InferStoreLike;
    } & ExecBudget = {},
  ): RunHandle {
    // The per-run reflective budget accumulator behind `(infer/spent)`. Folds the
    // reference cost of each FRESH inference as its cell settles, in evaluation
    // order — so a program's ROI/TCO loop can read what it has paid so far. Local
    // to this run (the `InferStore` is cross-run / shared; "spent THIS run" is not).
    const spend = new RunSpend();

    // The cache-backed infer resolver: find-or-create a task in this project's
    // content-addressed cache, bind the trace, await its result. The rosetta
    // wiring + list-wrapping live in buildArrivalEnv (shared with runTraced +
    // the host); this closure is the project-specific seam.
    const inferAndWait: InferFn = async (ctx, model, prompt, schema, cacheKey, tools, params) => {
      // Tools are part of the inference identity (same messages + different tools =
      // different result) — fold them into the cacheKey so the existing
      // (model,prompt,schema,cacheKey) machinery distinguishes toolsets with no new key
      // dimension. Absent tools ⇒ the original key + bare value, byte-for-byte.
      const hasTools = tools !== undefined && tools.length > 0;
      const key = inferIdentityKey(cacheKey, tools, params);
      // Two short-circuit maps, consulted before any inference — counterfactual
      // first (it supplies NEW values), then the replay log (RECORDED values):
      //   - tweaks: keyed by the UNTAGGED content tuple (the legacy hypothesis surface).
      //   - effectLog: keyed by the kind-TAGGED effect key (the all-kinds replay surface).
      // A hit on either skips the LLM entirely (the whole point of replay/branch).
      const tweakKey = JSON.stringify([model, prompt, schema, key]);
      const tweak = opts.tweaks?.get(tweakKey);
      if (tweak !== undefined) return reviveInfer(tweak, hasTools); // buildArrivalEnv wraps to a list
      const effectKeyStr = inferEffectKey(model, prompt, schema, key);
      const replayed = opts.effectLog?.get(effectKeyStr);
      if (replayed !== undefined) {
        // Replay still records the effect (the key sequence is part of the run's
        // identity) and marks the trace node as a cached provenance point — so a
        // replayed run's trace/graph is shaped identically to the original.
        opts.onEffect?.(effectKeyStr);
        opts.onEffectResult?.(effectKeyStr, replayed);
        const inv = ctx?.currentInvocation;
        if (inv && opts.trace) {
          opts.trace.markInferCached(inv as never, true);
          opts.trace.markProvenancePoint(inv as never);
        }
        return reviveInfer(replayed, hasTools);
      }
      // Single-flight cell: the first call for this content tuple starts the
      // backend; later identical calls ride the same cell. Acquire keeps it alive;
      // release lets the last holder abort a superseded run. `tools` rides on the spec
      // (the backend sends them); identity is already in `key`.
      const cell = (opts.infer ?? this.infer).get({ model, prompt, schema, tools, ...params }, key);
      const cached = cell.finished(); // already-settled at bind = served from a prior get this run
      cell.acquire();
      opts.onEffect?.(effectKeyStr);
      const inv = ctx?.currentInvocation;
      let binding: InferBinding | undefined;
      if (inv && opts.trace) {
        binding = new InferBinding(model, prompt, schema, key, cell);
        opts.trace.bindTask(binding, inv as never);
        opts.trace.markInferCached(inv as never, cached);
        // Every (infer …) is a fresh provenance singleton {self.id}.
        opts.trace.markProvenancePoint(inv as never);
      }
      try {
        const completion = await cell.done;
        if (binding) binding.completion = completion; // stamp usage for synchronous cost walk
        // Fold this inference into the reflective budget — fresh calls only (a
        // cache hit cost nothing this run, so it's free; `(infer/spent)` sums what
        // was PAID, never what was saved). Stamped after the await settles, so the
        // value a later `(infer/spent)` reads is order-correct.
        spend.record(model, completion.usage, !cached);
        // Record the settled value into the effect-log sink (its key was already
        // recorded above). A tool-enabled turn records {value, toolCalls} so replay
        // reconstructs the InferString with its calls; a plain infer records the bare
        // value, the same shape replay reads back.
        opts.onEffectResult?.(effectKeyStr, recordInfer(completion, hasTools));
        return freshInfer(completion, hasTools);
      } finally {
        cell.release();
      }
    };

    // `vfs: false` withholds the loader entirely — buildArrivalEnv then omits loader-core, so the
    // run env has no `require`. Otherwise default to the project VFS (the universal case).
    const loader =
      opts.vfs === false ? undefined : (opts.loader ?? (opts.resolver ? loaderFromResolver(opts.resolver) : makeProjectLoader(this)));
    // Data effects cross the same record+replay seam as infer: wrap the host
    // resolver so each (http/*)/(sql/query) consults `effectLog` (replay) and
    // records its tagged key into `.effects`. Absent a host resolver the verbs
    // stay inert (buildArrivalEnv's default), so this is armed only when a `data`
    // capability was supplied.
    const data = opts.data
      ? this.#wrapDataResolver(opts.data, {
          effectLog: opts.effectLog,
          onEffect: opts.onEffect,
          onEffectResult: opts.onEffectResult,
          trace: opts.trace,
        })
      : undefined;
    // MCP crosses the same record+replay seam, but keyed POSITIONALLY (server-tape) —
    // see wrapMcpResolver. Anchored to "" (run scope) for program-initiated calls; the
    // step-2 agentic loop will anchor model-driven calls to the enclosing infer's id.
    const mcp = opts.mcp
      ? wrapMcpResolver(opts.mcp, {
          inferenceId: "",
          effectLog: opts.effectLog,
          onEffect: opts.onEffect,
          onEffectResult: opts.onEffectResult,
        })
      : undefined;
    // Env construction is async (capability lowering + DAG assembly). Build it behind a promise so
    // the handle is still returned SYNCHRONOUSLY; `extendEnv` + the heap bound run once the env exists.
    const envPromise = (async () => {
      const env = await buildArrivalEnv({
        name: "arrival-chain",
        infer: inferAndWait,
        loader,
        tap: opts.trace,
        dirname: opts.dirname,
        spend,
        data,
        mcp,
        onExpose: opts.onExpose,
        resolveOverride: opts.resolveOverride,
      });
      opts.extendEnv?.(env);
      // Uniform allocation bound: bound the run env ONCE (spans preamble + every user form), so the
      // per-form loop is bounded. `installHeapMeter` is THE one way to bound an env — the studio kernel
      // calls the same primitive on its scope, so neither path is an ad-hoc exception.
      if (opts.heapBudget !== undefined) installHeapMeter(env, opts.heapBudget);
      return env;
    })();
    // The handle is returned SYNCHRONOUSLY; all evaluation runs async behind these promises (no sync
    // eval path). The preamble is evaluated tap-FREE (builtin helpers are trace noise — the unified
    // behaviour, matching what runTraced always did); the user body is then parsed (its forms exposed
    // on the handle for live rendering / uneval) and evaluated FORM-BY-FORM under the trace tap.
    let resolveForms!: (forms: unknown[]) => void;
    let rejectForms!: (err: unknown) => void;
    const userForms = new Promise<unknown[]>((res, rej) => {
      resolveForms = res;
      rejectForms = rej;
    });
    const result = (async () => {
      try {
        const env = await envPromise;
        await exec(BUILTIN_PREAMBLE, { env, signal: opts.signal, budgetMs: opts.budgetMs });
        const forms = await parse(source, env);
        resolveForms(forms);
        let last: unknown = undefined;
        for (const form of forms) {
          last = await execExpr(form, { env, tap: opts.trace, signal: opts.signal, budgetMs: opts.budgetMs });
          if (isThenable(last)) last = await last;
        }
        return last;
      } catch (err) {
        rejectForms(err); // a preamble/parse failure also rejects the userForms promise
        throw err;
      }
    })();
    result.catch(() => {}); // consumers attach handling via the handle; never an unhandled rejection
    userForms.catch(() => {});
    const finished = result.then((last) => schemeToJs(last, {}));
    return new RunHandle(userForms, finished, result, envPromise);
  }

  /**
   * Wrap a host {@link DataEffectResolver} with the effect-log record+replay seam,
   * so `(http/*)` / `(sql/query)` cross the SAME membrane as `(infer …)`:
   *   - REPLAY: a kind-tagged key present in `effectLog` short-circuits with the
   *     recorded value — zero external hits. (The same partial-invalidation a
   *     subtracted log gives infer applies to data effects for free.)
   *   - RECORD: the tagged key is reported via `onEffect` (→ `Run.effects`) and the
   *     settled value via `onEffectResult` (→ the effect-log collector).
   *   - PROVENANCE: the effect's invocation is marked a provenance point and bound
   *     to a {@link DataBinding}, so it becomes a node in the causal graph and the
   *     forward-cone reaches it (A3 registers the verbs without provenance marking;
   *     marking lands HERE, where the effect-log lives, so data effects are first-class
   *     cone members exactly like infers).
   *
   * Inert when no `effectLog` and no recording sinks AND no trace — provenance is still
   * marked so the graph is correct; the wrap is cheap.
   */
  #wrapDataResolver(
    inner: DataEffectResolver,
    seam: {
      effectLog?: EffectLog;
      onEffect?: (effectKey: string) => void;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      trace?: EvalTrace;
    },
  ): DataEffectResolver {
    return async (ctx, effect) => {
      const key = dataEffectKey(effect);
      const inv = (ctx as { currentInvocation?: unknown } | undefined)?.currentInvocation;
      // Make the data effect a first-class causal node: a provenance point bound to
      // a DataBinding, so `effectKeysByInvocation` resolves its id → this key and
      // the forward-cone reaches it (replay marks the same, so a replayed run's
      // graph matches the original).
      const mark = (): void => {
        if (inv && seam.trace) {
          seam.trace.bindTask(new DataBinding(effect, key), inv as never);
          seam.trace.markProvenancePoint(inv as never);
        }
      };
      const replayed = seam.effectLog?.get(key);
      if (replayed !== undefined) {
        seam.onEffect?.(key);
        seam.onEffectResult?.(key, replayed);
        mark();
        return JSON.parse(replayed) as DataEffectResult;
      }
      seam.onEffect?.(key);
      mark();
      const value = await inner(ctx, effect);
      seam.onEffectResult?.(key, JSON.stringify(value ?? null));
      return value;
    };
  }

  /**
   * Reverse-membrane entry: evaluate a named `(define …)` from `file`
   * with supplied `args`. Mints an apiCall Run under that file's Program,
   * populated with the version snapshot, input, effect references as they
   * fire, and final output. Returns the Run synchronously so the API layer
   * can hand its id back to the client immediately.
   *
   * `data` arms the data-effect verbs with a credentialed host resolver (the
   * host's Runner DO supplies one; absent, `(http/*)`/`(sql/query)` are inert).
   * `effectLog` replays a recorded log (zero external hits) — re-invoking a past
   * run deterministically. `onEffectResult` lets the host collect THIS run's
   * effect-log in one pass (feed `effectLogCollector().record`) to persist for a
   * future replay.
   */
  invoke(opts: {
    id: string;
    file: string;
    name: string;
    args: readonly unknown[];
    data?: DataEffectResolver;
    mcp?: McpEffectResolver;
    effectLog?: EffectLog;
    onEffectResult?: (effectKey: string, valueJson: string) => void;
  }): Run {
    const program = this.files.get(opts.file);
    invariant(program, `Project.invoke: file "${opts.file}" not found`);
    invariant(!program.apiCalls.has(opts.id), `Project.invoke: id "${opts.id}" already exists`);

    // Snapshot the WHOLE project's version-set at admission — not just the entry.
    // The run binds this cut for its duration (the loader reads it), so a
    // concurrent edit to a `(require)`d library can't tear the in-flight run and
    // a later hypothesis replays the identical bytes. This is "live draft v1"
    // done right: latest pinned at invoke-start, the minimal stand-in for a
    // frozen projectRelease.
    const versionSet = this.captureVersionSet();
    const run = new Run();
    this.transact(() => {
      program.apiCalls.set(opts.id, run);
      run.versionIndex = program.versions.length - 1;
      run.versionSetJson = JSON.stringify(Object.fromEntries(versionSet));
      run.hasInput = true;
      run.name = opts.name;
      run.argsJson = JSON.stringify(opts.args);
      run.startedAt = Date.now();
      run.status = "pending";
    });

    // Pin the entry body to the snapshot too (the entry IS in versionSet), so the
    // body and every transitive require come from the same cut.
    const body = program.versions[versionSet.get(opts.file)!]?.source ?? "";
    const loader = makeProjectLoader(this, versionSet);
    void this.#executeRun(run, body, opts.name, opts.args, {
      loader,
      data: opts.data,
      mcp: opts.mcp,
      effectLog: opts.effectLog,
      onEffectResult: opts.onEffectResult,
    });
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
      this.transact(() => {
        draft.source = opts.source;
      });
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
    this.transact(() => {
      program.draft = null;
    });
  }

  /**
   * Forward-membrane entry: studio is re-evaluating the draft of a file.
   * Mints a sandbox Run under the file's Draft (auto-creates the draft
   * if missing). Returns the Run + the finished promise.
   */
  sandboxRun(opts: { id: string; file: string; trace?: EvalTrace; resolver?: RequireResolver }): {
    run: Run;
    finished: Promise<unknown>;
  } {
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
    const finished = this.#executeSandbox(run, body, opts.trace, opts.resolver, dirOf(opts.file));
    return { run, finished };
  }

  async #executeRun(
    run: Run,
    body: string,
    name: string,
    args: readonly unknown[],
    opts: {
      loader?: Loader;
      data?: DataEffectResolver;
      mcp?: McpEffectResolver;
      effectLog?: EffectLog;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
    } = {},
  ): Promise<void> {
    // Failure is already recorded on the Run by #runIntoRun; swallow here
    // so the void-call from invoke() doesn't produce an unhandled rejection.
    try {
      const { source, bindArgs } = this.#callForm(name, args);
      await this.#runIntoRun(run, `${body}\n${source}`, { ...opts, extendEnv: bindArgs });
    } catch {
      /* recorded on run.output */
    }
  }

  async #executeSandbox(
    run: Run,
    body: string,
    trace?: EvalTrace,
    resolver?: RequireResolver,
    dirname?: string,
  ): Promise<unknown> {
    return this.#runIntoRun(run, body, { trace, resolver, dirname });
  }

  async #runIntoRun(
    run: Run,
    source: string,
    opts: {
      trace?: EvalTrace;
      resolver?: RequireResolver;
      loader?: Loader;
      dirname?: string;
      tweaks?: Map<string, string>;
      effectLog?: EffectLog;
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      data?: DataEffectResolver;
      mcp?: McpEffectResolver;
      /** Binds the entry call's already-parsed args into the run env (see #callForm). */
      extendEnv?: (env: Awaited<ReturnType<typeof buildArrivalEnv>>) => void;
    } = {},
  ): Promise<unknown> {
    try {
      const value = await this.run(source, {
        ...opts,
        onEffect: (effectKey) => {
          // Each effect key appended in its own micro-transact so peers
          // see the trace grow as it happens (not just on finish).
          this.transact(() => run.effects.push(effectKey));
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
   * `versionIndex` snapshot — not the file's latest — AND every `(require)`d
   * file is read at the Run's `versionSet` snapshot, so a MULTI-file hypothesis
   * stays faithful even if any file (entry OR a transitive library) has since
   * been edited. (Without the version-set, the entry was pinned but a required
   * library replayed at latest — the multi-file replay tear A7 closes.)
   *
   * Optional `effectLog` replays the original run's RECORDED effects (zero external
   * hits) while `tweaks` branches chosen ones — together they are deterministic
   * replay + counterfactual in one pass. Pass a FULL log to reproduce exactly; pass
   * `invalidateForwardCone(fullLog, run-trace, [changedNode])` to re-run only the
   * changed node's blast radius and replay the rest (the cheap "what changed if I
   * edit just here" path).
   */
  runHypothesis(opts: {
    id: string;
    run: Run;
    tweaks: Map<string, string>;
    /** Recorded-effect replay log (kind-tagged key → value JSON). See above. */
    effectLog?: EffectLog;
  }): { hypothesis: Hypothesis; finished: Promise<unknown> } {
    const run = opts.run;
    invariant(!run.hypotheses.has(opts.id), `Project.runHypothesis: id "${opts.id}" already exists`);
    // Run.parent is Program (apiCall) or Draft (sandbox). Hypothesis replay needs
    // the Program — its versions[] is what the pinned versionIndex addresses.
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
    const call = run.hasInput ? this.#callForm(run.name, run.args) : undefined;
    const source = call ? `${body}\n${call.source}` : body;
    // Replay every `(require)` at the Run's pinned version-set, so a transitive
    // library is read at the bytes the original saw. An empty set (a Run minted
    // before A7, or one with no captured files) falls back to the default loader
    // — that Run replays exactly as it did before: entry pinned, requires latest.
    const versionSet = run.versionSet;
    const loader = versionSet.size > 0 ? makeProjectLoader(this, versionSet) : undefined;
    const finished = (async () => {
      try {
        const value = await this.run(source, {
          loader,
          tweaks: opts.tweaks,
          effectLog: opts.effectLog,
          ...(call ? { extendEnv: call.bindArgs } : {}),
          onEffect: (effectKey) => this.transact(() => hypothesis.effects.push(effectKey)),
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
    invariant(!draft.sandbox.has(opts.id), `Project.sandboxRunTraced: id "${opts.id}" already exists`);

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
      // Entry's own dir, so a relative `(require "lib.scm")` in a subdir file
      // resolves against the file's folder, not the project root.
      dirname: dirOf(opts.file),
      onEffect: (effectKey) => this.transact(() => run.effects.push(effectKey)),
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

  /**
   * The reverse-membrane entry call `(name arg0 arg1 …)`. The args crossed the API boundary as
   * already-parsed JSON, and arrival-scheme is platonic — a value inside the program is never a
   * string awaiting `parse`. So instead of round-tripping through a `(json/parse "…")` verb, bind
   * each arg DIRECTLY into the run env (jsToScheme) under a generated symbol and reference it. Returns
   * the call source plus the binder to thread through `extendEnv` (the same mechanism `require/call`
   * uses for its single arg).
   */
  #callForm(name: string, args: readonly unknown[]): { source: string; bindArgs: (env: Environment) => void } {
    const syms = args.map((_, i) => `__arg${i}__`);
    return {
      source: `(${name}${syms.length > 0 ? ` ${syms.join(" ")}` : ""})`,
      bindArgs: (env) => args.forEach((a, i) => void env.set(syms[i]!, jsToScheme(a))),
    };
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
      /** Set `false` to assemble a no-require env (see `run`). The teleological replay sets it so
       *  the provenance re-run matches the loader-less causal run. */
      vfs?: boolean;
      /** Directory of the entry module, for resolving relative `(require …)`. */
      dirname?: string;
      /** Extend the run env after build (e.g. `require/call` binds its argument). Forwarded to `run`. */
      extendEnv?: (env: Awaited<ReturnType<typeof buildArrivalEnv>>) => void;
      /** Called with the kind-tagged effect key for every external effect (infer/
       *  http/sql) as it fires — the `.effects` recorder, same as `run`. */
      onEffect?: (effectKey: string) => void;
      /** Called when an effect settles with its value: `(taggedKey, valueJson)`
       *  — feed an `effectLogCollector().record` to build the run's log. */
      onEffectResult?: (effectKey: string, valueJson: string) => void;
      /** Counterfactual infer overrides keyed by the UNTAGGED content tuple. */
      tweaks?: Map<string, string>;
      /** Deterministic-replay log (kind-tagged key → value JSON); a hit short-
       *  circuits the external call. See `run`'s `effectLog`. */
      effectLog?: EffectLog;
      /** Host data-effect resolver for `(http/*)` / `(sql/query)`; wrapped with the
       *  same record+replay seam as `run`. Inert when absent. */
      data?: DataEffectResolver;
    } & ExecBudget,
  ): Promise<{ userForms: unknown[]; finished: Promise<unknown>; env: Environment; result: Promise<unknown> }> {
    // SHORTHAND for run() + a guaranteed trace. run() is the universal gateway: the inferAndWait /
    // env build / preamble-tap-free / per-form-loop that this method used to DUPLICATE now lives ONLY
    // there. runTraced just ensures a trace and adapts the RunHandle back to this method's historical
    // `{ userForms (resolved), finished, env, result }` contract — so every existing caller is
    // unchanged. (The previously data-only traced env is now the full capability env; capabilities a
    // caller doesn't pass stay inert, so behaviour is preserved.)
    const h = this.run(source, { ...opts, trace: opts.trace });
    return { userForms: await h.userForms, finished: h.finished, env: await h.env, result: h.result };
  }
}

/**
 * Built-in scheme bindings that every Project.run() program gets,
 * before any user (require ...) preambles. Defines the chat-message
 * constructors and the schema-DSL helpers. Keeping these in the
 * runtime (instead of forcing every program to `(require "_lib.scm")`)
 * keeps short programs short and makes the DSL feel native.
 */
export const BUILTIN_PREAMBLE = `
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
;; \`(require "x.json")\` produces JS objects (SchemeJSObject), parsed at the
;; loader membrane. Three equivalent ways to read a field:
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

;; ── superpowered define family ─────────────────────────────────────────
;; These are AUTHORING macros that expand to a plain (define name (<rosetta> …))
;; so the interpreter core only ever sees \`define\` + an ordinary call — no
;; domain (expose/override) concept lives in the pure dataflow core. The name
;; binds and is usable in-program normally; the superpower (host registration +
;; override resolution) is additive, host-side, via the rosetta.
;;
;; (define/overridable name default schema)
;;   → name resolves to a host override (if present AND it validates) else the
;;     default; registers {name, schemaTag, default} with the host.
(define-macro (define/overridable name default schema)
  \`(define ,name (overridable/declare (symbol->string (quote ,name)) ,default ,schema)))
;;
;; (define/exposed name :k v … body)
;;   → registers an expose declaration (keyed by name) on the same sink as
;;     declare/expose; the function stays callable in-program. The clauses split
;;     into leading \`:keyword value\` pairs (passed through verbatim — e.g.
;;     :input/:output/:meta schemas) and a trailing body, which becomes the
;;     :handler. With no schema slots the reachable-overridable derivation still
;;     supplies the argument surface statically. Lowers directly to declare/expose
;;     (one runtime head; the form's value is the handler so the name binds).
(define-macro (define/exposed name . clauses)
  (let* ((body (car (reverse clauses)))
         (kwargs (reverse (cdr (reverse clauses)))))
    \`(define ,name (declare/expose (symbol->string (quote ,name)) ,@kwargs :handler ,body))))
;;
;; (define/mcp name :description "…" :aliases '(alt …) <handler>)
;;   → declares an MCP CATALOG PRIMITIVE (name + description + aliases) on the onMcp
;;     sink; the verb stays callable in-program. Same kwargs+handler shape as
;;     define/exposed. :aliases is a quoted name list — bound but never cataloged.
;;     Lowers directly to mcp/declare.
(define-macro (define/mcp name . clauses)
  (let* ((body (car (reverse clauses)))
         (kwargs (reverse (cdr (reverse clauses)))))
    \`(define ,name (mcp/declare (symbol->string (quote ,name)) ,@kwargs :handler ,body))))
;;
;; (run/continue-after-approval spec result)
;;   → THUNKS result (does NOT evaluate it until approved — the irreversible
;;     action isn't run before permission lands), hands a request to the host,
;;     awaits a human verdict, then runs the thunk and returns the (possibly
;;     human-edited) go-token. Rejection fails the branch. With no approver
;;     wired the request auto-approves immediately (local runs never block).
(define-macro (run/continue-after-approval spec result)
  \`(approval/await ,spec (lambda () ,result)))
`;
