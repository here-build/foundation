import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { port, type Resource } from "@here.build/arrival-scheme/resources";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { registerDiscoveryTools } from "../sdk-adapter.js";

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

/** A real round-trip through the official SDK: Client ↔ Server over a linked in-memory transport. */
async function connectedClient(tools: DiscoveryTool[]): Promise<Client> {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerDiscoveryTools(server, tools, () => ({ session: { id: "s1", state: {} } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tester", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("registerDiscoveryTools (official @modelcontextprotocol/sdk round-trip)", () => {
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

  it("a runtime error comes back as an isError tool result, not a transport fault", async () => {
    const client = await connectedClient([demoTool()]);
    const res = await client.callTool({ name: "demo", arguments: { expr: "(this-verb-does-not-exist)", who: "ada" } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
