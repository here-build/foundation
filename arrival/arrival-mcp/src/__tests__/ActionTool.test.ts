import { describe, expect, it, vi } from "vitest";

import { ActionTool, defineCluster } from "../ActionTool.js";
import type { InteractionLog } from "../DiscoveryTool.js";
import { defineRef, instanceShape, str } from "../refs.js";

// ── Local receiver classes (exact-class dispatch targets) ──────────────────────
class Widget {
  constructor(public id = "w-1") {}
}
class Gadget {
  constructor(public id = "g-1") {}
}
const elementRef = defineRef<Widget | Gadget, unknown>({
  typeName: "Element",
  desc: "a Widget or Gadget",
  shapes: [instanceShape(Widget), instanceShape(Gadget)],
});

/** A doc the actions mutate, so we can observe order + rollback. Props are a NAMED object:
 *  `["append", { text }]`. Context `docId` is a primitive; `prepare` derives an upper-cased stamp. */
function makeTool() {
  const log: string[] = [];
  const tool = new ActionTool<{ docId: string }, { stamp: string }>("doc-edit", {
    description: "edit a doc",
    context: { docId: str("the doc id") },
    // prepare runs once per batch (after primitive ctx parses); its prep merges into every handler's ctx.
    prepare: async (ctx) => ({ prep: { stamp: ctx.docId.toUpperCase() } }),
    actions: (b) => [
      b.act({
        name: "append",
        needs: ["docId"],
        desc: "append text to the doc",
        props: { text: str() },
        handle: (ctx, _r, { text }) => {
          log.push(`${ctx.stamp}:${text}`);
          return { ok: true, text };
        },
      }),
      b.act({
        name: "boom",
        needs: [],
        desc: "always throws (rollback test)",
        handle: () => {
          throw new Error("kaboom");
        },
      }),
    ],
  });
  return { tool, log };
}

