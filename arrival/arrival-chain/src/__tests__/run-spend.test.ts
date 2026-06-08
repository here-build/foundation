/**
 * RunSpend — the reflective budget accumulator behind `(infer/spent)`. Verifies
 * the fold arithmetic in isolation: fresh calls add `referenceCost`, cache hits
 * and usage-less backends add nothing (you fold over what you PAID, never saved).
 */
import { describe, expect, it } from "vitest";

import { referenceCost } from "../pricing.js";
import { RunSpend } from "../run-spend.js";

describe("RunSpend — reflective budget fold", () => {
  it("starts at zero", () => {
    const s = new RunSpend();
    expect(s.spent()).toBe(0);
    expect(s.calls()).toBe(0);
  });

  it("folds a fresh inference at its reference cost", () => {
    const s = new RunSpend();
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    s.record("qwen3.5-9b", usage, true);
    // qwen3.5-9b: $0.05/Mtok in + $0.10/Mtok out = 0.15
    expect(s.spent()).toBeCloseTo(referenceCost("qwen3.5-9b", usage), 9);
    expect(s.spent()).toBeCloseTo(0.15, 9);
    expect(s.calls()).toBe(1);
  });

  it("accumulates across multiple fresh calls in order", () => {
    const s = new RunSpend();
    const u = { inputTokens: 1_000_000, outputTokens: 0 };
    s.record("qwen3.5-9b", u, true); // 0.05
    expect(s.spent()).toBeCloseTo(0.05, 9);
    s.record("gpt-4o-mini", u, true); // +0.15
    expect(s.spent()).toBeCloseTo(0.2, 9);
    expect(s.calls()).toBe(2);
  });

  it("a cache hit is FREE — contributes nothing to spent", () => {
    const s = new RunSpend();
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    s.record("qwen3.5-9b", u, false); // cache hit → saved, not spent
    expect(s.spent()).toBe(0);
    expect(s.calls()).toBe(0);
    // a later fresh call still counts
    s.record("qwen3.5-9b", u, true);
    expect(s.spent()).toBeCloseTo(0.15, 9);
    expect(s.calls()).toBe(1);
  });

  it("a usage-less backend (pure stub) contributes nothing", () => {
    const s = new RunSpend();
    s.record("qwen3.5-9b", undefined, true);
    expect(s.spent()).toBe(0);
    expect(s.calls()).toBe(0);
  });
});
