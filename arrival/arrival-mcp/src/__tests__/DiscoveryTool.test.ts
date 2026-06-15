import { port, type Resource } from "@here.build/arrival-scheme/resources";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { DiscoveryTool, type InteractionLog } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

// A host-armed resource whose handle is derived from the per-call config — the "just use resources"
// binding channel. `acquire` is where authorization would live (a resource that refuses to spawn).
const greeter = (cfg: { who: string }): Resource<{ hello: () => string }> => ({
  kind: "greeter",
  async acquire() {
    return port({ hello: () => `hi ${cfg.who}` }, () => {});
  },
});

/** A capability the host builds per connection: one actor-arg (`who`) + one resource (`greeter`). */
function demoCapability(): McpEnvCapability {
  return new McpEnvCapability("demo-caps", {
    configuration: { who: z.string() },
    resources: { greeter: (cfg) => greeter(cfg as { who: string }) },
    symbols: {
      // verb reads BOTH channels: actor config + the eval-time resource.
      greet: {
        fn(this: { resources: { greeter: { live: { hello: () => string } } } }) {
          return this.resources.greeter.live.hello();
        },
      },
    },
    annotations: { greet: { description: "greets the configured person" } },
  });
}

describe("DiscoveryTool (value-shaped, capability-derived)", () => {
  it("describe(): input schema = expr + intent + the capability's configuration; catalog from annotations", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    const def = await tool.describe();
    expect(def.name).toBe("demo");
    const props = def.inputSchema.properties!;
    // `who` came from the capability's `configuration` — no separate contextSchema.
    expect(Object.keys(props).sort()).toEqual(["expr", "intent", "who"]);
    // the verb catalog is reflected off the capability's annotations.
    expect((props.expr as { description: string }).description).toContain("(greet)");
  });

  it("call(): config comes from the args, the resource spawns from it, the verb reads both", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    expect(await tool.call({ expr: "(greet)", who: "ada" })).toEqual(["'hi ada'"]);
  });

  it("threads the abort signal into the eval — a pre-aborted call fast-fails", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    await expect(tool.call({ expr: "(greet)", who: "ada" }, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("session state carries honest replay across calls (a define survives to the next call)", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define n 5)", who: "ada" }, { session });
    expect(await tool.call({ expr: "n", who: "ada" }, { session })).toEqual(["5"]);
  });

  it("structural cache: a penetration-define is RESTORED on replay, the verb is NOT re-fired", async () => {
    // `tick` stands in for a membrane penetration — its call count is observable.
    let calls = 0;
    const cap = new McpEnvCapability("tick-caps", {
      symbols: { tick: { fn: () => ++calls } },
      annotations: { tick: { description: "increments + returns a counter" } },
    });
    const tool = new DiscoveryTool("tick", cap, { description: "tick tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool.call({ expr: "(define a (tick))" }, { session }); // tick → 1
    expect(calls).toBe(1);
    await tool.call({ expr: "(define b (tick))" }, { session }); // replay a from cache (no tick) + b → 2
    expect(calls).toBe(2); // NOT 3 — a's (tick) was restored, not re-fired
    expect(await tool.call({ expr: "a" }, { session })).toEqual(["1"]); // a restored to its original value
    expect(calls).toBe(2); // reading a fires nothing
  });

  it("REPL-style partial success: earlier statements' values stand when a later one crashes", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    const out = await tool.call(
      { expr: "(+ 1 1)\n(+ 2 2)\n(this-verb-does-not-exist)", who: "ada" },
      { session: { id: "s1", state: {} } },
    );
    expect(out.slice(0, 2)).toEqual(["2", "4"]); // first two ran
    expect(out[2]).toMatch(/^\(error /); // third surfaced as a door, not a thrown call
  });

  it("a closure define re-runs on replay (penetration-free) and stays callable", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    // a lambda value isn't cacheable, so its statement re-runs — but defining it fires nothing.
    await tool.call({ expr: "(define inc (lambda (x) (+ x 1)))", who: "ada" }, { session });
    expect(await tool.call({ expr: "(inc 41)", who: "ada" }, { session })).toEqual(["42"]);
  });

  it("records the interaction with the session id + authed user (dispatch-time, above the eval)", async () => {
    const tool = new DiscoveryTool("demo", demoCapability(), { description: "demo tool" });
    const record = vi.fn<(i: InteractionLog) => void>();
    await tool.call(
      { expr: "(greet)", who: "ada", intent: "say hi" },
      { session: { id: "s1", state: {} }, user: { sub: "user_123" }, record },
    );
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      sessionId: "s1",
      userSub: "user_123",
      tool: "demo",
      intent: "say hi",
      success: true,
    });
  });
});
