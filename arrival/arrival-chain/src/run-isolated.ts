// run-isolated.ts — launch a NAMED program in an isolated run plane.
//
// CAUSAL by default: `Project.run` with NO trace — the cheap sequential reduction that
// returns the VALUE and captures only the effect-log (O(external effects), off the per-reduction tap).
// The TELEOLOGICAL view (the full provenance graph) is built LAZILY on the returned handle, by a
// replay-bound traced re-run, only when `why/where/how/dag` is first asked.
//
// Isolation is structural: the run env (`buildArrivalEnv`) contains NO reflection symbols; the only
// thing crossing back is a wire-safe value. Every run is BUDGETED (wall-clock) and the teleological
// re-run is additionally TRACE-ENTRY-CAPPED — the memory bound the clock can't give. A budget hit /
// stack overflow / trace cap returns a contained outcome, never an OOM of the shared isolate.

import { type InferStoreLike } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";
import type { Environment } from "@here.build/arrival-scheme";
import * as z from "zod";

import { compileExposeSig } from "./compile-expose-sig.js";
import { effectLogCollector, type EffectLog } from "./effect-log.js";
import { extractExpose } from "./extract-expose.js";
import { makeProjectLoader } from "./loader.js";
import type { Project } from "./project.js";
import { ResultHandle } from "./result-handle.js";
import { schemaToZod } from "./schema-to-zod.js";
import { assertWireSafe } from "./wire-safe.js";

/** How a program is read. `"causal"` (the default) returns the value with provenance built lazily-on-ask;
 * `"teleological"` pre-warms the whole derivation eagerly. Invisible in normal use. */
export type Parser = "causal" | "teleological";

/** The reserved identifier `require/call` binds its wire-safe argument to in the isolated run env.
 *  `runNamedCall` appends `(fn <this>)` to the source and binds the arg via `extendEnv` — a direct
 *  env binding, NOT the host `import` registry (the run plane has no host-capability injection). */
const CALL_ARG_SYM = "__require_call_arg__";

function runBudgetMs(): number {
  const raw = typeof process !== "undefined" ? Number(process.env?.ARRIVAL_RUN_BUDGET_MS) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
}

/** Cap on trace entries for a TELEOLOGICAL re-run — the memory bound the wall-clock budget can't give
 *  (the trace retains an Invocation per reduction). Only the provenance re-run pays this; the causal
 *  value run carries no trace. Override with `ARRIVAL_TRACE_MAX`. */
function traceMax(): number {
  const raw = typeof process !== "undefined" ? Number(process.env?.ARRIVAL_TRACE_MAX) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 500_000;
}

/** Per-run ALLOCATION cap (cumulative list cells materialized through `to_array`) for the CAUSAL value
 *  run — the bound the TICK-cadence wall-clock budget can't give, since a native collection op over a
 *  large list (`filter`/`append`) runs as one uninterruptible reduction. Catches the O(K²)-churn
 *  runaway while leaving generous headroom for legitimate linear passes. Override `ARRIVAL_HEAP_MAX`. */
function heapMax(): number {
  const raw = typeof process !== "undefined" ? Number(process.env?.ARRIVAL_HEAP_MAX) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000_000;
}

const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
};

/** Fan-out: combine an UPSTREAM signal (the launching/asking ctx.signal — caller cancellation, parent
 *  run abort, session teardown) with this run's INTERNAL budget-timer controller, so EITHER source
 *  cancels the nested evaluation (and any host requests it spawned). When there's no upstream signal,
 *  the internal one stands alone. */
function fanOut(internal: AbortSignal, upstream?: AbortSignal): AbortSignal {
  return upstream ? AbortSignal.any([upstream, internal]) : internal;
}

async function readSource(project: Project, file: string): Promise<{ path: string; source: string }> {
  const loader = makeProjectLoader(project);
  const path = await loader.resolve(file, "");
  const contents = await loader.read(path);
  const source = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  return { path, source };
}

