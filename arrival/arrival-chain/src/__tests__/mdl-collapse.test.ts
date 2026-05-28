/**
 * MDL collapse optimizer — behavioral proof.
 *
 * The risky part of the MDL approach isn't the renderer, it's whether the
 * tree-DP + parsimony tax produces the RIGHT collapse decisions. These tests
 * pin the four behaviors the design relies on (doc §4):
 *   1. a real loop with many similar iterations collapses; its inner fan-out too
 *   2. a single-iteration "loop" does NOT get boxed (overhead > saving)
 *   3. λ is the zoom knob — #collapsed is monotone non-increasing as λ rises
 *   4. high per-instance binding variance keeps a box EXPANDED (don't fake-
 *      collapse instances that actually rewire differently)
 * plus: nesting composes (inner can expand while outer collapses).
 */
import { describe, expect, it } from "vitest";

import { type CandidateBox, collapseMDL } from "../mdl-collapse.js";

/** gepa shape: a ×K loop whose body contains a ×N persona fan-out. */
const gepaForest = (loopN: number, fanoutN: number, residual = 0): CandidateBox[] => [
  {
    id: "loop",
    type: "loop",
    n: loopN,
    localBits: 6,
    perInstanceResidualBits: residual,
    children: [{ id: "react", type: "unfold", n: fanoutN, localBits: 4, perInstanceResidualBits: residual, children: [] }],
  },
];

describe("collapseMDL — decision behavior", () => {
  it("collapses a real loop and its inner fan-out (the gepa case)", () => {
    const { decisions } = collapseMDL(gepaForest(50, 3));
    expect(decisions.get("loop")).toBe("collapsed");
    expect(decisions.get("react")).toBe("collapsed");
  });

  it("does NOT box a single-iteration loop (overhead exceeds any saving)", () => {
    const { decisions } = collapseMDL([
      { id: "once", type: "loop", n: 1, localBits: 6, perInstanceResidualBits: 0, children: [] },
    ]);
    expect(decisions.get("once")).toBe("expanded");
  });

  it("keeps a box EXPANDED when its instances rewire differently (high binding residual)", () => {
    // Identical instances → collapse; same shape with high per-instance variance → expand.
    expect(collapseMDL(gepaForest(50, 3, 0)).decisions.get("react")).toBe("collapsed");
    expect(collapseMDL(gepaForest(50, 3, 5)).decisions.get("react")).toBe("expanded");
  });

  it("λ is the zoom knob: #collapsed is monotone non-increasing as λ rises", () => {
    const countCollapsed = (lambda: number): number => {
      // A forest of several independent small boxes so the count can vary.
      const forest: CandidateBox[] = [3, 4, 5, 6].map((n, i) => ({
        id: `b${i}`,
        type: "unfold",
        n,
        localBits: 4,
        perInstanceResidualBits: 0,
        children: [],
      }));
      const { decisions } = collapseMDL(forest, { lambda });
      return [...decisions.values()].filter((d) => d === "collapsed").length;
    };
    const lambdas = [0.1, 0.5, 1, 2, 4, 8, 16];
    const counts = lambdas.map(countCollapsed);
    // Non-increasing, and the extremes actually differ (the knob does something).
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    expect(counts[0]).toBeGreaterThan(counts[counts.length - 1]!);
  });

  it("nesting composes: inner fan-out expands (tiny + high residual) while the outer loop still collapses", () => {
    const { decisions } = collapseMDL([
      {
        id: "outer",
        type: "loop",
        n: 40,
        localBits: 5,
        perInstanceResidualBits: 0,
        children: [{ id: "inner", type: "unfold", n: 2, localBits: 2, perInstanceResidualBits: 8, children: [] }],
      },
    ]);
    expect(decisions.get("inner")).toBe("expanded");
    expect(decisions.get("outer")).toBe("collapsed");
  });

  it("is deterministic — ties resolve to collapsed, stable across runs", () => {
    const run = () => collapseMDL(gepaForest(50, 3)).decisions.get("loop");
    expect(run()).toBe(run());
    expect(run()).toBe("collapsed");
  });
});
