import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineActionTool } from "../../kernel/action";
import { defineDiscoveryTool } from "../../kernel/discovery";
import { toLegacyActionClass, toLegacyDiscoveryClass } from "../../kernel/adapter";
import { str } from "../../kernel/refs";

// ─── Minimal Hono Context and Services extractor ────────────────────────────

function createMockContext(): Context {
  return {
    req: { header: () => undefined },
    get: () => undefined,
    set: () => undefined,
  } as unknown as Context;
}

interface TestSvc extends Record<string, any> {
  apiName: string;
  counter: number;
}

function extractServices(_ctx: Context, _state: Record<string, any>): TestSvc {
  return { apiName: "test-api", counter: 1 };
}

// ─── Discovery adapter ──────────────────────────────────────────────────────

describe("toLegacyDiscoveryClass", () => {
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
  });

  function buildDiscoveryTool() {
    return defineDiscoveryTool<{ projectId: string }, TestSvc>({
      name: "my-discovery",
      description: "A discovery tool",
      context: { projectId: str("project UUID") },
      fns: (b) => [
        b.fn({ name: "echo", desc: "echo ctx", impl: (ctx) => (ctx as { projectId: string }).projectId }),
        b.fn({ name: "ping", desc: "ping", impl: () => "pong" }),
      ],
    });
  }

  it("produces a class with the tool name as .name", () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    expect(Cls.name).toBe("my-discovery");
  });

  it("getToolSchema returns the inputSchema with expected properties", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const inst = new Cls(mockContext);
    const schema = (await inst.getToolSchema()) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.expr).toBeDefined();
    expect(schema.properties.projectId).toBeDefined();
    expect(schema.required).toEqual(["expr"]);
  });

  it("getToolDescription returns the full Tool descriptor", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const inst = new Cls(mockContext);
    const desc = await inst.getToolDescription({ name: "tester" });
    expect(desc.name).toBe("my-discovery");
    expect(desc.description).toBe("A discovery tool");
    expect(desc.inputSchema).toBeDefined();
  });

  it("executeTool throws when executionContext is missing", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const inst = new Cls(mockContext);
    await expect(inst.executeTool()).rejects.toThrow(/executionContext required/);
  });

  it("executeTool runs a simple fn end-to-end", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "proj-42",
      expr: "(echo)",
      intent: "exploring",
    });
    const result = await inst.executeTool();
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[])[0]).toContain("proj-42");
  });

  it("executeTool appends the replay expression to state.__repl__", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const state: Record<string, any> = {};
    const inst = new Cls(mockContext, state, {
      projectId: "proj-1",
      expr: "(ping)",
    });
    await inst.executeTool();
    expect(state.__repl__).toEqual(["(ping)"]);

    // Second call: history should carry over.
    const inst2 = new Cls(mockContext, state, {
      projectId: "proj-1",
      expr: "(ping)",
    });
    await inst2.executeTool();
    expect(state.__repl__).toEqual(["(ping)", "(ping)"]);
  });

  it("extractServices is invoked with context and state", async () => {
    const extractor = vi.fn((_ctx: Context, _state: Record<string, any>): TestSvc => ({
      apiName: "api-x",
      counter: 7,
    }));
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractor);
    const state = { foo: "bar" };
    const inst = new Cls(mockContext, state, {
      projectId: "p",
      expr: "(ping)",
    });
    await inst.executeTool();
    expect(extractor).toHaveBeenCalled();
    // On at least one call the state object should be passed.
    const stateArgs = extractor.mock.calls.map((c) => c[1]);
    expect(stateArgs).toContain(state);
  });

  it("ignores intent on execution path (currently unused)", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "p",
      expr: "(ping)",
      intent: "any intent",
    });
    const result = await inst.executeTool();
    expect(Array.isArray(result)).toBe(true);
  });

  it("history replay lets later calls reference earlier definitions", async () => {
    const Cls = toLegacyDiscoveryClass(buildDiscoveryTool(), extractServices);
    const state: Record<string, any> = {};
    // First call defines x.
    const inst1 = new Cls(mockContext, state, {
      projectId: "p",
      expr: "(define x 123)",
    });
    await inst1.executeTool();
    // Second call reads x — will re-run history first.
    const inst2 = new Cls(mockContext, state, {
      projectId: "p",
      expr: "x",
    });
    const result = await inst2.executeTool();
    expect((result as string[])[0]).toContain("123");
  });
});