/** A value standing in for a run that hit its budget. The teleological view is also unavailable (a
 *  timed-out run has no completed derivation). Wire-safe. */
function timeoutValue(budgetMs: number): Record<string, unknown> {
  return { __timeout__: true, budgetMs };
}

/** Is this error a containment (budget / abort / trace cap / stack overflow), vs a genuine error? */
function isContainment(err: unknown): boolean {
  return err instanceof Error && /budget exceeded|abort|maximum call stack/i.test(err.message);
}

/** The CAUSAL value run: cheap (no trace), budgeted + stack-overflow-contained, capturing the
 *  effect-log for a later replay-bound teleological re-run. Returns the value (or a timeout marker)
 *  and whether it finished. */
async function runCausal(
  project: Project,
  source: string,
  extra: { dirname: string; extendEnv?: (env: Environment) => void; signal?: AbortSignal; infer?: InferStoreLike },
): Promise<{ value: unknown; effectLog: EffectLog; finished: boolean }> {
  const { log, record } = effectLogCollector();
  const ac = new AbortController();
  let timedOut = false;
  const budgetMs = runBudgetMs();
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, budgetMs);
  try {
    const done = project.run(source, {
      // No-require run plane: a dereferenced program is self-contained and cannot reach back into
      // the filesystem (`require` is unbound here). The named file itself was already read OUTSIDE
      // this env by readSource — withholding the vfs only bars in-program `(require …)`.
      vfs: false,
      dirname: extra.dirname,
      ...(extra.extendEnv ? { extendEnv: extra.extendEnv } : {}),
      signal: fanOut(ac.signal, extra.signal),
      budgetMs,
      heapBudget: heapMax(),
      onEffectResult: record,
      ...(extra.infer ? { infer: extra.infer } : {}),
    });
    const hardWall = new Promise<"__hard__">((res) => setTimeout(() => res("__hard__"), budgetMs + 500));
    const outcome = await Promise.race([
      done.then((value) => ({ kind: "value" as const, value }), (err: unknown) => ({ kind: "err" as const, err })),
      hardWall.then(() => ({ kind: "hard" as const })),
    ]);
    if (outcome.kind === "value") return { value: outcome.value, effectLog: log, finished: true };
    if (outcome.kind === "hard" || timedOut || (outcome.kind === "err" && isContainment(outcome.err))) {
      return { value: timeoutValue(budgetMs), effectLog: log, finished: false };
    }
    throw (outcome as { err: unknown }).err; // a genuine runtime error — surfaced as a door.
  } finally {
    clearTimeout(timer);
  }
}

/** The TELEOLOGICAL re-run: replay the captured effect-log (no re-fired effects) under a trace, so the
 *  derivation is reconstructed without cost or side effects. Trace-entry-capped; a cap/overflow throws
 *  (caught by ResultHandle as "provenance unavailable"). */
async function runTeleological(
  project: Project,
  source: string,
  extra: { dirname: string; extendEnv?: (env: Environment) => void; effectLog: EffectLog; signal?: AbortSignal },
): Promise<{ trace: EvalTrace; outputNode: unknown }> {
  const trace = new EvalTrace(traceMax());
  const ac = new AbortController();
  const budgetMs = runBudgetMs();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  try {
    const { userForms, finished, result } = await project.runTraced(source, {
      // Same no-require plane as the causal run, so the teleological replay matches it exactly.
      vfs: false,
      trace,
      dirname: extra.dirname,
      ...(extra.extendEnv ? { extendEnv: extra.extendEnv } : {}),
      effectLog: extra.effectLog,
      signal: fanOut(ac.signal, extra.signal),
      budgetMs,
    });
    result.catch(() => {});
    await finished; // replay-bound: fast, no fresh effects. Throws on trace cap / overflow.
    return { trace, outputNode: userForms.at(-1) };
  } finally {
    clearTimeout(timer);
  }
}

