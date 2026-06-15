import { port, type Resource } from "@here.build/arrival-scheme/resources";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { ActionTool } from "../ActionTool.js";
import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { str } from "../refs.js";
import { type McpTool, registerTools } from "../sdk-adapter.js";

const greeter = (cfg: { who: string }): Resource<{ hello: () => string }> => ({
  kind: "greeter",
  async acquire() {
    return port({ hello: () => `hi ${cfg.who}` }, () => {});
  },
});

function demoTool(): DiscoveryTool {
  const capability = new McpEnvCapability("demo-caps", {
    configuration: { who: z.string() },
    resources: { greeter: (cfg) => greeter(cfg as { who: string }) },
    symbols: {
      greet: {
        fn(this: { resources: { greeter: { live: { hello: () => string } } } }) {
          return this.resources.greeter.live.hello();
        },
      },
    },
    annotations: { greet: { description: "greets the configured person" } },
  });
  return new DiscoveryTool("demo", capability, { description: "demo tool" });
}

/** An ActionTool sharing the same wiring — to prove both tiers register identically. Typed as
 *  `McpTool` (CS-erased): `ActionTool<CS>` is invariant in CS, so a concrete CS won't widen. */
function echoActionTool(): McpTool {
  return new ActionTool<{ docId: string }>("echo-edit", {
    description: "echo action tool",
    context: { docId: str("the doc id") },
    actions: (b) => [
      b.act({
        name: "append",
        needs: ["docId"],
        desc: "append text",
        props: { text: str() },
        handle: (ctx, _r, { text }) => ({ ok: true, doc: ctx.docId, text }),
      }),
    ],
  });
}

/** A real round-trip through the official SDK: Client ↔ Server over a linked in-memory transport. */
async function connectedClient(tools: McpTool[]): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, tools, () => ({ session: { id: "s1", state: {} } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tester", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("registerTools (official @modelcontextprotocol/sdk round-trip)", () => {
  it("registers BOTH a DiscoveryTool and an ActionTool on one McpServer", async () => {
    const client = await connectedClient([demoTool(), echoActionTool()]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["demo", "echo-edit"]);
    // the ActionTool dispatches a batch and its result object serializes over the wire
    const res = await client.callTool({
      name: "echo-edit",
      arguments: { intent: "echo", docId: "d1", actions: [["append", { text: "hi" }]] },
    });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi");
    await client.close();
  });

  it("lists a DiscoveryTool through tools/list, with the config-derived input schema", async () => {
    const client = await connectedClient([demoTool()]);
    const { tools } = await client.listTools();
    const demo = tools.find((t) => t.name === "demo");
    expect(demo).toBeDefined();
    // `who` came from the capability's configuration — surfaced as an input property over the wire.
    expect(Object.keys(demo!.inputSchema.properties ?? {}).sort()).toEqual(["expr", "intent", "who"]);
    await client.close();
  });

  it("calls a verb through tools/call — config from args, resource spawned, value back over the wire", async () => {
    const client = await connectedClient([demoTool()]);
    const res = await client.callTool({ name: "demo", arguments: { expr: "(greet)", who: "ada" } });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi ada");
    await client.close();
  });

  it("a runtime crash comes back as an (error …) form in the content (REPL-style, not a transport fault)", async () => {
    const client = await connectedClient([demoTool()]);
    const res = await client.callTool({ name: "demo", arguments: { expr: "(this-verb-does-not-exist)", who: "ada" } });
    // A statement crash is normal REPL output (a door), not a hard isError — earlier statements stand.
    expect((res.content as { type: string; text: string }[])[0]!.text).toMatch(/^\(error /);
    await client.close();
  });
});
