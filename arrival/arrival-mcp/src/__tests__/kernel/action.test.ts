import { describe, expect, it, vi } from "vitest";

import {
  compileActionTool,
  defineActionTool,
  defineCluster,
  type ActionTool,
} from "../../kernel/action";
import { defineRef, instanceShape, num, str } from "../../kernel/refs";

// ─── Local test classes ─────────────────────────────────────────────────────

class Widget {
  constructor(public id: string = "w-1") {}
}

class Gadget {
  constructor(public id: string = "g-1") {}
}

interface TestSvc extends Record<string, any> {
  apiName: string;
}

type BaseCtxShape = { element?: Widget | Gadget };

/** Ref that accepts either a Widget or a Gadget instance passthrough. */
const elementRef = defineRef<Widget | Gadget, unknown>({
  typeName: "Element",
  desc: "",
  shapes: [instanceShape(Widget), instanceShape(Gadget)],
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("defineActionTool — construction", () => {
  it("constructs a tool with kind 'action' and intentRequired: true", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "test-act",
      description: "d",
      context: {},
      actions: (b) => [
        b.act({
          name: "nop",
          needs: [],
          desc: "",
          handle: () => "ok",
        }),
      ],
    });
    expect(tool.kind).toBe("action");
    expect(tool.intentRequired).toBe(true);
    expect(tool.name).toBe("test-act");
  });

  it("ActBuilder.act defaults receiverKey to 'element' when `on` is set", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({
          name: "touch",
          on: Widget,
          needs: ["element"],
          desc: "",
          handle: () => "ok",
        }),
      ],
    });
    // Inline actions land in the <inline> cluster.
    expect(tool.clusters).toHaveLength(1);
    const act = tool.clusters[0].actions[0];
    expect(act.receiverKey).toBe("element");
    expect(act.on).toBe(Widget);
  });

  it("keeps receiverKey untouched when author specified it", () => {
    const tool = defineActionTool<{ target?: Widget }, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({
          name: "touch",
          on: Widget,
          receiverKey: "target",
          needs: ["target"],
          desc: "",
          handle: () => "ok",
        }),
      ],
    });
    const act = tool.clusters[0].actions[0];
    expect(act.receiverKey).toBe("target");
  });
});

describe("defineCluster — independent authoring", () => {
  it("creates a named cluster with actions", () => {
    const cluster = defineCluster<{ element?: Widget; intent: string }>({
      name: "widget-ops",
      description: "ops for widgets",
      actions: (b) => [
        b.act({
          name: "rename",
          on: Widget,
          needs: ["element"],
          desc: "",
          props: { to: str() },
          handle: (_ctx, w, props) => ({ widget: (w as Widget).id, renamed: props.to }),
        }),
      ],
    });
    expect(cluster.name).toBe("widget-ops");
    expect(cluster.description).toBe("ops for widgets");
    expect(cluster.actions).toHaveLength(1);
  });
});

describe("Cluster composition across 'files'", () => {
  it("composes two independently-authored clusters into a single tool", () => {
    // Simulate two separate modules.
    const widgetCluster = defineCluster<{ element?: Widget; intent: string }>({
      name: "widget-ops",
      actions: (b) => [
        b.act({
          name: "wop",
          on: Widget,
          needs: ["element"],
          desc: "widget op",
          handle: () => "widget-done",
        }),
      ],
    });
    const gadgetCluster = defineCluster<{ element?: Gadget; intent: string }>({
      name: "gadget-ops",
      actions: (b) => [
        b.act({
          name: "gop",
          on: Gadget,
          needs: ["element"],
          desc: "gadget op",
          handle: () => "gadget-done",
        }),
      ],
    });

    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "combined",
      description: "",
      context: {},
      clusters: [widgetCluster, gadgetCluster],
    });
    expect(tool.clusters).toHaveLength(2);
    expect(tool.clusters[0].name).toBe("widget-ops");
    expect(tool.clusters[1].name).toBe("gadget-ops");
  });
});

