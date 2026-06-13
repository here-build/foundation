import { describe, expect, it } from "vitest";

import { openAICompatBackend, type ChatCompletionsClient } from "@here.build/arrival-inference";
import { openRouterCostMicroUsd } from "@here.build/arrival-inference/backends/openrouter";
import type { ModelSpec } from "@here.build/arrival-inference";

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  model: "openai/gpt-4o-mini",
  prompt: "hi",
  schema: null,
  ...over,
});

// A fake OpenAI-compatible client. Records the last request body (so we can assert
// the max_tokens / usage:{include:true} plumbing) and returns a fixed text + usage.
// Both the non-streamed completion and the streamed chunk carry the same usage, so
// the two paths are checked against one source of truth.
function fakeClient(opts: { text?: string; usage?: Record<string, unknown> } = {}): {
  client: ChatCompletionsClient;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const text = opts.text ?? "ok";
  const usage = opts.usage;
  const client: ChatCompletionsClient = {
    chat: {
      completions: {
        create: ((body: Record<string, unknown>) => {
          bodies.push(body);
          if (body.stream) {
            async function* chunks(): AsyncIterable<{
              choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              usage?: Record<string, unknown>;
            }> {
              yield { choices: [{ delta: { content: text }, finish_reason: "stop" }] };
              // Final usage-only chunk (the include_usage tail).
              yield { choices: [], usage };
            }
            return Promise.resolve(chunks());
          }
          return Promise.resolve({ choices: [{ message: { content: text } }], usage });
        }) as ChatCompletionsClient["chat"]["completions"]["create"],
      },
    },
  };
  return { client, bodies };
}

describe("openRouterCostMicroUsd — settled-cost conversion", () => {
  it("converts usage.cost (USD float) to integer micro-USD", () => {
    expect(openRouterCostMicroUsd({ cost: 0.0123 })).toBe(12_300);
    expect(openRouterCostMicroUsd({ cost: 1 })).toBe(1_000_000);
  });

  it("rounds sub-micro-dollar values to the nearest micro-USD (no systematic downward bias)", () => {
    // 0.0000004 USD = 0.4 µ$ → rounds to 0; 0.0000006 USD = 0.6 µ$ → rounds to 1.
    expect(openRouterCostMicroUsd({ cost: 0.000_000_4 })).toBe(0);
    expect(openRouterCostMicroUsd({ cost: 0.000_000_6 })).toBe(1);
  });

  it("falls back to cost_details.upstream_inference_cost only when cost is absent", () => {
    expect(openRouterCostMicroUsd({ cost_details: { upstream_inference_cost: 0.002 } })).toBe(2000);
  });

  it("prefers the total cost over cost_details (cost carries OpenRouter's margin)", () => {
    expect(openRouterCostMicroUsd({ cost: 0.005, cost_details: { upstream_inference_cost: 0.002 } })).toBe(5000);
  });

  it("returns undefined when no cost is reported (direct OpenAI / cost opt-in off)", () => {
    expect(openRouterCostMicroUsd(undefined)).toBeUndefined();
    expect(openRouterCostMicroUsd({})).toBeUndefined();
    expect(openRouterCostMicroUsd({ cost_details: { upstream_inference_cost: null } })).toBeUndefined();
  });

  it("drops non-meaningful cost values (negative / NaN)", () => {
    expect(openRouterCostMicroUsd({ cost: -0.01 })).toBeUndefined();
    expect(openRouterCostMicroUsd({ cost: Number.NaN })).toBeUndefined();
  });
});

describe("openAICompatBackend — provider-cost capture (the resale fact)", () => {
  it("complete() lands costFromUsage's value on usage.providerCostMicroUsd", async () => {
    const { client } = fakeClient({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0123 } });
    const backend = openAICompatBackend(client, { costFromUsage: openRouterCostMicroUsd });
    const completion = await backend.complete(spec());
    expect(completion.usage).toEqual({ inputTokens: 10, outputTokens: 5, providerCostMicroUsd: 12_300 });
  });

  it("stream() captures the same cost from the include_usage tail chunk", async () => {
    const { client } = fakeClient({ text: "streamed", usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.002 } });
    const backend = openAICompatBackend(client, { costFromUsage: openRouterCostMicroUsd });
    const deltas: string[] = [];
    const completion = await backend.stream!(spec(), (d) => deltas.push(d));
    expect(deltas.join("")).toBe("streamed");
    expect(completion.usage).toEqual({ inputTokens: 7, outputTokens: 3, providerCostMicroUsd: 2000 });
  });

  it("omits providerCostMicroUsd entirely when no cost is reported", async () => {
    const { client } = fakeClient({ usage: { prompt_tokens: 4, completion_tokens: 2 } });
    const backend = openAICompatBackend(client, { costFromUsage: openRouterCostMicroUsd });
    const completion = await backend.complete(spec());
    expect(completion.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(completion.usage && "providerCostMicroUsd" in completion.usage).toBe(false);
  });

  it("a backend without costFromUsage (direct OpenAI) never attaches a cost", async () => {
    const { client } = fakeClient({ usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.0123 } });
    const backend = openAICompatBackend(client); // no costFromUsage
    const completion = await backend.complete(spec());
    expect(completion.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });
});

describe("openAICompatBackend — request plumbing", () => {
  it("passes spec.maxTokens through as max_tokens (the reservation ceiling)", async () => {
    const { client, bodies } = fakeClient();
    const backend = openAICompatBackend(client);
    await backend.complete(spec({ maxTokens: 256 }));
    expect(bodies[0]?.max_tokens).toBe(256);
  });

  it("omits max_tokens when the spec has none (unbounded / ROI-only call)", async () => {
    const { client, bodies } = fakeClient();
    const backend = openAICompatBackend(client);
    await backend.complete(spec());
    expect("max_tokens" in (bodies[0] ?? {})).toBe(false);
  });

  it("merges extraBody (OpenRouter's usage:{include:true} cost opt-in) into every request", async () => {
    const { client, bodies } = fakeClient();
    const backend = openAICompatBackend(client, { extraBody: { usage: { include: true } } });
    await backend.complete(spec());
    await backend.stream!(spec(), () => {});
    expect(bodies[0]?.usage).toEqual({ include: true });
    // stream body also carries the opt-in (alongside stream:true + stream_options).
    expect(bodies[1]?.usage).toEqual({ include: true });
    expect(bodies[1]?.stream).toBe(true);
  });
});
