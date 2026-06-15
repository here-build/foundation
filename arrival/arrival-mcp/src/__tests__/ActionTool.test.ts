import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { ActionTool } from "../ActionTool.js";
import type { InteractionLog } from "../DiscoveryTool.js";

/** A doc the actions mutate, so we can observe order + rollback. Action args are POSITIONAL
 *  (the executor zips them to the prop names), so `append` takes one arg: text. */
function makeTool() {
  const log: string[] = [];
  const tool = new ActionTool("doc-edit", {
    description: "edit a doc",
    // The shared scope, validated + transformed ONCE per batch (docId upper-cased here).
    contextSchema: { docId: z.string().transform((s) => s.toUpperCase()) },
    actions: (action) => ({
      append: action({
        description: "append text to the doc",
        context: ["docId"],
        props: { text: z.string() },
        // ctx.docId is typed (string), props.text is typed (string) — no casts.
        handler: (ctx, props) => {
          log.push(`${ctx.docId}:${props.text}`);
          return { ok: true, text: props.text };
        },
      }),
      boom: action({
        description: "always throws (for the rollback test)",
        props: {},
        handler: () => {
          throw new Error("kaboom");
        },
      }),
    }),
  });
  return { tool, log };
}

describe("ActionTool (value-shaped, typed builder)", () => {
  it("describe(): shared context declared ONCE at top level; actions as a oneOf of tuples", async () => {
    const { tool } = makeTool();
    const def = await tool.describe();
    const props = def.inputSchema.properties!;
    // docId declared once (not repeated per action), alongside intent + actions.
    expect(Object.keys(props).sort()).toEqual(["actions", "docId", "intent"]);
    // append needs docId but boom doesn't → not universally required.
    expect(def.inputSchema.required).toEqual(["actions"]);
  });

  it("runs a batch sharing one context scope; the transform applies once", async () => {
    const { tool, log } = makeTool();
    const res = (await tool.call({
      docId: "d1", // transformed once → "D1", shared by every action in the batch
      actions: [
        ["append", "a"],
        ["append", "b"],
      ],
    })) as { ok: boolean }[];
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    expect(log).toEqual(["D1:a", "D1:b"]);
  });

  it("rollback-report: a runtime failure stops the batch and reports what ran", async () => {
    const { tool, log } = makeTool();
    const res = (await tool.call({
      docId: "d1",
      actions: [["append", "a"], ["boom"], ["append", "c"]],
    })) as { success: boolean; partial: boolean; executed: number; failedAction: { action: string } };
    expect(res.success).toBe(false);
    expect(res.partial).toBe(true);
    expect(res.executed).toBe(1); // only the first append ran
    expect(res.failedAction.action).toBe("boom");
    expect(log).toEqual(["D1:a"]); // the third never ran
  });

  it("validation error: a bad arg is reported as an sexpr, NO actions executed", async () => {
    const { tool, log } = makeTool();
    const res = (await tool.call({
      docId: "d1",
      actions: [["append", 42]], // text must be a string
    })) as { success: boolean; validation: string; sexpr: string };
    expect(res.success).toBe(false);
    expect(res.validation).toBe("failed");
    expect(res.sexpr).toContain("append");
    expect(log).toEqual([]); // nothing ran
  });

  it("a pre-aborted signal cancels the batch before any action", async () => {
    const { tool, log } = makeTool();
    await expect(
      tool.call({ docId: "d1", actions: [["append", "a"]] }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(log).toEqual([]);
  });

  it("records the interaction (session id + authed user, success flag)", async () => {
    const { tool } = makeTool();
    const record = vi.fn<(i: InteractionLog) => void>();
    await tool.call(
      { docId: "d1", intent: "add a", actions: [["append", "a"]] },
      { session: { id: "s1", state: {} }, user: { sub: "u_1" }, record },
    );
    expect(record.mock.calls[0]![0]).toMatchObject({ sessionId: "s1", userSub: "u_1", tool: "doc-edit", intent: "add a", success: true });
  });
});
