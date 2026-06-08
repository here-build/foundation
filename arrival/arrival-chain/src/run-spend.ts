import type { TokenUsage } from "./model.js";
import { referenceCost } from "./pricing.js";

/**
 * The reflective budget accumulator behind `(infer/spent)`.
 *
 * `(infer/spent)` is a fold over the run's OWN prior inference costs — the one
 * symbol a program needs to do ROI/TCO stopping ("calc the ROI of the last turn;
 * stop if it's economically bad"). It is **reflective-impure**, not world-impure:
 * its value is `sum(map(cost, inferences-settled-so-far))`, a pure function of the
 * program's own inference history under a fixed evaluation order. Contrast a
 * world-impure read like `(time)` / `(random)`, which depends on something OUTSIDE
 * the program's causal closure and so breaks replay; `(infer/spent)` reads only
 * what the run itself already produced, so given a pinned model + seed the value at
 * every read is reproducible — the cache replays the same completions, the fold
 * sums the same costs.
 *
 * Determinism is therefore FREE at the only reads that MEAN anything. A meaningful
 * read sits at a sequence point: an ROI-stopping loop is intrinsically a fold (read
 * `spent`, decide, recurse-or-stop), and its data-dependency on the prior turn's
 * result pins the evaluation order — `spent` is read AFTER that turn settled, never
 * racing it. A read placed inside a parallel `map` arm is the meaningless case:
 * "spent relative to which sibling?" has no answer when the arms settle
 * concurrently and out of order. So the racy case IS the meaningless case — we do
 * not serialize the fan to make it well-defined; we flag the read as a mistake (see
 * `lintRacyReads`). No machinery defends a number nobody can read meaningfully.
 *
 * COST BASIS: `referenceCost` — the same per-`referenceCost` valuation `run-cost.ts`
 * uses for the `spent` line of a `RunCost`. This is the **reference** cost (tokens ×
 * the price map), NOT the billing wallet: the budget plane `(infer/spent)` serves
 * is the program's own ROI economics, deliberately distinct from (a) the wallet's
 * hard money floor and (b) an api-token's delegated sub-limit. The wallet never
 * enters the scheme sandbox; this accumulator reads only what the inference plane
 * already knows (model + token usage), so the membrane is preserved.
 *
 * CACHE HITS ARE FREE: a call served from cache (single-flight dedup OR cross-run
 * replay) cost nothing this run, so it adds nothing to `spent` — exactly the
 * `spent` (paid) vs `saved` (cache-covered) split in `RunCost`. A program folds
 * over what it actually PAID, never over what it SAVED.
 *
 * RESERVE LEVEL: this is the accumulator + the namespace it backs, no runtime trap.
 * Enforcement ("stop when too expensive") is the BASE CASE of the user's own
 * reduce/TCO loop — read `spent`, decide, don't recurse — not an exception the host
 * throws. The stop renders in the trace as an ordinary economic branch node
 * (`roi(0.3) < threshold → stop`), legible like any other `if`.
 */
export class RunSpend {
  /** USD (reference) paid by FRESH inferences settled so far in this run. */
  #spent = 0;
  /** Count of fresh inferences folded in — diagnostics / `(infer/calls)` headroom. */
  #calls = 0;

  /**
   * Fold one settled inference into the running total. Called by the host's infer
   * closure the moment a cell resolves with usage, in evaluation order.
   *
   * `fresh` mirrors `RunCost`'s paid/saved split: a cache hit (`fresh === false`)
   * cost nothing this run and contributes 0 — the program folds over spend, not
   * savings. A backend that reports no `usage` (a pure stub) likewise contributes
   * 0: there is no cost fact to count.
   */
  record(model: string, usage: TokenUsage | undefined, fresh: boolean): void {
    if (!fresh || !usage) return;
    this.#spent += referenceCost(model, usage);
    this.#calls += 1;
  }

  /** Reference USD paid so far this run — the value `(infer/spent)` returns. */
  spent(): number {
    return this.#spent;
  }

  /** Fresh (paid) inferences folded so far — the value `(infer/calls)` returns. */
  calls(): number {
    return this.#calls;
  }
}
