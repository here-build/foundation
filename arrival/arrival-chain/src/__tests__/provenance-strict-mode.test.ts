/**
 * Regression: marking a provenance point must go through a MobX action.
 *
 * `infer`/`infer/chat` are `provenancePoint: true` rosettas (project.ts). With a
 * trace active, the arrival-scheme rosetta wrapper marks the call's invocation by
 * flipping `Invocation.isProvenancePoint`. The Invocation is a MobX observable and
 * the studio renders the graph via `mobx-react`, so the flag is OBSERVED — MobX's
 * `enforceActions: "observed"` then rejects a BARE write to it (V's in-app error:
 * "changing (observed) observable values without using an action is not allowed …
 * Invocation.isProvenancePoint"). The throw was swallowed into infer's
 * either-return, breaking the graph.
 *
 * The fix routes the write through `Invocation.markProvenancePoint()`. The
 * load-bearing property is that this method is a MobX ACTION — only then is the
 * write legal under strict-mode. Strict-mode enforcement only fires with a live
 * reactive observer (the studio's React renderer), which a node suite doesn't
 * have, so we assert the property that makes the studio safe directly: the method
 * is an action.
 */
import { isAction } from "mobx";
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { EvalTrace, type Invocation } from "../trace.js";

describe("provenance marking under MobX strict-mode", () => {
  it("Invocation.markProvenancePoint is a MobX action (so the wrapper's write is strict-mode-safe)", async () => {
    // A real (MobX-observable) Invocation from a trivial traced run.
    const project = ArrivalChain.bootstrap(new Project()).root;
    const trace = new EvalTrace();
    await project.run(`(+ 1 2)`, { trace });
    const inv = [...trace.records.values()].flatMap((r) => [...r.bindings])[0] as Invocation;
    expect(inv).toBeDefined();

    // The guard: `makeAutoObservable` must keep this method an action. If a future
    // change makes it a plain method (or the wrapper reverts to a bare write), the
    // studio's observed write throws again — caught here.
    expect(isAction(inv.markProvenancePoint)).toBe(true);

    inv.markProvenancePoint();
    expect(inv.isProvenancePoint).toBe(true);
  });
});
