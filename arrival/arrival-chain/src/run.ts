/**
 * Run — a unit of execution on a file. Two flavours, same shape:
 *
 *   apiCalls — reverse-membrane: external client POSTed /invoke {name, args}.
 *              `input` is set; `output` is the named define's return value.
 *
 *   sandbox  — forward-membrane: studio re-evaluated the whole file (typed,
 *              reloaded, idle-debounced). `input` is null; `output` is the
 *              program's last value.
 *
 * Every Run records:
 *   - which `Program.versions[]` index was executing (provenance)
 *   - ordered references to every EXTERNAL EFFECT that fired during it —
 *     infer / http / sql (the trace — survives reload, replicates to peers).
 *     Zipped with the recorded values they form the per-run effect-log: bind
 *     the full log to replay deterministically (zero external hits), or bind
 *     the log minus a changed node's forward-cone to partially re-run.
 *   - hypotheses: counterfactual replays substituting some infer results
 *     with chosen values, to explore "what if this LLM said X instead?"
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, syncing } from "@here.build/plexus";

import type { Draft } from "./draft.js";
import type { Program } from "./program.js";

export type RunStatus = "pending" | "resolved" | "failed";

@syncing("ArrivalChainRunResult")
export class RunResult extends PlexusModel<Run | Hypothesis> {
  @syncing accessor valueJson: string = "null";
  get value(): unknown {
    return JSON.parse(this.valueJson);
  }
}

@syncing("ArrivalChainRunError")
export class RunError extends PlexusModel<Run | Hypothesis> {
  @syncing accessor message: string = "";
}

/**
 * Render a thrown error into a RunError message for the studio's run-error
 * surface. A `SchemeError` contributes its formatted scheme stack (the
 * `file:line` frames, via `toString()`); a `requireChain` (annotated by the
 * loader when a throw escapes a required module — entry → failing module) is
 * appended. Plain errors fall back to `.message`. Duck-typed (`schemeStack` /
 * `requireChain`) so this stays free of an arrival-scheme import.
 */
export function formatRunError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = "schemeStack" in error ? error.toString() : error.message;
  const chain = (error as { requireChain?: unknown }).requireChain;
  return Array.isArray(chain) && chain.length > 0 ? `${base}\n\nrequire chain: ${chain.join(" → ")}` : base;
}

/**
 * Counterfactual replay of a Run with chosen inference overrides.
 *
 * `tweaks` keys are the canonical JSON-stringified content tuples
 * `[model, prompt, schema, cacheKey]` (the same shape the `InferStore`
 * content key uses). During re-execution any `(infer …)` call whose content
 * tuple matches a tweak key short-circuits with the tweak value, bypassing
 * the LLM. Non-matching calls flow through the store as normal — so a
 * hypothesis that only branches at one point reuses every prior cell.
 *
 * `effects` records the ordered effect keys for this re-run (same shape as
 * the parent Run's), so the trace UI works identically.
 */
@syncing("ArrivalChainHypothesis")
export class Hypothesis extends PlexusModel<Run> {
  @syncing accessor tweaksJson: string = "{}";

  /**
   * Ordered kind-tagged effect keys identifying every EXTERNAL effect — every
   * `(infer …)`, `(http/*)`, `(sql/query)` — fired during this re-run. Each key
   * is `JSON.stringify([kind, ...payload])` (see `effect-log.ts`); the infer
   * payload is `[model, prompt, schema, cacheKey]`, the same content tuple the
   * `InferStore` keys by. The tag keeps the per-kind key spaces disjoint so an
   * http/sql effect never aliases an infer with identical content. To resolve a
   * live infer cell, strip the tag and look the tuple up in the bound
   * `InferStore`. The effect plane is host-local (not synced), so we hold the
   * lookup keys here instead of cross-doc refs.
   */
  @syncing.list accessor effects: string[] = [];

  @syncing.child accessor output: RunResult | RunError | null = null;
  @syncing accessor status: RunStatus = "pending";
  @syncing accessor startedAt: number = 0;
  @syncing accessor finishedAt: number = 0;

  /** Decoded tweak map: tupleKey → overrideValueJson. */
  get tweaks(): Map<string, string> {
    const obj = JSON.parse(this.tweaksJson) as Record<string, string>;
    return new Map(Object.entries(obj));
  }
}

@syncing("ArrivalChainRun")
export class Run extends PlexusModel<Program | Draft> {
  /** Index into the parent Program's `versions[]` that was executing —
   *  the ENTRY file's pin. (For the whole-project pin a multi-file run needs,
   *  see `versionSetJson` below; this stays the entry's index for back-compat
   *  and the hypothesis-replay path that addresses the parent Program directly.) */
  @syncing accessor versionIndex: number = -1;

  /**
   * The version-set snapshot captured at invoke-start: a `{path → versionIndex}`
   * map over EVERY file in the project, JSON-encoded. This is what makes a
   * multi-file run deterministic — the replay loader (`runHypothesis`) reads this
   * map, not each file's `versions.at(-1)`, so a `(require)`d library is replayed
   * at the exact version the original run saw even if the file has since been
   * edited (the entry-only `versionIndex` pin couldn't cover transitive requires).
   *
   * Empty (`"{}"`) on sandbox/draft Runs: those run against the live head by
   * design, so there's no frozen cut to record. Decode via `versionSet`.
   */
  @syncing accessor versionSetJson: string = "{}";

  /** Decoded version-set: path → pinned versions[] index. The replay loader
   *  (`makeProjectLoader(project, run.versionSet)`) serves exactly these. */
  get versionSet(): Map<string, number> {
    const obj = JSON.parse(this.versionSetJson) as Record<string, number>;
    return new Map(Object.entries(obj));
  }

  /**
   * Reverse-membrane Runs have an input (file + name + args); sandbox
   * Runs are whole-file replays and leave this null. The file path is
   * the parent Program's key in `Project.files`, so it isn't duplicated
   * here — read via `run.parent.parent.findFilePath(run.parent)`.
   */
  @syncing accessor name: string = "";
  @syncing accessor argsJson: string = "[]";
  /** True for apiCalls (has input); false for sandbox (whole-file). */
  @syncing accessor hasInput: boolean = false;

  /**
   * Ordered kind-tagged effect keys identifying every EXTERNAL effect — every
   * `(infer …)`, `(http/*)`, `(sql/query)` — fired during this run. Each key is
   * `JSON.stringify([kind, ...payload])` (see `effect-log.ts`); the infer payload
   * is `[model, prompt, schema, cacheKey]`, the same content tuple the
   * `InferStore` keys by. The tag keeps the per-kind key spaces disjoint so an
   * http/sql effect never aliases an infer with identical content. To resolve a
   * live infer cell, strip the tag and look the tuple up in the bound
   * `InferStore`. The effect plane is host-local (not synced), so we hold the
   * lookup keys here instead of cross-doc refs — zipped with the recorded values
   * they ARE the per-run effect-log (the deterministic-replay / partial-
   * invalidation substrate).
   */
  @syncing.list accessor effects: string[] = [];

  @syncing.child accessor output: RunResult | RunError | null = null;
  @syncing accessor status: RunStatus = "pending";
  @syncing accessor startedAt: number = 0;
  @syncing accessor finishedAt: number = 0;

  @syncing.child.map accessor hypotheses: Map<string, Hypothesis> = new Map();

  get args(): unknown[] {
    const v = JSON.parse(this.argsJson);
    return Array.isArray(v) ? v : [];
  }
}