describe("Duplicate detection across clusters", () => {
  it("detects same name+receiver duplicated across two clusters at tool construction", () => {
    const a = defineCluster<{ element?: Widget; intent: string }>({
      name: "A",
      actions: (b) => [
        b.act({ name: "rename", on: Widget, needs: ["element"], desc: "", handle: () => 1 }),
      ],
    });
    const b2 = defineCluster<{ element?: Widget; intent: string }>({
      name: "B",
      actions: (b) => [
        b.act({ name: "rename", on: Widget, needs: ["element"], desc: "", handle: () => 2 }),
      ],
    });
    expect(() =>
      defineActionTool<BaseCtxShape, TestSvc>({
        name: "t",
        description: "",
        context: {},
        clusters: [a, b2],
      }),
    ).toThrow(/duplicate "rename"/);
  });

  it("same name on different receiver classes is allowed", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({ name: "act", on: Widget, needs: ["element"], desc: "", handle: () => "w" }),
        b.act({ name: "act", on: Gadget, needs: ["element"], desc: "", handle: () => "g" }),
      ],
    });
    expect(tool.clusters[0].actions).toHaveLength(2);
  });
});

describe(".register() — immutable cluster composition", () => {
  it("returns a new tool without mutating the original", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "base",
      description: "",
      context: {},
    });
    const clusterA = defineCluster<{ element?: Widget; intent: string }>({
      name: "A",
      actions: (b) => [b.act({ name: "a", needs: [], desc: "", handle: () => 1 })],
    });
    const next = tool.register(clusterA);
    expect(next).not.toBe(tool);
    expect(tool.clusters).toHaveLength(0);
    expect(next.clusters).toHaveLength(1);
    expect(next.clusters[0].name).toBe("A");
  });

  it("chains multiple registrations, each yielding a new tool", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "base",
      description: "",
      context: {},
    });
    const clusterA = defineCluster<{ element?: Widget; intent: string }>({
      name: "A",
      actions: (b) => [b.act({ name: "a", needs: [], desc: "", handle: () => 1 })],
    });
    const clusterB = defineCluster<{ element?: Widget; intent: string }>({
      name: "B",
      actions: (b) => [b.act({ name: "b", needs: [], desc: "", handle: () => 2 })],
    });
    const t1 = tool.register(clusterA);
    const t2 = t1.register(clusterB);
    expect(t2.clusters.map((c) => c.name)).toEqual(["A", "B"]);
    expect(t1.clusters).toHaveLength(1);
    expect(tool.clusters).toHaveLength(0);
  });

  it("register validates against existing clusters (catches duplicates)", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "base",
      description: "",
      context: {},
      actions: (b) => [
        b.act({ name: "dup", on: Widget, needs: ["element"], desc: "", handle: () => 0 }),
      ],
    });
    const bad = defineCluster<{ element?: Widget; intent: string }>({
      name: "bad",
      actions: (b) => [
        b.act({ name: "dup", on: Widget, needs: ["element"], desc: "", handle: () => 0 }),
      ],
    });
    expect(() => tool.register(bad)).toThrow(/duplicate "dup"/);
  });
});

describe("compileActionTool — getToolDescription / schema", () => {
  function buildTool(): ActionTool<BaseCtxShape, TestSvc, TestSvc> {
    return defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "A tool",
      context: { projectId: str("project UUID") },
      actions: (b) => [
        b.act({
          name: "create",
          needs: [],
          desc: "Create a thing",
          props: { name: str("name") },
          handle: () => "created",
        }),
      ],
    });
  }

  it("returns intent+actions+context schema with required intent,actions", () => {
    const d = compileActionTool(buildTool()).getToolDescription();
    expect(d.name).toBe("t");
    const s = d.inputSchema as unknown as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(s.required).toEqual(["intent", "actions"]);
    expect(s.properties.intent).toBeDefined();
    expect(s.properties.actions!.type).toBe("array");
    expect(s.properties.projectId).toBeDefined();
  });

  it("actions oneOf contains an item schema per action", () => {
    const d = compileActionTool(buildTool()).getToolDescription();
    // Draft 2020-12 positional tuples use `prefixItems` (the Anthropic tool-use form), not draft-07
    // `items`-array; the first prefix slot pins the action name.
    const items = (d.inputSchema as unknown as {
      properties: { actions: { items: { oneOf: { prefixItems: { const?: string }[] }[] } } };
    }).properties.actions.items.oneOf;
    expect(items).toHaveLength(1);
    expect(items[0].prefixItems[0]).toEqual({ const: "create" });
  });

  it("renders action-description with additionalNotes", () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      additionalNotes: "Please be careful",
      actions: (b) => [
        b.act({ name: "nop", needs: [], desc: "no-op", handle: () => 0 }),
      ],
    });
    const d = compileActionTool(tool).getToolDescription();
    const actionsDesc = (d.inputSchema as unknown as {
      properties: { actions: { description: string } };
    }).properties.actions.description;
    expect(actionsDesc).toContain("Please be careful");
    expect(actionsDesc).toContain("nop");
  });
});

