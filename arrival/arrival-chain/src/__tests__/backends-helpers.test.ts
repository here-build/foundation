import { describe, expect, it, vi } from "vitest";

import { coerceModelJson, extractJsonObject, parseChatPrompt, renderSchema, specMessages, withRateLimitRetry } from "../backends/_shared.js";

const err = (status: number, headers?: Record<string, string>): Error & { status: number; headers?: Record<string, string> } =>
  Object.assign(new Error(`HTTP ${status}`), { status, headers });

describe("withRateLimitRetry", () => {
  it("retries a 429 then returns the eventual success", async () => {
    let calls = 0;
    const p = withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw err(429);
        return "ok";
      },
      { fallbackMs: 1 },
    );
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry a non-retryable status (e.g. 400)", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw err(400);
        },
        { fallbackMs: 1 },
      ),
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });

  it("gives up after `max` retries and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw err(429);
        },
        { max: 2, fallbackMs: 1 },
      ),
    ).rejects.toThrow("HTTP 429");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("backs off progressively (doubling) when no Retry-After header, capped at fallbackMs", async () => {
    const sleeps: number[] = [];
    const realSet = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSet(fn, 0);
    }) as typeof setTimeout);
    let calls = 0;
    await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 5) throw err(429);
        return "ok";
      },
      { baseMs: 1000, fallbackMs: 4000 },
    );
    vi.unstubAllGlobals();
    expect(sleeps).toEqual([1000, 2000, 4000, 4000]); // 1k,2k,4k(cap),4k(cap)
  });

  it("honors a numeric Retry-After header over the backoff", async () => {
    const sleeps: number[] = [];
    const realSet = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSet(fn, 0);
    }) as typeof setTimeout);
    let calls = 0;
    await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw err(429, { "retry-after": "2" });
        return "ok";
      },
      { baseMs: 50_000, fallbackMs: 99_999 },
    );
    vi.unstubAllGlobals();
    expect(sleeps).toEqual([2000]); // 2s from header, not the 50,000ms backoff
  });

  it("stops retrying once canRetry() returns false (stream already emitted)", async () => {
    let calls = 0;
    let emitted = false;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          emitted = true; // simulate a delta landing before the failure
          throw err(429);
        },
        { fallbackMs: 1, canRetry: () => !emitted },
      ),
    ).rejects.toThrow("HTTP 429");
    expect(calls).toBe(1);
  });

  it("aborts the pause when the signal fires", async () => {
    const ac = new AbortController();
    const p = withRateLimitRetry(
      async () => {
        throw err(429);
      },
      { fallbackMs: 10_000, signal: ac.signal },
    );
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe("parseChatPrompt", () => {
  it("parses canonical chat JSON", () => {
    const parsed = parseChatPrompt('[{"role":"system","content":"sys"},{"role":"user","content":"u"}]');
    expect(parsed).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ]);
  });

  it("returns null for plain text", () => {
    expect(parseChatPrompt("hello")).toBeNull();
  });

  it("returns null for JSON that isn't an array of {role, content}", () => {
    expect(parseChatPrompt('{"a":1}')).toBeNull();
    expect(parseChatPrompt('[{"role":"system"}]')).toBeNull();
    expect(parseChatPrompt('[{"role":"weird","content":"x"}]')).toBeNull();
  });
});

describe("renderSchema", () => {
  it("returns null for null and legacy non-JSON strings", () => {
    expect(renderSchema(null)).toBeNull();
    expect(renderSchema("ProfileLegacy")).toBeNull();
  });

  it("renders a primitive type", () => {
    expect(renderSchema('"string"')).toEqual({ type: "string" });
  });

  it("renders an object schema with required fields", () => {
    const r = renderSchema('["object",["name","string"],["age","integer"]]');
    expect(r).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name", "age"],
      additionalProperties: false,
    });
  });

  it("renders an array-of-X schema", () => {
    expect(renderSchema('["array","string"]')).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("renders an enum schema", () => {
    expect(renderSchema('["enum","A","B","C"]')).toEqual({
      type: "string",
      enum: ["A", "B", "C"],
    });
  });

  it("renders nested array-of-objects with enum field", () => {
    const r = renderSchema('["array",["object",["name","string"],["bucket",["enum","A","B"]]]]');
    expect(r).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          bucket: { type: "string", enum: ["A", "B"] },
        },
        required: ["name", "bucket"],
        additionalProperties: false,
      },
    });
  });
});

describe("specMessages", () => {
  it("wraps a plain prompt as a single user message — no default system injected", () => {
    const msgs = specMessages({ model: "m", prompt: "hello", schema: null });
    expect(msgs).toEqual([{ role: "user", content: "hello" }]);
  });

  it("passes embedded messages through unchanged", () => {
    const prompt = '[{"role":"system","content":"sys"},{"role":"user","content":"u"}]';
    const msgs = specMessages({ model: "m", prompt, schema: null });
    expect(msgs).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ]);
  });

  it("doesn't prepend a system when the chat list omits one — that's userland's call", () => {
    const prompt = '[{"role":"user","content":"u"},{"role":"assistant","content":"a"}]';
    const msgs = specMessages({ model: "m", prompt, schema: null });
    expect(msgs).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });
});

describe("coerceModelJson", () => {
  it("strict-parses clean JSON", () => {
    expect(coerceModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 }, via: "strict" });
  });

  it("repairs markdown-fenced JSON via the repair ladder", () => {
    const fenced = '```json\n{"a": 1}\n```';
    expect(coerceModelJson(fenced)).toEqual({ ok: true, value: { a: 1 }, via: "repair" });
  });

  it("repairs a lightly-malformed object (trailing comma)", () => {
    expect(coerceModelJson('{"a": 1,}')).toEqual({ ok: true, value: { a: 1 }, via: "repair" });
  });

  it("does NOT repair a length-truncated stream — surfaces the loss as ok:false", () => {
    // A cut-off object is genuine data loss; repairing it would fabricate a close.
    expect(coerceModelJson('{"a": 1, "b": ', { finish: "length" })).toEqual({ ok: false });
  });

  it("recovers JSON from the reasoning channel when content is empty", () => {
    const reasoning = "Let me think… the answer is {\"label\": \"bug\"} I'm confident.";
    expect(coerceModelJson("", { reasoning })).toEqual({ ok: true, value: { label: "bug" }, via: "reasoning" });
  });

  it("fails (ok:false) on empty content with no reasoning to recover from", () => {
    expect(coerceModelJson("", {})).toEqual({ ok: false });
  });
});

describe("extractJsonObject", () => {
  it("pulls the outermost object out of surrounding prose", () => {
    expect(extractJsonObject('prefix {"a": 1} suffix')).toEqual({ a: 1 });
  });

  it("returns undefined when there's no JSON structure", () => {
    expect(extractJsonObject("just thinking out loud")).toBeUndefined();
  });
});
