/**
 * DAG node A1 — the structured-clone contract for `snapshotTrace`'s output.
 *
 * A later node moves the region build (`traceToRegions` / `planNesting`) into the
 * ELK worker and `postMessage`s a snapshot across the boundary. `postMessage` uses
 * the structured-clone algorithm, so the snapshot must round-trip through
 * `structuredClone` with its load-bearing data intact — above all the invocation
 * `id`s (the later node binds per-cell values back to worker-produced regions by
 * id, so the ids MUST survive).
 *
 * This suite is the executable form of the contract documented in the header of
 * `trace-snapshot.ts`:
 *   1. `structuredClone(snapshot)` does not throw (no functions; cycles tolerated).
 *   2. Every invocation `id` survives, in order.
 *   3. The plain scalar / Set / Map fields (`provenance`, `value`, `metadata`,
 *      `state`, `fieldPointMeta`) survive structurally.
 *   4. The parent/children DAG (including shared refs) is rebuilt faithfully.
 *   5. It PINS the one non-clone-safe field — `node` (a live `Pair`): the clone
 *      loses the prototype and the symbol-keyed `__location__`, so `scopeId`
 *      degrades. This is the exact boundary A2 must project away before posting;
 *      the test documents it rather than papering over it with a false green.
 *   6. It verifies the FIX for that boundary — the pre-derived `scope` string
 *      survives the clone intact (`head@line:col`), where `scopeId(clonedNode)`
 *      degrades; `scope` is the clone-safe carrier the off-thread build keys by.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";
import { snapshotTrace, type PlainTrace } from "@here.build/arrival-provenance";
import { scopeId } from "@here.build/arrival-provenance";

/** A program with the richest snapshot shape: a branch (`if` → branch-child
 *  values), a `define` + `let` (forwarding boundaries), and a `map` loop (the same
 *  body Pair entered three times → loop-body keying, accumulated provenance). No
 *  `infer`, so the backend is never called and the run is fully synchronous. */
const PROGRAM = `
(define (classify x)
  (let ((doubled (* x 2)))
    (if (> doubled 4) doubled 0)))
(map classify '(1 2 3))
`;

async function buildSnapshot(): Promise<PlainTrace> {
  const project = ArrivalChain.bootstrap(new Project()).root;
  // A backend that resolves instantly — nothing in PROGRAM calls it, but binding
  // an infer store mirrors the real run path.
  project.bindInfer(createInferStore(singletonRouter({ complete: async () => ({ value: "unused" }) })));
  const trace = new EvalTrace();
  await project.run(PROGRAM, { trace });
  const snap = snapshotTrace(trace);
  expect(snap.invocations.length).toBeGreaterThan(0);
  return snap;
}