describe("compileActionTool — intent validation", () => {
  function buildTool() {
    return defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [b.act({ name: "nop", needs: [], desc: "", handle: () => "ok" })],
    });
  }

  it("missing intent fails with validation error", async () => {
    const compiled = compileActionTool(buildTool());
    const result = await compiled.dispatch(
      { intent: "", actions: [["nop", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(result).toMatchObject({ success: false, validation: "failed" });
    if (!result.success && "validation" in result) {
      expect(result.errors[0].field).toBe("intent");
    }
  });

  it("non-string intent fails validation", async () => {
    const compiled = compileActionTool(buildTool());
    const result = await compiled.dispatch(
      // @ts-expect-error intentionally invalid
      { intent: 123, actions: [["nop", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(result).toMatchObject({ success: false, validation: "failed" });
  });

  it("valid intent proceeds to dispatch", async () => {
    const compiled = compileActionTool(buildTool());
    const result = await compiled.dispatch(
      { intent: "doing stuff", actions: [["nop", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(result).toMatchObject({ success: true, intent: "doing stuff" });
  });
});

describe("compileActionTool — context validation", () => {
  it("fails when required context fields missing", async () => {
    const tool = defineActionTool<{ projectId: string }, TestSvc>({
      name: "t",
      description: "",
      context: { projectId: str("id") },
      actions: (b) => [b.act({ name: "nop", needs: [], desc: "", handle: () => 0 })],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      { intent: "go", actions: [["nop", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      expect(r.errors[0].field).toBe("projectId");
    }
  });

  it("context fields are available on ctx at handle time", async () => {
    let seenCtx: any;
    const tool = defineActionTool<{ projectId: string }, TestSvc>({
      name: "t",
      description: "",
      context: { projectId: str() },
      actions: (b) => [
        b.act({
          name: "cap",
          needs: ["projectId"],
          desc: "",
          handle: (ctx) => {
            seenCtx = ctx;
            return "ok";
          },
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    await compiled.dispatch(
      { intent: "doing", actions: [["cap", {}]], contextInput: { projectId: "p-99" } },
      { apiName: "a" },
    );
    expect(seenCtx.projectId).toBe("p-99");
    expect(seenCtx.intent).toBe("doing");
  });
});

describe("compileActionTool — action validation", () => {
  function build() {
    return defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({
          name: "create",
          needs: [],
          desc: "",
          props: { name: str(), count: num() },
          handle: () => "ok",
        }),
      ],
    });
  }

  it("unknown action name fails validation listing available actions", async () => {
    const compiled = compileActionTool(build());
    const r = await compiled.dispatch(
      { intent: "x", actions: [["does-not-exist", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      expect(r.errors[0].message).toContain("unknown action");
      expect(r.errors[0].message).toContain("create");
    }
  });

  it("non-tuple action entries fail", async () => {
    const compiled = compileActionTool(build());
    const r = await compiled.dispatch(
      { intent: "x", actions: ["not-a-tuple"], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
  });

  it("missing required prop fails with field path", async () => {
    const compiled = compileActionTool(build());
    const r = await compiled.dispatch(
      { intent: "x", actions: [["create", { count: 5 }]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      const nameErr = r.errors.find((e) => e.field === "name");
      expect(nameErr).toBeDefined();
    }
  });

  it("needs-missing context fails with missing context message", async () => {
    const tool = defineActionTool<{ projectId?: string }, TestSvc>({
      name: "t",
      description: "",
      context: {
        projectId: { kind: "string", optional: true },
      },
      actions: (b) => [
        b.act({
          name: "mustHaveProject",
          needs: ["projectId"],
          desc: "",
          handle: () => "ok",
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      { intent: "x", actions: [["mustHaveProject", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      const msg = r.errors[0].message;
      expect(msg).toContain("missing context");
      expect(msg).toContain("projectId");
    }
  });

  it("receiver-mismatch fails with 'no receiver match'", async () => {
    const tool = defineActionTool<{ element?: Widget | Gadget }, TestSvc>({
      name: "t",
      description: "",
      context: { element: elementRef },
      actions: (b) => [
        b.act({
          name: "touch",
          on: Widget,
          needs: ["element"],
          desc: "",
          handle: () => "ok",
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      // A Gadget is provided where a Widget is expected.
      { intent: "x", actions: [["touch", {}]], contextInput: { element: new Gadget() } },
      { apiName: "a" },
    );
    // Receiver pick in the dispatch fails because Gadget.constructor !== Widget.
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      expect(r.errors[0].message).toContain("no receiver match");
    }
  });
});

describe("compileActionTool — dispatch & receiver-key", () => {
  it("dispatches on exact constructor match, passing the instance as receiver", async () => {
    const tool = defineActionTool<{ element?: Widget | Gadget }, TestSvc>({
      name: "t",
      description: "",
      context: { element: elementRef },
      actions: (b) => [
        b.act({
          name: "touch",
          on: Widget,
          needs: ["element"],
          desc: "",
          handle: (_ctx, recv) => `W:${(recv as Widget).id}`,
        }),
        b.act({
          name: "touch",
          on: Gadget,
          needs: ["element"],
          desc: "",
          handle: (_ctx, recv) => `G:${(recv as Gadget).id}`,
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r1 = await compiled.dispatch(
      { intent: "x", actions: [["touch", {}]], contextInput: { element: new Widget("a") } },
      { apiName: "a" },
    );
    expect(r1).toMatchObject({ success: true, results: ["W:a"] });

    const r2 = await compiled.dispatch(
      { intent: "x", actions: [["touch", {}]], contextInput: { element: new Gadget("b") } },
      { apiName: "a" },
    );
    expect(r2).toMatchObject({ success: true, results: ["G:b"] });
  });
});

describe("compileActionTool — stop-on-first-failure semantics", () => {
  it("throws from handler: returns partial result with prior results", async () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({ name: "a", needs: [], desc: "", handle: () => "A-OK" }),
        b.act({
          name: "boom",
          needs: [],
          desc: "",
          handle: () => {
            throw new Error("kaboom");
          },
        }),
        b.act({ name: "c", needs: [], desc: "", handle: () => "C-OK" }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      {
        intent: "x",
        actions: [["a", {}], ["boom", {}], ["c", {}]],
        contextInput: {},
      },
      { apiName: "a" },
    );
    expect(r).toMatchObject({
      success: false,
      partial: true,
      executed: 1,
      total: 3,
      results: ["A-OK"],
      failedAction: { index: 1, name: "boom", error: "kaboom" },
    });
  });

  it("returns success=true with all results when all handlers pass", async () => {
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({ name: "a", needs: [], desc: "", handle: () => "A" }),
        b.act({ name: "b", needs: [], desc: "", handle: () => "B" }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      { intent: "go", actions: [["a", {}], ["b", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toEqual({ success: true, intent: "go", results: ["A", "B"] });
  });
});

describe("compileActionTool — prepare / cleanup lifecycle", () => {
  it("prepare runs, cleanup runs after success", async () => {
    const prepareFn = vi.fn(async () => ({ prep: { extra: "e" }, cleanup: vi.fn() }));
    const tool = defineActionTool<BaseCtxShape, TestSvc, { extra: string }>({
      name: "t",
      description: "",
      context: {},
      prepare: prepareFn,
      actions: (b) => [b.act({ name: "nop", needs: [], desc: "", handle: () => "ok" })],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      { intent: "x", actions: [["nop", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r.success).toBe(true);
    expect(prepareFn).toHaveBeenCalledTimes(1);
    const cleanup = (await prepareFn.mock.results[0].value).cleanup;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleanup runs even when a handler throws (stop-on-first-failure)", async () => {
    const cleanup = vi.fn();
    const tool = defineActionTool<BaseCtxShape, TestSvc, { extra: string }>({
      name: "t",
      description: "",
      context: {},
      prepare: async () => ({ prep: { extra: "e" }, cleanup }),
      actions: (b) => [
        b.act({
          name: "boom",
          needs: [],
          desc: "",
          handle: () => {
            throw new Error("handler failed");
          },
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      { intent: "x", actions: [["boom", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r.success).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleanup runs after a validation failure (dispatches finally branch even on early-return)", async () => {
    const cleanup = vi.fn();
    const tool = defineActionTool<BaseCtxShape, TestSvc, { extra: string }>({
      name: "t",
      description: "",
      context: {},
      prepare: async () => ({ prep: { extra: "e" }, cleanup }),
      actions: (b) => [b.act({ name: "nop", needs: [], desc: "", handle: () => 0 })],
    });
    const compiled = compileActionTool(tool);
    // Send an unknown action to trigger per-action validation errors (after prepare).
    const r = await compiled.dispatch(
      { intent: "x", actions: [["does-not-exist", {}]], contextInput: {} },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("prep fields are available on ctx when prepare is set", async () => {
    let seen: any;
    const tool = defineActionTool<BaseCtxShape, TestSvc, { who: string }>({
      name: "t",
      description: "",
      context: {},
      prepare: async (_ctx, svc) => ({ prep: { who: `${svc.apiName}-prep` } }),
      actions: (b) => [
        b.act({
          name: "cap",
          needs: [],
          desc: "",
          handle: (ctx) => {
            seen = ctx;
            return "ok";
          },
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    await compiled.dispatch(
      { intent: "x", actions: [["cap", {}]], contextInput: {} },
      { apiName: "myApi" },
    );
    expect(seen.who).toBe("myApi-prep");
    // When prepare is provided, svc is NOT spread into ctx automatically.
    expect(seen.apiName).toBeUndefined();
  });

  it("services are passthrough when prepare is omitted", async () => {
    let seen: any;
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({
          name: "cap",
          needs: [],
          desc: "",
          handle: (ctx) => {
            seen = ctx;
            return "ok";
          },
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    await compiled.dispatch(
      { intent: "x", actions: [["cap", {}]], contextInput: {} },
      { apiName: "svcA" },
    );
    expect(seen.apiName).toBe("svcA");
  });
});

describe("compileActionTool — accumulated validation errors", () => {
  it("reports multiple validation errors in a single pass, no actions execute", async () => {
    const handler = vi.fn();
    const tool = defineActionTool<BaseCtxShape, TestSvc>({
      name: "t",
      description: "",
      context: {},
      actions: (b) => [
        b.act({
          name: "create",
          needs: [],
          desc: "",
          props: { name: str() },
          handle: handler,
        }),
      ],
    });
    const compiled = compileActionTool(tool);
    const r = await compiled.dispatch(
      {
        intent: "x",
        actions: [
          ["create", { name: "valid" }],
          ["unknown", {}],
          ["create", {}],
        ],
        contextInput: {},
      },
      { apiName: "a" },
    );
    expect(r).toMatchObject({ success: false, validation: "failed" });
    if (!r.success && "errors" in r) {
      // Errors should point at indices 1 and 2, not 0.
      const indices = r.errors.map((e) => e.actionIndex);
      expect(indices).toContain(1);
      expect(indices).toContain(2);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