/** `(require/eval "file")` — run a named program. Causal by default (value now, provenance lazy);
 *  `parser: "teleological"` pre-warms the provenance view. */
export async function runNamed(
  project: Project,
  file: string,
  parser: Parser = "causal",
  signal?: AbortSignal,
  infer?: InferStoreLike,
): Promise<ResultHandle> {
  const { path, source } = await readSource(project, file);
  const dirname = dirOf(path);
  const { value, effectLog, finished } = await runCausal(project, source, { dirname, signal, infer });
  assertWireSafe(value, `result of (require/eval "${file}")`);
  // The lazy teleological re-run takes the ASKING call's signal (passed to `h.teleological(sig)`),
  // not this launch's — provenance is grasped during a later `(why h)`, under that call's lifecycle.
  const build = finished
    ? (sig?: AbortSignal) => runTeleological(project, source, { dirname, effectLog, signal: sig })
    : undefined;
  return finalize(new ResultHandle(value, build), parser);
}

/** Typed-arg gate for `require/call`, layered ON TOP of the wire-safe floor: if the named fn
 *  declares an input schema (`define/exposed` / `declare/expose`), validate the dict against it
 *  through the SAME `schemaToZod` lowering the `/fn` route uses, and return the validated value.
 *  No declared input ⇒ the dict passes through unchanged (floor only). Pure + handler-free — the
 *  schema slices evaluate in a sandbox via `compileExposeSig`; the fn's body never runs here. */
async function typedCallArg(source: string, file: string, fnName: string, args: unknown): Promise<unknown> {
  const info = (await extractExpose(source).catch(() => [])).find((i) => i.name === fnName);
  if (!info || info.inputSrc === null) return args;
  const { input } = await compileExposeSig(info);
  if (input == null) return args;
  try {
    return schemaToZod(input).parse(args);
  } catch (e) {
    const detail =
      e instanceof z.ZodError
        ? e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : String(e);
    throw new Error(`require/call "${file}" :${fnName}: argument does not match the declared input schema — ${detail}`);
  }
}

/** `(require/call "file" :fn (dict …))` — load + call one named fn with wire-safe args. */
export async function runNamedCall(
  project: Project,
  file: string,
  fnName: string,
  args: unknown,
  parser: Parser = "causal",
  signal?: AbortSignal,
  infer?: InferStoreLike,
): Promise<ResultHandle> {
  assertWireSafe(args, `argument to (require/call "${file}" :${fnName} …)`);
  const { path, source } = await readSource(project, file);
  const dirname = dirOf(path);
  // Floor (wire-safe) then ceiling (declared schema, if any): the bound arg is the validated value.
  const callArg = await typedCallArg(source, file, fnName, args);
  // Append `(fn <arg>)` and bind the (wire-safe, schema-validated) arg directly in the run env — the
  // isolated run plane has no host-capability registry, so the argument crosses as a plain env binding.
  const callSource = `${source}\n(${fnName} ${CALL_ARG_SYM})\n`;
  const extendEnv = (env: Environment): void => void env.set(CALL_ARG_SYM, callArg);
  const { value, effectLog, finished } = await runCausal(project, callSource, { dirname, extendEnv, signal, infer });
  assertWireSafe(value, `result of (require/call "${file}" :${fnName} …)`);
  const build = finished
    ? (sig?: AbortSignal) => runTeleological(project, callSource, { dirname, extendEnv, effectLog, signal: sig })
    : undefined;
  return finalize(new ResultHandle(value, build), parser);
}

/** Pre-warm the teleological view when `parser: "teleological"` — best-effort (a too-large run leaves
 *  the value intact and provenance lazily-unavailable). */
async function finalize(handle: ResultHandle, parser: Parser): Promise<ResultHandle> {
  if (parser === "teleological") {
    try {
      await handle.teleological();
    } catch {
      /* provenance unavailable — the value stands. */
    }
  }
  return handle;
}
