/**
 * inferTasksByScope — the content sidecar, against the real gepa trace. Pins the
 * bridge from a flow-graph scope id to the live InferBinding(s) its instances
 * created, so the renderer can show what each infer actually sent + got back.
 */
import { describe, expect, it } from "vitest";

import { inferTasksByScope } from "../infer-content.js";
import { traceToFlowGraph } from "@here.build/arrival-provenance";

import { gepaTrace } from "./_gepa-trace.js";

describe("inferTasksByScope — infer node content", () => {
  it("maps each infer scope to its resolved task(s) with prompt + model + result", async () => {
    const trace = await gepaTrace();
    const byScope = inferTasksByScope(trace);

    // The react scope (a ×2 persona fan-out) carries two distinct tasks — one
    // prompt per persona — all on the "fast" model, all resolved with a verdict.
    const reactScope = [...byScope.keys()].find((k) => {
      const tasks = byScope.get(k)!;
      return tasks.some((t) => t.prompt.includes("REACT|"));
    });
    expect(reactScope).toBeDefined();
    const reactTasks = byScope.get(reactScope!)!;
    expect(reactTasks.length).toBeGreaterThanOrEqual(2); // p1, p2 — distinct prompts
    for (const t of reactTasks) {
      expect(t.model).toBe("fast");
      expect(t.prompt).toContain("REACT|");
      expect(t.completion).toBeDefined();
      expect(t.completion!.value).toEqual({ verdict: "click" });
    }

    // The reflect scope is distinct and carries the REFLECT prompt.
    const reflectScope = [...byScope.keys()].find((k) => byScope.get(k)!.some((t) => t.prompt.includes("REFLECT|")));
    expect(reflectScope).toBeDefined();
    expect(reflectScope).not.toBe(reactScope);
  });

  it("keys content by the SAME scope id the flow-graph's infer leaves use", async () => {
    const trace = await gepaTrace();
    const byScope = inferTasksByScope(trace);
    const graph = traceToFlowGraph(trace);

    // Every scope with content corresponds to a real flow-graph node (the bridge
    // is consistent — content and structure share the scopeId space).
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const sid of byScope.keys()) expect(nodeIds.has(sid)).toBe(true);

    // And the infer leaves the graph marks causal (layer set) have content.
    const causalLeaves = graph.nodes.filter((n) => n.layer !== null);
    expect(causalLeaves.length).toBeGreaterThan(0);
    for (const leaf of causalLeaves) expect(byScope.has(leaf.id)).toBe(true);
    // scopeId is the shared key (sanity: ids look like head@line:col).
    expect([...byScope.keys()].every((k) => k.includes("@"))).toBe(true);
  });
});
