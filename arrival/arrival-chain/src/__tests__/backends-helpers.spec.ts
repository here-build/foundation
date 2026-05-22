import { describe, expect, it } from "vitest";

import { parseChatPrompt, renderSchema, specMessages } from "../backends/_shared.js";

describe("parseChatPrompt", () => {
  it("parses canonical chat JSON", () => {
    const parsed = parseChatPrompt(
      '[{"role":"system","content":"sys"},{"role":"user","content":"u"}]',
    );
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
    const r = renderSchema(
      '["array",["object",["name","string"],["bucket",["enum","A","B"]]]]',
    );
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
