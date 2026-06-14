import { createInferStore, type ModelSpec, singletonRouter } from "@here.build/arrival-inference";
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { runNamed } from "../run-isolated.js";

// Abort fan-out: a run mints its own budget-timer controller, but an UPSTREAM signal (caller
// cancellation / parent-run abort / session teardown) must ALSO cancel it. runNamed combines the two
// via AbortSignal.any, separately for the causal value run and the lazy teleological re-run.

function projectWith(files: Record<string, string>) {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "" })) })));
  for (const [path, source] of Object.entries(files)) project.addFile(path, source);
  return project;
}

// A loop that would run well past any test timeout if NOT cancelled — proves the upstream abort, not
// the budget, is what stops it (budget here is the default 8s; the test asserts a fast return).
const SLOW = `
(define (spin n) (if (= n 0) 0 (spin (- n 1))))
(spin 100000000)
`;

const FINISHES = `
(define (sum n acc) (if (= n 0) acc (sum (- n 1) (+ acc 1))))
(sum 5 0)
`;

describe("abort fan-out — upstream signal cancels the nested run", () => {
  it("an already-aborted upstream signal contains the causal value run (no runaway, no OOM)", async () => {
    const ac = new AbortController();
    ac.abort(); // caller already cancelled before the run even launches
    const t0 = performance.now();
    const h = await runNamed(projectWith({ "slow.scm": SLOW }), "slow.scm", "causal", ac.signal);
    expect(h.value).toMatchObject({ __timeout__: true }); // contained as a timeout marker
    expect(performance.now() - t0).toBeLessThan(2000); // and FAST — not the 8s budget
  }, 20_000);

  it("upstream abort of the provenance ask does NOT poison the handle (value stands, retry works)", async () => {
    const h = await runNamed(projectWith({ "sum.scm": FINISHES }), "sum.scm");
    expect(h.value).toBe(5); // the causal value is fine

    // Ask for provenance under an already-aborted signal — the lazy re-run is cancelled, surfacing the
    // abort, but the handle is NOT sealed (an upstream abort is transient).
    const aborted = new AbortController();
    aborted.abort();
    await expect(h.teleological(aborted.signal)).rejects.toThrow();

    // A later ask under a live signal rebuilds the teleological view successfully.
    const view = await h.teleological();
    expect(view.trace).toBeDefined();
    expect(view.outputNode).toBeDefined();
  }, 20_000);
});
