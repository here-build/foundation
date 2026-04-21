/**
 * Integration tests for H7 safety fabric wired into the action dispatcher:
 *   - Per-phase timeouts (prepare / handler / batch)
 *   - Action-count size limit
 */
import { describe, expect, it } from "vitest";

import {
  compileActionTool,
  defineActionTool,
  defineCluster,
} from "../../kernel/action";
import { str } from "../../kernel/refs";

interface TestSvc extends Record<string, any> {}
type BaseCtx = {};

describe("safety fabric — timeouts in action dispatch", () => {
  it("handler timeout: single slow handler fails with typed batch error", async () => {
    const slowCluster = defineCluster<BaseCtx & { intent: string }>({
      name: "slow",
      actions: (b) => [
        b.act({
          name: "hang",
          needs: ["intent"],
          desc: "sleeps longer than handler timeout",
          props: { ms: str("wait ms") },
          handle: async (_ctx, _receiver, { ms }) => {
            await new Promise((r) => setTimeout(r, Number(ms)));
            return { ok: true };
          },
        }),
      ],
    });
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      clusters: [slowCluster],
      timeouts: { handler: 20 }, // very short deadline
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      {
        intent: "slow it down",
        actions: [["hang", { ms: "200" }]],
        contextInput: {},
      },
      {},
    );

    expect(result.success).toBe(false);
    // @ts-expect-error partial-branch
    expect(result.partial).toBe(true);
    // @ts-expect-error partial-branch
    expect(result.failedAction.error).toMatch(/exceeded deadline/);
  });

  it("prepare timeout: prepare that hangs fails with prepare validation error", async () => {
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      prepare: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { prep: {} };
      },
      clusters: [
        defineCluster<BaseCtx & { intent: string }>({
          name: "x",
          actions: (b) => [
            b.act({ name: "noop", needs: ["intent"], desc: "", handle: async () => undefined }),
          ],
        }),
      ],
      timeouts: { prepare: 20 },
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      { intent: "hang prepare", actions: [["noop", {}]], contextInput: {} },
      {},
    );

    expect(result.success).toBe(false);
    // @ts-expect-error validation-branch
    expect(result.validation).toBe("failed");
    // @ts-expect-error validation-branch
    expect(result.errors[0].field).toBe("<prepare>");
    // @ts-expect-error validation-branch
    expect(result.errors[0].message).toMatch(/exceeded deadline/);
  });

  it("batch timeout: cumulative batch exceeds deadline even if each handler is fast", async () => {
    const cluster = defineCluster<BaseCtx & { intent: string }>({
      name: "many",
      actions: (b) => [
        b.act({
          name: "slow-ish",
          needs: ["intent"],
          desc: "",
          handle: async () => {
            await new Promise((r) => setTimeout(r, 30));
            return undefined;
          },
        }),
      ],
    });
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      clusters: [cluster],
      // Handler deadline allows each 30ms; batch deadline doesn't.
      timeouts: { handler: 500, batch: 50 },
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      {
        intent: "many slow",
        actions: Array.from({ length: 5 }, () => ["slow-ish", {}]),
        contextInput: {},
      },
      {},
    );

    expect(result.success).toBe(false);
    // @ts-expect-error partial-branch
    expect(result.partial).toBe(true);
  });

  it("handler that completes under deadline succeeds normally", async () => {
    const cluster = defineCluster<BaseCtx & { intent: string }>({
      name: "quick",
      actions: (b) => [
        b.act({
          name: "fast",
          needs: ["intent"],
          desc: "",
          handle: async () => ({ done: true }),
        }),
      ],
    });
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      clusters: [cluster],
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      { intent: "go", actions: [["fast", {}]], contextInput: {} },
      {},
    );

    expect(result.success).toBe(true);
  });
});

describe("safety fabric — size limits in action dispatch", () => {
  it("maxActions: batch over the limit rejected with size-limit error", async () => {
    const cluster = defineCluster<BaseCtx & { intent: string }>({
      name: "many",
      actions: (b) => [
        b.act({ name: "noop", needs: ["intent"], desc: "", handle: async () => undefined }),
      ],
    });
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      clusters: [cluster],
      limits: { maxActions: 3 },
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      {
        intent: "too many",
        actions: Array.from({ length: 5 }, () => ["noop", {}]),
        contextInput: {},
      },
      {},
    );

    expect(result.success).toBe(false);
    // @ts-expect-error validation-branch
    expect(result.validation).toBe("failed");
    // @ts-expect-error validation-branch
    expect(result.errors[0].field).toBe("actions");
    // @ts-expect-error validation-branch
    expect(result.errors[0].message).toMatch(/exceeded: 5 > 3/);
  });

  it("maxActions default (50): batch under default limit accepted", async () => {
    const cluster = defineCluster<BaseCtx & { intent: string }>({
      name: "many",
      actions: (b) => [
        b.act({ name: "noop", needs: ["intent"], desc: "", handle: async () => undefined }),
      ],
    });
    const tool = defineActionTool<BaseCtx, TestSvc>({
      name: "t",
      description: "",
      context: {},
      clusters: [cluster],
    });
    const compiled = compileActionTool(tool);

    const result = await compiled.dispatch(
      {
        intent: "ok",
        actions: Array.from({ length: 10 }, () => ["noop", {}]),
        contextInput: {},
      },
      {},
    );

    expect(result.success).toBe(true);
  });
});
