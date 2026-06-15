// result-handle.ts — the handle a `(require/eval …)` / `(require/call …)` hands back to DISCOVERY.
//
// A run is CAUSAL by default (the cheap, sequential reduction — `Project.run`, no trace): the VALUE
// comes back fast and almost always succeeds. Provenance is the TELEOLOGICAL view — the whole
// derivation grasped at once (`why`/`where`/`how`/`dag`) — and it is built LAZILY, by a replay-bound
// traced re-run, only when first asked. A causal run reads the program forward one step at a time;
// a teleological run holds the entire computation as a single object.
//
// The payoff: value-delivery and provenance are independent failure domains. The data path can't be
// taken down by tracing overhead — only the lazy provenance re-run can hit the trace cap, and when it
// does it surfaces a "provenance unavailable here" door while `(result-value h)` still returns the data.

import type { EvalTrace } from "@here.build/arrival-provenance";

const RESULT_HANDLE = Symbol.for("arrival.ResultHandle");

/** A run's value, plus a lazy door to its teleological (provenance) view. Not wire-safe by design. */
export class ResultHandle {
  readonly [RESULT_HANDLE] = true;
  #teleological?: { trace: EvalTrace; outputNode: unknown };
  #error?: Error;

  constructor(
    /** The wire-safe causal value (already wire-safe-checked at the choke). */
    readonly value: unknown,
    /** Lazily builds the trace (a replay-bound teleological re-run), under the ASKING call's signal.
     *  Absent if the causal run didn't finish (a timed-out run has no derivation to grasp). */
    private readonly build?: (signal?: AbortSignal) => Promise<{ trace: EvalTrace; outputNode: unknown }>,
  ) {}

  /** The teleological view: the trace + output node `why`/`where`/`how`/`dag` project. Built once
   *  (memoized). `signal` fans the ASKING call's cancellation into the replay-bound re-run. Throws a
   *  "provenance unavailable" door if the run is too large to trace or never finished — the VALUE is
   *  unaffected. An UPSTREAM abort is NOT memoized (transient — a later ask under a live signal may
   *  succeed); only a genuine too-large/didn't-finish verdict sticks. */
  async teleological(signal?: AbortSignal): Promise<{ trace: EvalTrace; outputNode: unknown }> {
    if (this.#error) throw this.#error;
    if (!this.#teleological) {
      if (!this.build) {
        throw (this.#error = new Error(
          "provenance unavailable: this run did not finish (timed out / too large), so it has no derivation to grasp.",
        ));
      }
      try {
        this.#teleological = await this.build(signal);
      } catch (e) {
        if (signal?.aborted && e instanceof Error && /abort/i.test(e.name + e.message)) {
          throw e; // upstream cancellation — do NOT poison the handle; the value still stands.
        }
        throw (this.#error = new Error(
          `provenance unavailable: the run is too large to trace (${e instanceof Error ? e.message : String(e)}).`,
        ));
      }
    }
    return this.#teleological;
  }
}

export function is_result_handle(v: unknown): v is ResultHandle {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[RESULT_HANDLE] === true;
}