// ─── Action adapter ─────────────────────────────────────────────────────────

describe("toLegacyActionClass", () => {
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
  });

  function buildActionTool() {
    return defineActionTool<{ projectId: string }, TestSvc>({
      name: "my-action",
      description: "An action tool",
      context: { projectId: str("project UUID") },
      actions: (b) => [
        b.act({
          name: "ping",
          needs: ["projectId"],
          desc: "",
          handle: (ctx) => ({ pong: (ctx as { projectId: string }).projectId }),
        }),
        b.act({
          name: "create",
          needs: ["projectId"],
          desc: "",
          props: { name: str() },
          handle: (ctx, _recv, props) => ({ project: (ctx as { projectId: string }).projectId, name: props.name }),
        }),
      ],
    });
  }

  it("produces a class with the tool name as .name", () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    expect(Cls.name).toBe("my-action");
  });

  it("getToolSchema returns inputSchema with intent+actions required", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext);
    const schema = (await inst.getToolSchema()) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["intent", "actions"]);
    expect(schema.properties.projectId).toBeDefined();
  });

  it("getToolDescription returns the full Tool descriptor", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext);
    const desc = await inst.getToolDescription();
    expect(desc.name).toBe("my-action");
    expect(desc.description).toBe("An action tool");
  });

  it("executeTool throws when executionContext is missing", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext);
    await expect(inst.executeTool()).rejects.toThrow(/executionContext required/);
  });

  it("executeTool returns ActionResult on success", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "p-1",
      intent: "doing stuff",
      actions: [["ping", {}]],
    });
    const result = await inst.executeTool();
    expect(result).toMatchObject({
      success: true,
      intent: "doing stuff",
      results: [{ pong: "p-1" }],
    });
  });

  it("executeTool returns validation failure when intent is missing", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "p-1",
      actions: [["ping", {}]],
    });
    const result = await inst.executeTool();
    expect(result).toMatchObject({ success: false, validation: "failed" });
  });

  it("executeTool returns partial result when a handler fails mid-batch", async () => {
    const tool = defineActionTool<{ projectId: string }, TestSvc>({
      name: "t",
      description: "",
      context: { projectId: str() },
      actions: (b) => [
        b.act({ name: "ok", needs: ["projectId"], desc: "", handle: () => "A" }),
        b.act({
          name: "boom",
          needs: ["projectId"],
          desc: "",
          handle: () => {
            throw new Error("oops");
          },
        }),
      ],
    });
    const Cls = toLegacyActionClass(tool, extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "p-1",
      intent: "risky",
      actions: [["ok", {}], ["boom", {}]],
    });
    const result = await inst.executeTool();
    expect(result).toMatchObject({
      success: false,
      partial: true,
      executed: 1,
      total: 2,
      failedAction: { index: 1, name: "boom", error: "oops" },
    });
  });

  it("actions with props receive them", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    const inst = new Cls(mockContext, {}, {
      projectId: "p-1",
      intent: "doing",
      actions: [["create", { name: "hello" }]],
    });
    const result = await inst.executeTool();
    expect(result).toMatchObject({
      success: true,
      results: [{ project: "p-1", name: "hello" }],
    });
  });

  it("extractServices is invoked to extract services from Hono ctx", async () => {
    const extractor = vi.fn((_ctx: Context, _state: Record<string, any>): TestSvc => ({
      apiName: "a",
      counter: 0,
    }));
    const Cls = toLegacyActionClass(buildActionTool(), extractor);
    const inst = new Cls(mockContext, {}, {
      projectId: "p-1",
      intent: "go",
      actions: [["ping", {}]],
    });
    await inst.executeTool();
    expect(extractor).toHaveBeenCalledWith(mockContext, expect.any(Object));
  });

  it("defaults actions/intent to empty when executionContext lacks them", async () => {
    const Cls = toLegacyActionClass(buildActionTool(), extractServices);
    // Only projectId provided; intent and actions missing from executionContext.
    const inst = new Cls(mockContext, {}, { projectId: "p-1" });
    const result = await inst.executeTool();
    // Missing intent → validation failed.
    expect(result).toMatchObject({ success: false, validation: "failed" });
  });
});