describe("A1 — snapshotTrace is a structured-clone payload for the worker boundary", () => {
  it("structuredClone(snapshot) does not throw", async () => {
    const snap = await buildSnapshot();
    expect(() => structuredClone(snap)).not.toThrow();
  });

  it("preserves every invocation id, in order (the load-bearing cross-boundary key)", async () => {
    const snap = await buildSnapshot();
    const cloned = structuredClone(snap);

    const before = snap.invocations.map((i) => i.id);
    const after = cloned.invocations.map((i) => i.id);
    expect(after).toEqual(before);

    // Ids are a stable, complete handle: every original id resolves in the clone,
    // and a per-id lookup map round-trips 1:1 (this is precisely how a later node
    // re-binds a cell value to its worker-produced region).
    const byIdAfter = new Map(cloned.invocations.map((i) => [i.id, i]));
    expect(byIdAfter.size).toBe(cloned.invocations.length);
    for (const inv of snap.invocations) {
      const twin = byIdAfter.get(inv.id);
      expect(twin, `id ${inv.id} missing after clone`).toBeDefined();
      expect(twin!.id).toBe(inv.id);
    }
  });

  it("preserves the plain scalar / Set fields per invocation", async () => {
    const snap = await buildSnapshot();
    const cloned = structuredClone(snap);
    const byIdAfter = new Map(cloned.invocations.map((i) => [i.id, i]));

    for (const inv of snap.invocations) {
      const twin = byIdAfter.get(inv.id)!;
      expect(twin.state).toBe(inv.state);
      // value/metadata are already plain (lipsToJs-peeled / POJO) → deep-equal.
      expect(twin.value).toEqual(inv.value);
      expect(twin.metadata).toEqual(inv.metadata);
      // provenance is a Set<number> — structured-clone keeps it a real Set with the
      // same members.
      expect(twin.provenance).toBeInstanceOf(Set);
      expect([...twin.provenance].sort()).toEqual([...inv.provenance].sort());
    }
  });

  it("preserves the fieldPointMeta Map", async () => {
    const snap = await buildSnapshot();
    const cloned = structuredClone(snap);
    expect(cloned.fieldPointMeta).toBeInstanceOf(Map);
    expect(cloned.fieldPointMeta.size).toBe(snap.fieldPointMeta.size);
    for (const [k, v] of snap.fieldPointMeta) {
      expect(cloned.fieldPointMeta.get(k)).toEqual(v);
    }
  });

  it("rebuilds the parent/children DAG faithfully (ids + shared refs)", async () => {
    const snap = await buildSnapshot();
    const cloned = structuredClone(snap);
    const byIdAfter = new Map(cloned.invocations.map((i) => [i.id, i]));

    for (const inv of snap.invocations) {
      const twin = byIdAfter.get(inv.id)!;
      // parent id matches.
      expect(twin.parent?.id ?? null).toBe(inv.parent?.id ?? null);
      // children ids match, in order.
      expect(twin.children.map((c) => c.id)).toEqual(inv.children.map((c) => c.id));
      // structured-clone de-dups shared references: a cloned child's `parent`
      // points at the SAME cloned object as the array element it came from (intra-
      // clone identity holds even though it does NOT hold against the original).
      for (const child of twin.children) {
        expect(child.parent).toBe(twin);
        expect(byIdAfter.get(child.id)).toBe(child);
      }
    }
  });

  // ── the pinned boundary: `node` is the one field A2 must project before posting ──
  it("DOCUMENTS that node (a live Pair) does NOT survive the clone — A2 must project it", async () => {
    const snap = await buildSnapshot();

    // A located form (the `map` application or the inner `if`) carries `__location__`,
    // so its live scopeId is `head@line:col`.
    const located = snap.invocations.find((i) => scopeId(i.node).includes("@"));
    expect(located, "expected at least one located node in the snapshot").toBeDefined();
    const liveScope = scopeId(located!.node);
    expect(liveScope).toMatch(/@\d+:\d+$/);

    const cloned = structuredClone(snap);
    const clonedNode = cloned.invocations.find((i) => i.id === located!.id)!.node;

    // 1. Prototype is lost: a cloned Pair is a bare Object (is_pair / instanceof
    //    Pair would go false downstream).
    expect(Object.getPrototypeOf(clonedNode)).toBe(Object.prototype);

    // 2. The symbol-keyed `__location__` is stripped, so scopeId degrades from
    //    `head@line:col` to bare `head`. THIS is the silent killer the A2 projection
    //    must prevent (carry a pre-derived `scope` string instead of the live Pair).
    expect(Object.getOwnPropertySymbols(clonedNode)).toHaveLength(0);
    const degraded = scopeId(clonedNode);
    expect(degraded).not.toContain("@");
    expect(liveScope.startsWith(degraded)).toBe(true); // same head, lost the suffix
  });

  // ── the fix: `scope` is the clone-safe carrier of that degrading scopeId ──
  it("preserves the pre-derived `scope` string across the clone (the A2 projection)", async () => {
    const snap = await buildSnapshot();

    // Same located node as the degradation test — `scope` IS `scopeId(node)`, just
    // captured eagerly while the live Pair (with its `__location__`) is in hand.
    const located = snap.invocations.find((i) => i.scope.includes("@"));
    expect(located, "expected at least one located node in the snapshot").toBeDefined();
    expect(located!.scope).toMatch(/@\d+:\d+$/);
    expect(located!.scope).toBe(scopeId(located!.node));

    const cloned = structuredClone(snap);
    const twin = cloned.invocations.find((i) => i.id === located!.id)!;

    // The string survives intact (head@line:col) where `scopeId(twin.node)` degrades
    // to bare head — so the off-thread build keys by `scope`, never the cloned Pair.
    expect(twin.scope).toBe(located!.scope);
    expect(twin.scope).toMatch(/@\d+:\d+$/);
    expect(twin.scope).not.toBe(scopeId(twin.node)); // node degraded; scope did not
  });
});
