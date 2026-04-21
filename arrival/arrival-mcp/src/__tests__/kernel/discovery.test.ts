import { describe, expect, it } from "vitest";

import { compileDiscoveryTool, defineDiscoveryTool } from "../../kernel/discovery";
import { instanceShape, num, str, defineRef, uuidShape } from "../../kernel/refs";

// ─── Local test classes (stand-ins for model classes) ──────────────────────

class TplTag {
  constructor(public name: string = "div") {}
  get kind() {
    return "tag" as const;
  }
}

class TplComponent {
  constructor(public componentName: string = "Button") {}
  get kind() {
    return "component" as const;
  }
}

class TplSlot {
  constructor(public slotName: string = "children") {}
  get kind() {
    return "slot" as const;
  }
}

interface TestSvc extends Record<string, any> {
  apiName: string;
  counter: number;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("defineDiscoveryTool — construction & validation", () => {
  it("constructs a tool with kind 'discovery' and stores spec fields", () => {
    const tool = defineDiscoveryTool<{ projectId: string }, TestSvc>({
      name: "test-disc",
      description: "a discovery tool",
      context: { projectId: str("project UUID") },
      fns: (b) => [
        b.fn({
          name: "ping",
          desc: "health check",
          impl: () => "pong",
        }),
      ],
    });
    expect(tool.kind).toBe("discovery");
    expect(tool.name).toBe("test-disc");
    expect(tool.description).toBe("a discovery tool");
    expect(tool.fns).toHaveLength(1);
    expect(tool.fns[0].name).toBe("ping");
  });

  it("throws on duplicate fn name+receiver", () => {
    expect(() =>
      defineDiscoveryTool({
        name: "x",
        description: "",
        context: {},
        fns: (b) => [
          b.fn({ name: "dup", desc: "a", impl: () => 1 }),
          b.fn({ name: "dup", desc: "b", impl: () => 2 }),
        ],
      }),
    ).toThrow(/duplicate fn "dup"/);
  });

  it("allows same name across different receiver classes (polymorphism)", () => {
    const tool = defineDiscoveryTool({
      name: "x",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({ name: "children", on: TplTag, desc: "tag kids", impl: () => [] }),
        b.fn({ name: "children", on: TplComponent, desc: "comp kids", impl: () => [] }),
        b.fn({ name: "children", on: TplSlot, desc: "slot kids", impl: () => [] }),
      ],
    });
    expect(tool.fns).toHaveLength(3);
  });

  it("throws on duplicate fn name+receiver with aliases clashing", () => {
    expect(() =>
      defineDiscoveryTool({
        name: "x",
        description: "",
        context: {},
        fns: (b) => [
          b.fn({ name: "a", aliases: ["b"], desc: "", impl: () => 1 }),
          b.fn({ name: "b", desc: "", impl: () => 2 }),
        ],
      }),
    ).toThrow(/duplicate fn "b"/);
  });
});

describe("FnBuilder.methodsOf", () => {
  it("expands methods record into fns with receiver class", () => {
    class Thing {
      get label() {
        return "my-label";
      }
      name() {
        return "my-name";
      }
    }
    const tool = defineDiscoveryTool({
      name: "x",
      description: "",
      context: {},
      fns: (b) => b.methodsOf(Thing, { label: true, name: { alias: "nameOf" } }),
    });
    expect(tool.fns).toHaveLength(2);
    const names = tool.fns.map((f) => f.name).sort();
    expect(names).toEqual(["label", "nameOf"]);
    for (const f of tool.fns) expect(f.on).toBe(Thing);
  });

  it("methodsOf-generated fn invokes method OR returns property", async () => {
    class Thing {
      get label() {
        return "from-getter";
      }
      name() {
        return "from-method";
      }
    }
    const tool = defineDiscoveryTool({
      name: "x",
      description: "",
      context: {},
      fns: (b) => b.methodsOf(Thing, { label: true, name: true }),
    });
    const t = new Thing();
    const labelFn = tool.fns.find((f) => f.name === "label")!;
    const nameFn = tool.fns.find((f) => f.name === "name")!;
    expect(await labelFn.impl({}, t, {})).toBe("from-getter");
    expect(await nameFn.impl({}, t, {})).toBe("from-method");
  });
});

