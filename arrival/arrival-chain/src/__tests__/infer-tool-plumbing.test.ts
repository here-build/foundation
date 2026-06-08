/**
 * W1 — the tool-enabled inference plumbing (identity fold + record/replay shape). These
 * are the only deltas a tool-enabled `(infer …)` adds over a plain one; everything is
 * gated on `hasTools`, so the plain path stays byte-for-byte unchanged. The full
 * integration (driving these through a Project run) lands with the W2 agentic rosetta;
 * here we prove the primitives in isolation.
 */
import { describe, expect, it } from "vitest";

import { InferString } from "../infer-string.js";
import type { Completion, ToolDescriptor } from "../model.js";
import { freshInfer, recordInfer, reviveInfer, toolCacheKey } from "../project.js";

const tools: ToolDescriptor[] = [
  { name: "create_issue", description: "file one", inputSchema: { type: "object" } },
  { name: "search", inputSchema: { type: "object" } },
];

describe("toolCacheKey — tools fold into the inference identity", () => {
  it("is stable for the same inputs", () => {
    expect(toolCacheKey("k", tools)).toBe(toolCacheKey("k", tools));
  });

  it("distinguishes different toolsets (same base key)", () => {
    expect(toolCacheKey("k", tools)).not.toBe(toolCacheKey("k", [tools[0]!]));
  });

  it("distinguishes tool ORDER (order is semantically meaningful to the model)", () => {
    expect(toolCacheKey("k", tools)).not.toBe(toolCacheKey("k", [tools[1]!, tools[0]!]));
  });

  it("folds the base cacheKey (different base ⇒ different identity)", () => {
    expect(toolCacheKey("a", tools)).not.toBe(toolCacheKey("b", tools));
    expect(toolCacheKey(null, tools)).not.toBe(toolCacheKey("a", tools));
  });
});

describe("recordInfer / reviveInfer — record/replay round-trip", () => {
  it("tool-enabled: round-trips {value, toolCalls} back into an InferString with the calls", () => {
    const completion: Completion = {
      value: "I filed it",
      toolCalls: [{ id: "c1", name: "create_issue", arguments: { title: "Bug" } }],
    };
    const recorded = recordInfer(completion, true);
    expect(JSON.parse(recorded)).toEqual({
      value: "I filed it",
      toolCalls: [{ id: "c1", name: "create_issue", arguments: { title: "Bug" } }],
    });
    const revived = reviveInfer(recorded, true);
    expect(revived).toBeInstanceOf(InferString);
    expect((revived as InferString).valueOf()).toBe("I filed it");
    expect((revived as InferString).__toolCalls__).toEqual([
      { id: "c1", name: "create_issue", arguments: { title: "Bug" } },
    ]);
  });

  it("tool-enabled: a no-call turn revives to an InferString with empty toolCalls", () => {
    const recorded = recordInfer({ value: "final answer" }, true);
    const revived = reviveInfer(recorded, true);
    expect(revived).toBeInstanceOf(InferString);
    expect((revived as InferString).valueOf()).toBe("final answer");
    expect((revived as InferString).__toolCalls__).toEqual([]);
  });

  it("plain (no tools): records + revives the bare value, NOT an InferString (unchanged path)", () => {
    expect(recordInfer({ value: "hi" }, false)).toBe('"hi"');
    expect(reviveInfer('"hi"', false)).toBe("hi");
    // object value round-trips as a plain object
    expect(recordInfer({ value: { a: 1 } }, false)).toBe('{"a":1}');
    expect(reviveInfer('{"a":1}', false)).toEqual({ a: 1 });
    expect(reviveInfer('"hi"', false)).not.toBeInstanceOf(InferString);
  });
});

describe("freshInfer — the cache-miss return", () => {
  it("tool-enabled: an InferString carrying the turn's text + toolCalls", () => {
    const v = freshInfer({ value: "txt", toolCalls: [{ name: "search", arguments: {} }] }, true);
    expect(v).toBeInstanceOf(InferString);
    expect((v as InferString).valueOf()).toBe("txt");
    expect((v as InferString).__toolCalls__).toEqual([{ name: "search", arguments: {} }]);
  });

  it("plain: the bare value (unchanged)", () => {
    expect(freshInfer({ value: "txt" }, false)).toBe("txt");
    expect(freshInfer({ value: { a: 1 } }, false)).toEqual({ a: 1 });
  });
});