describe("ActionTool — value-shape, named-props, FieldSpec", () => {
  it("describe(): shared context declared ONCE; actions as a oneOf of [name, props] tuples", async () => {
    const { tool } = makeTool();
    const def = await tool.describe();
    const props = def.inputSchema.properties!;
    expect(Object.keys(props).toSorted((a, b) => a.localeCompare(b))).toEqual(["actions", "docId", "intent"]);
    expect(def.inputSchema.required).toEqual(["intent", "actions"]);
    const oneOf = (props.actions as { items: { oneOf: { prefixItems: [{ const: string }, object] }[] } }).items.oneOf;
    expect(oneOf.map((o) => o.prefixItems[0].const).toSorted((a, b) => a.localeCompare(b))).toEqual(["append", "boom"]);
  });

  it("runs a batch sharing one context scope; prepare's prep is visible to every handler", async () => {
    const { tool, log } = makeTool();
    const res = await tool.call({
      intent: "edit",
      docId: "d1",
      actions: [
        ["append", { text: "a" }],
        ["append", { text: "b" }],
      ],
    });
    expect(res.success).toBe(true);
    expect("results" in res && res.results).toEqual([
      { ok: true, text: "a" },
      { ok: true, text: "b" },
    ]);
    expect(log).toEqual(["D1:a", "D1:b"]);
  });

  it("rollback-report: a runtime failure stops the batch and reports what ran", async () => {
    const { tool, log } = makeTool();
    const res = await tool.call({
      intent: "edit",
      docId: "d1",
      actions: [["append", { text: "a" }], ["boom"], ["append", { text: "c" }]],
    });
    expect(res.success).toBe(false);
    expect("partial" in res && res.partial).toBe(true);
    expect("executed" in res && res.executed).toBe(1);
    expect((res as any).failedAction.name).toBe("boom");
    expect(log).toEqual(["D1:a"]);
  });

  it("validation error: a bad prop is reported, NO actions executed", async () => {
    const { tool, log } = makeTool();
    const res = await tool.call({ intent: "edit", docId: "d1", actions: [["append", { text: 42 }]] });
    expect(res.success).toBe(false);
    expect("validation" in res && res.validation).toBe("failed");
    expect((res as any).errors[0].actionName).toBe("append");
    expect(log).toEqual([]);
  });

  it("missing intent is a validation error", async () => {
    const { tool } = makeTool();
    const res = await tool.call({ docId: "d1", actions: [["append", { text: "a" }]] });
    expect(res.success).toBe(false);
    expect((res as any).errors[0].field).toBe("intent");
  });

  it("receiver-dispatch: one name, different handler per receiver class", async () => {
    const seen: string[] = [];
    const tool = new ActionTool<{ element?: Widget | Gadget }>("rx", {
      description: "receiver dispatch",
      context: { element: elementRef.optional() },
      clusters: [
        defineCluster<{ element?: Widget | Gadget; intent: string }>({
          name: "rx",
          actions: (b) => [
            b.act({
              name: "tap",
              needs: ["element"],
              on: Widget,
              desc: "tap a widget",
              handle: (_c, r) => {
                seen.push(`widget:${(r as Widget).id}`);
              },
            }),
            b.act({
              name: "tap",
              needs: ["element"],
              on: Gadget,
              desc: "tap a gadget",
              handle: (_c, r) => {
                seen.push(`gadget:${(r as Gadget).id}`);
              },
            }),
          ],
        }),
      ],
    });
    await tool.call({ intent: "t", element: new Widget("w9"), actions: [["tap"]] });
    await tool.call({ intent: "t", element: new Gadget("g9"), actions: [["tap"]] });
    expect(seen).toEqual(["widget:w9", "gadget:g9"]);
  });

  it("shapeResponse customizes the success envelope", async () => {
    const tool = new ActionTool<{ docId: string }>("shaped", {
      description: "shaped",
      context: { docId: str() },
      shapeResponse: (ctx, results) => ({ context: { docId: ctx.docId }, created: results.length }),
      actions: (b) => [b.act({ name: "noop", needs: [], desc: "noop", handle: () => 1 })],
    });
    const res = await tool.call({ intent: "x", docId: "d1", actions: [["noop"], ["noop"]] });
    expect(res).toMatchObject({ success: true, context: { docId: "d1" }, created: 2 });
  });

  it("a pre-aborted signal cancels the batch before any action", async () => {
    const { tool, log } = makeTool();
    await expect(
      tool.call({ intent: "x", docId: "d1", actions: [["append", { text: "a" }]] }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(log).toEqual([]);
  });

  it("wrapBatch brackets the whole burst; its finally runs even when an action fails", async () => {
    const log: string[] = [];
    let online = true;
    const tool = new ActionTool<{ docId: string }>("doc-edit", {
      description: "edit a doc",
      context: { docId: str() },
      wrapBatch: async (_ctx, runBatch) => {
        online = false;
        log.push("offline");
        try {
          const results = await runBatch();
          log.push("flush");
          return results;
        } finally {
          online = true;
          log.push("online");
        }
      },
      actions: (b) => [
        b.act({
          name: "ok",
          needs: [],
          desc: "ok",
          handle: () => {
            log.push("ok");
            return { ok: true };
          },
        }),
        b.act({
          name: "boom",
          needs: [],
          desc: "throws",
          handle: () => {
            throw new Error("kaboom");
          },
        }),
      ],
    });

    const ok = await tool.call({ intent: "x", docId: "d1", actions: [["ok"]] });
    expect(ok.success).toBe(true);
    expect(log).toEqual(["offline", "ok", "flush", "online"]);
    expect(online).toBe(true);

    log.length = 0;
    const fail = await tool.call({ intent: "x", docId: "d1", actions: [["ok"], ["boom"]] });
    expect("partial" in fail && fail.partial).toBe(true);
    expect("executed" in fail && fail.executed).toBe(1);
    expect(log).toEqual(["offline", "ok", "online"]); // no "flush" (threw before it); "online" still ran
    expect(online).toBe(true);
  });

  it("records the interaction (session id + authed user, success flag)", async () => {
    const { tool } = makeTool();
    const record = vi.fn<(i: InteractionLog) => void>();
    await tool.call(
      { intent: "add a", docId: "d1", actions: [["append", { text: "a" }]] },
      { session: { id: "s1", state: {} }, user: { sub: "u_1" }, record },
    );
    expect(record.mock.calls[0]![0]).toMatchObject({
      sessionId: "s1",
      userSub: "u_1",
      tool: "doc-edit",
      intent: "add a",
      success: true,
    });
  });
});
