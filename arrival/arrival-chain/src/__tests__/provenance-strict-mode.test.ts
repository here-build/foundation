/**
 * Regression: the trace's hot machinery must stay PLAIN (non-observable).
 *
 * History: `Invocation` was a MobX observable, so the rosetta wrapper's flip of
 * `isProvenancePoint` was an OBSERVED write and `enforceActions: "observed"`
 * rejected it (V's in-app error: "changing (observed) observable values without
 * using an action is not allowed … Invocation.isProvenancePoint"). The earlier fix
 * routed the write through a MobX action.
 *
 * That whole class of bug — and a far worse one — is now gone by making the trace's
 * hot objects plain. A deep TCO loop mints one Invocation per recursion step (tens
 * of thousands); a per-object MobX administration cost ~186MB of pure admin + O(n²)
 * provenance Sets and GC-froze the tab. The sole reactive signal renderers need is
 * the `EvalTrace.entries` box; per-invocation fields are read off the PLAIN snapshot
 * the rebuild takes. So `isProvenancePoint` is a plain field flipped by a plain
 * method — no observed write, no strict-mode concern, no admin overhead.
 *
 * This test guards the de-MobX invariant: if a future change re-introduces
 * `makeAutoObservable` on `Invocation`, it resurrects BOTH the strict-mode throw and
 * the memory blowup — caught here.
 */
import { isObservable } from "mobx";
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { EvalTrace, type Invocation } from "@here.build/arrival-provenance";

describe("trace hot machinery stays plain (non-observable)", () => {
  it("Invocation is a plain object; marking a provenance point is a bare, safe write", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const trace = new EvalTrace();
    await project.run(`(+ 1 2)`, { trace });
    const inv = [...trace.records.values()].flatMap((r) => [...r.bindings])[0] as Invocation;
    expect(inv).toBeDefined();

    // The guard: the Invocation must NOT be MobX-observable. A future
    // `makeAutoObservable` here brings back the strict-mode throw AND the 186MB
    // deep-loop blowup.
    expect(isObservable(inv)).toBe(false);

    // The write is now plain — no action needed, no observed-write throw.
    inv.markProvenancePoint();
    expect(inv.isProvenancePoint).toBe(true);
  });
});