describe("compileDiscoveryTool — getToolDescription / schema", () => {
  it("returns an MCP Tool with expected top-level shape", async () => {
    const tool = defineDiscoveryTool({
      name: "disc",
      description: "hi",
      context: { projectId: str("id") },
      fns: (b) => [b.fn({ name: "ping", desc: "say hi", impl: () => "pong" })],
    });
    const compiled = compileDiscoveryTool(tool);
    const d = await compiled.getToolDescription(undefined, undefined);
    expect(d.name).toBe("disc");
    expect(d.description).toBe("hi");
    expect((d as { annotations?: unknown }).annotations).toEqual({ readOnlyHint: true });
    const inputSchema = d.inputSchema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(inputSchema.type).toBe("object");
    expect(inputSchema.required).toEqual(["expr"]);
    expect(inputSchema.properties.expr).toBeDefined();
    expect(inputSchema.properties.intent).toBeDefined();
    expect(inputSchema.properties.projectId).toBeDefined();
  });

  it("signature rendering includes static fn desc and (name) syntax", async () => {
    const tool = defineDiscoveryTool({
      name: "disc",
      description: "",
      context: {},
      fns: (b) => [b.fn({ name: "xyz", desc: "Do XYZ", impl: () => 1 })],
    });
    const compiled = compileDiscoveryTool(tool);
    const d = await compiled.getToolDescription(undefined);
    const exprDesc: string = (d.inputSchema as unknown as { properties: { expr: { description: string } } }).properties.expr.description;
    expect(exprDesc).toContain("(xyz)");
    expect(exprDesc).toContain("Do XYZ");
  });

  it("dynamic desc closure is invoked with services at schema-gen time", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "disc",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({
          name: "count",
          desc: (svc) => `current counter: ${svc.counter}`,
          impl: () => 0,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const d = await compiled.getToolDescription(undefined, { apiName: "a", counter: 42 });
    const exprDesc = (d.inputSchema as unknown as { properties: { expr: { description: string } } }).properties.expr.description as string;
    expect(exprDesc).toContain("current counter: 42");
  });

  it("dynamic desc object { dynamic: true } adds LIVE DESCRIPTION footer", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "disc",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({
          name: "report",
          desc: (svc) => ({ dynamic: true, value: `report for ${svc.apiName}` }),
          impl: () => 0,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const d = await compiled.getToolDescription(undefined, { apiName: "api-1", counter: 0 });
    const exprDesc = (d.inputSchema as unknown as { properties: { expr: { description: string } } }).properties.expr.description as string;
    expect(exprDesc).toContain("LIVE DESCRIPTION");
    expect(exprDesc).toContain("report for api-1");
  });

  it("personalize is invoked with clientInfo to flavor dynamic-description note", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      personalize: (c) => String(c?.name ?? "UNSET"),
      fns: (b) => [
        b.fn({
          name: "f",
          desc: () => ({ dynamic: true, value: "live" }),
          impl: () => 0,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const d = await compiled.getToolDescription({ name: "Alice" }, { apiName: "a", counter: 0 });
    const exprDesc = (d.inputSchema as unknown as { properties: { expr: { description: string } } }).properties.expr.description as string;
    expect(exprDesc).toContain("ALICE");
  });
});

describe("compileDiscoveryTool — execute / dispatch", () => {
  it("runs a standalone fn and returns serialized result", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [b.fn({ name: "ping", desc: "", impl: () => "pong" })],
    });
    const compiled = compileDiscoveryTool(tool);
    const { result, replay } = await compiled.execute(
      { contextInput: {}, expr: "(ping)" },
      { apiName: "a", counter: 0 },
    );
    expect(replay).toBe("(ping)");
    expect(Array.isArray(result)).toBe(true);
    // execSerialized returns ["'pong'"] for a string result.
    expect((result as string[])[0]).toContain("pong");
  });

  it("exposes entity symbols under `entities` namespace", async () => {
    const tag = new TplTag("span");
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      symbols: () => ({ mytag: tag }),
      fns: (b) => [
        b.fn({
          name: "kind",
          on: TplTag,
          desc: "",
          impl: (_ctx, recv: unknown) => (recv as TplTag).name,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const { result } = await compiled.execute(
      { contextInput: {}, expr: "(kind entities.mytag)" },
      { apiName: "a", counter: 0 },
    );
    expect((result as string[])[0]).toContain("span");
  });

  it("dispatches polymorphically on exact constructor of first argument", async () => {
    const tag = new TplTag();
    const comp = new TplComponent();
    const slot = new TplSlot();
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      symbols: () => ({ tag, comp, slot }),
      fns: (b) => [
        b.fn({
          name: "children",
          on: TplTag,
          desc: "",
          impl: () => "tag-children",
        }),
        b.fn({
          name: "children",
          on: TplComponent,
          desc: "",
          impl: () => "comp-children",
        }),
        b.fn({
          name: "children",
          on: TplSlot,
          desc: "",
          impl: () => "slot-children",
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const svc = { apiName: "a", counter: 0 };

    const r1 = await compiled.execute({ contextInput: {}, expr: "(children entities.tag)" }, svc);
    expect((r1.result as string[])[0]).toContain("tag-children");

    const r2 = await compiled.execute({ contextInput: {}, expr: "(children entities.comp)" }, svc);
    expect((r2.result as string[])[0]).toContain("comp-children");

    const r3 = await compiled.execute({ contextInput: {}, expr: "(children entities.slot)" }, svc);
    expect((r3.result as string[])[0]).toContain("slot-children");
  });

  it("throws with expected receiver classes when no match", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      symbols: () => ({ tag: new TplTag() }),
      fns: (b) => [
        b.fn({
          name: "onComp",
          on: TplComponent,
          desc: "",
          impl: () => "ok",
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    await expect(
      compiled.execute(
        { contextInput: {}, expr: "(onComp entities.tag)" },
        { apiName: "a", counter: 0 },
      ),
    ).rejects.toThrow(/no receiver match/);
  });

  it("falls back to standalone fn when no class match", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({ name: "probe", desc: "", impl: () => "standalone" }),
        b.fn({ name: "probe", on: TplTag, desc: "", impl: () => "on-tag" }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    // Calling (probe) with no args → standalone.
    const { result } = await compiled.execute(
      { contextInput: {}, expr: "(probe)" },
      { apiName: "a", counter: 0 },
    );
    expect((result as string[])[0]).toContain("standalone");
  });

  it("executes history before expr, returns the final expr's result", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [b.fn({ name: "ping", desc: "", impl: () => "pong" })],
    });
    const compiled = compileDiscoveryTool(tool);
    const { result } = await compiled.execute(
      { contextInput: {}, expr: "(+ 1 2)", history: ["(define x 10)"] },
      { apiName: "a", counter: 0 },
    );
    expect((result as string[])[0]).toContain("3");
  });

  it("services-as-prep default — ctx receives svc fields when prepare is omitted", async () => {
    let seenCtx: any = null;
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({
          name: "cap",
          desc: "",
          impl: (ctx) => {
            seenCtx = ctx;
            return "ok";
          },
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    await compiled.execute({ contextInput: {}, expr: "(cap)" }, { apiName: "remote", counter: 9 });
    expect(seenCtx.apiName).toBe("remote");
    expect(seenCtx.counter).toBe(9);
  });

  it("prepare overrides the services passthrough — ctx gets Prep fields", async () => {
    let seenCtx: any = null;
    const tool = defineDiscoveryTool<{ projectId: string }, TestSvc, { derived: string }>({
      name: "d",
      description: "",
      context: { projectId: str() },
      prepare: async (ctx, svc) => ({ derived: `${svc.apiName}:${ctx.projectId}` }),
      fns: (b) => [
        b.fn({
          name: "cap",
          desc: "",
          impl: (ctx) => {
            seenCtx = ctx;
            return "ok";
          },
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    await compiled.execute(
      { contextInput: { projectId: "p-1" }, expr: "(cap)" },
      { apiName: "A", counter: 0 },
    );
    expect(seenCtx.projectId).toBe("p-1");
    expect(seenCtx.derived).toBe("A:p-1");
    // apiName is not in ctx because prepare replaced svc-passthrough.
    expect(seenCtx.apiName).toBeUndefined();
  });

  it("parses context via FieldSpec — invalid shape fails with 'context:' prefix", async () => {
    const tool = defineDiscoveryTool<{ projectId: string }, TestSvc>({
      name: "d",
      description: "",
      context: { projectId: str("required") },
      fns: (b) => [b.fn({ name: "ping", desc: "", impl: () => 1 })],
    });
    const compiled = compileDiscoveryTool(tool);
    await expect(
      compiled.execute(
        { contextInput: {}, expr: "(ping)" },
        { apiName: "a", counter: 0 },
      ),
    ).rejects.toThrow(/context:.*projectId/);
  });

  it("parses fn params using FieldSpec (primitives)", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({
          name: "add",
          desc: "",
          params: { a: num(), b: num() },
          impl: (_ctx, _recv, params) => (params.a as number) + (params.b as number),
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const { result } = await compiled.execute(
      { contextInput: {}, expr: "(add 3 4)" },
      { apiName: "a", counter: 0 },
    );
    expect((result as string[])[0]).toContain("7");
  });

  it("params parsing emits descriptive error on type mismatch", async () => {
    const tool = defineDiscoveryTool<{}, TestSvc>({
      name: "d",
      description: "",
      context: {},
      fns: (b) => [
        b.fn({
          name: "takeN",
          desc: "",
          params: { n: num() },
          impl: () => 0,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    await expect(
      compiled.execute(
        { contextInput: {}, expr: `(takeN "not-a-number")` },
        { apiName: "a", counter: 0 },
      ),
    ).rejects.toThrow(/n:.*number/);
  });

  it("uses a Ref field as a context parameter and resolves it", async () => {
    const db = new Map<string, { id: string; label: string }>([
      ["u-42", { id: "u-42", label: "forty-two" }],
    ]);
    const itemRef = defineRef<{ id: string; label: string }, { apiName: string; counter: number }>({
      typeName: "Item",
      desc: "",
      shapes: [uuidShape((id) => db.get(id) ?? null)],
    });
    const tool = defineDiscoveryTool<{ item: { id: string; label: string } }, TestSvc>({
      name: "d",
      description: "",
      context: { item: itemRef },
      fns: (b) => [
        b.fn({
          name: "label",
          desc: "",
          impl: (ctx) => ctx.item.label,
        }),
      ],
    });
    const compiled = compileDiscoveryTool(tool);
    const { result } = await compiled.execute(
      { contextInput: { item: "u-42" }, expr: "(label)" },
      { apiName: "a", counter: 0 },
    );
    expect((result as string[])[0]).toContain("forty-two");
  });
});
