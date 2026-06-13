import { describe, expect, it } from "vitest";

import { priceFor, referenceCost } from "../pricing.js";
import { uncachedSumStrategy } from "../projected-cost.js";

describe("pricing — tokens → USD", () => {
  it("costs input + output tokens at the model's per-Mtok price", () => {
    // qwen3.5-9b: $0.05/Mtok in, $0.10/Mtok out.
    // 1M in + 1M out = 0.05 + 0.10 = 0.15.
    expect(referenceCost("qwen3.5-9b", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.15, 9);
  });

  it("falls back to the default price for an unknown model", () => {
    const known = priceFor("totally-unknown-model");
    expect(known.inputPerMTok).toBeGreaterThan(0);
    // 0 tokens always costs 0, regardless of model.
    expect(referenceCost("totally-unknown-model", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("projected cost — uncached-sum strategy", () => {
  it("sums every call at full price and breaks down by model", () => {
    const result = uncachedSumStrategy.project([
      { model: "qwen3.5-9b", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, // 0.05
      { model: "qwen3.5-9b", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, // 0.05
      { model: "gpt-4o-mini", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, // 0.15
    ]);
    expect(result.total).toBeCloseTo(0.25, 9);
    const qwen = result.byModel.find((m) => m.model === "qwen3.5-9b");
    expect(qwen).toEqual({ model: "qwen3.5-9b", cost: expect.closeTo(0.1, 9), calls: 2 });
  });

  it("an empty run projects zero", () => {
    expect(uncachedSumStrategy.project([]).total).toBe(0);
  });
});
