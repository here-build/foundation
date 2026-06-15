import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { kernel } from "../index.js";
import { kernelActionToMcpTool, kernelDiscoveryToMcpTool } from "../kernel-bridge.js";
import { type McpTool, registerTools } from "../sdk-adapter.js";

interface Svc extends kernel.Services {
  greeting: string;
}

/** A tiny kernel discovery tool — one standalone fn reading an injected service. */
function bridgedDiscovery(): McpTool {
  const tool = kernel.defineDiscoveryTool<{}, Svc>({
    name: "kdiscover",
    description: "kernel discovery, bridged",
    context: {},
    fns: (b) => [b.fn({ name: "hello", desc: "say hello", impl: ({ greeting }) => greeting })],
  });
  return kernelDiscoveryToMcpTool(tool, () => ({ greeting: "hi from kernel" }));
}

/** A tiny kernel action tool — one inline action echoing a prop. */
function bridgedAction(): McpTool {
  const tool = kernel.defineActionTool<{}, Svc>({
    name: "kedit",
    description: "kernel action, bridged",
    context: {},
    actions: (a) => [
      a.act({ name: "echo", needs: [], props: { text: kernel.str("the text") }, desc: "echo text", handle: (_ctx, _r, p) => ({ echoed: p.text }) }),
    ],
  });
  return kernelActionToMcpTool(tool, () => ({ greeting: "x" }));
}

async function connectedClient(tools: McpTool[]): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, tools, () => ({ session: { id: "s1", state: {} } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tester", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("kernel-bridge: kernel.* tools register on the official McpServer via McpTool", () => {
  it("lists and calls a bridged kernel discovery tool (service injected per session)", async () => {
    const client = await connectedClient([bridgedDiscovery()]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["kdiscover"]);
    const res = await client.callTool({ name: "kdiscover", arguments: { expr: "(hello)" } });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi from kernel");
    await client.close();
  });

  it("lists and calls a bridged kernel action tool (tuple dispatch over the wire)", async () => {
    const client = await connectedClient([bridgedAction()]);
    const res = await client.callTool({ name: "kedit", arguments: { intent: "test", actions: [["echo", { text: "yo" }]] } });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("yo");
    await client.close();
  });
});
