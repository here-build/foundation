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
 *   - ordered references to every inference that fired during it
 *     (the trace — survives reload, replicates to peers)
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
 * `inferences` records the ordered references for this re-run (same
 * shape as the parent Run's), so the trace UI works identically.
 */
@syncing("ArrivalChainHypothesis")
export class Hypothesis extends PlexusModel<Run> {
  @syncing accessor tweaksJson: string = "{}";

  /** Inferences fired during the hypothesis re-execution. */
  /**
   * Ordered canonical-tuple-string keys identifying every `(infer …)` call
   * fired during this run/hypothesis. Each key is
   * `JSON.stringify([model, prompt, schema, cacheKey])` — the same shape the
   * `InferStore` content key uses. To resolve a live cell, look up the
   * tuple in the bound `InferStore`. The inference plane is host-local (not
   * synced), so we hold the lookup key here instead of a cross-doc ref.
   */
  @syncing.list accessor inferences: string[] = [];

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
  /** Index into the parent Program's `versions[]` that was executing. */
  @syncing accessor versionIndex: number = -1;

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
   * Ordered canonical-tuple-string keys identifying every `(infer …)` call
   * fired during this run/hypothesis. Each key is
   * `JSON.stringify([model, prompt, schema, cacheKey])` — the same shape the
   * `InferStore` content key uses. To resolve a live cell, look up the
   * tuple in the bound `InferStore`. The inference plane is host-local (not
   * synced), so we hold the lookup key here instead of a cross-doc ref.
   */
  @syncing.list accessor inferences: string[] = [];

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
