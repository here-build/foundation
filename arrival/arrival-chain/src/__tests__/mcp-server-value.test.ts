/**
 * C2-minimal — the `(mcp :name)` getter (server-as-value) + the `:tools` desugar.
 *
 *   - `(mcp …)` returns an opaque {@link McpServerValue} (string OR keyword name).
 *   - the handle round-trips through scheme UNTOUCHED (rosetta return → bound → passed to
 *     another rosetta's args), the property "server-as-value" rests on.
 *   - `resolveTools` lists each server's tools → the neutral model tool set + the
 *     toolName→serverName dispatch routing (first-server-wins on a collision).
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import {
  defineMcpRosettas,
  inertMcpResolver,
  isMcpServerValue,
  McpServerValue,
  resolveTools,
  type McpEffect,
  type McpEffectResolver,
} from "../mcp-effects.js";

const ctx = {};

/** Run scheme against an env with the mcp verbs wired; return the last (awaited) value. */
async function runScm(scm: string, resolve: McpEffectResolver = inertMcpResolver): Promise<unknown> {
  const env = sandboxedEnv.inherit("mcp-server-value-test");
  defineMcpRosettas(env, resolve);
  const r = await exec(scm, { env });
  const last = r.at(-1);
  return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
}

describe("(mcp :name) getter — server-as-value", () => {
  it("returns an opaque McpServerValue for a string name", async () => {
    const v = await runScm(`(mcp "linear")`);
    expect(v).toBeInstanceOf(McpServerValue);
    expect((v as McpServerValue).name).toBe("linear");
    expect(isMcpServerValue(v)).toBe(true);
  });

  it("accepts a keyword name (:linear → \"linear\")", async () => {
    const v = await runScm(`(mcp :linear)`);
    expect(v).toBeInstanceOf(McpServerValue);
    expect((v as McpServerValue).name).toBe("linear");
  });

  it("is a PURE constructor — never crosses the resolver (works under the inert default)", async () => {
    // inertMcpResolver throws on any crossing; the getter resolving fine proves it doesn't cross.
    await expect(runScm(`(mcp "anything")`)).resolves.toBeInstanceOf(McpServerValue);
  });

  it("round-trips opaque through scheme: getter return → bound → another rosetta's arg", async () => {
    const env = sandboxedEnv.inherit("mcp-roundtrip-test");
    defineMcpRosettas(env, inertMcpResolver);
    // A probe rosetta that reads the handle's name — proves the McpServerValue survived
    // the scheme round-trip (lipsToJs/jsToLips pass it through untouched).
    env.defineRosetta("server-name", { fn: (s: unknown) => (s instanceof McpServerValue ? s.name : "NOT-A-SERVER") });
    const out = await exec(`(server-name (let ((s (mcp :github))) s))`, { env });
    // server-name returns a JS string → wrapped as a SchemeString on the way out; unwrap.
    // "github" (not "NOT-A-SERVER") proves the McpServerValue survived the round-trip.
    expect(String(out.at(-1))).toBe("github");
  });
});

describe("resolveTools — :tools desugar", () => {
  // A resolver that returns a per-server tools/list (the only method this exercises).
  const rosterResolver =
    (lists: Record<string, unknown>): McpEffectResolver =>
    (_ctx, effect: McpEffect) => {
      expect(effect.method).toBe("tools/list");
      return Promise.resolve(lists[effect.server] ?? { tools: [] });
    };

  it("lists one server's tools → neutral descriptors + serverOf routing (annotations dropped)", async () => {
    const resolve = rosterResolver({
      linear: {
        tools: [
          {
            name: "create_issue",
            description: "file one",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true }, // MCP-only — must be dropped
          },
          { name: "search" },
        ],
      },
    });
    const { tools, serverOf } = await resolveTools([new McpServerValue("linear")], resolve, ctx);
    expect(tools).toEqual([
      { name: "create_issue", description: "file one", inputSchema: { type: "object" } },
      { name: "search" },
    ]);
    expect(serverOf.get("create_issue")?.name).toBe("linear"); // serverOf now carries the handle
    expect(serverOf.get("search")?.name).toBe("linear");
  });

  it("tolerates a bare-array tools/list reply (no { tools } envelope)", async () => {
    const resolve = rosterResolver({ gh: [{ name: "pr_create" }] });
    const { tools, serverOf } = await resolveTools([new McpServerValue("gh")], resolve, ctx);
    expect(tools).toEqual([{ name: "pr_create" }]);
    expect(serverOf.get("pr_create")?.name).toBe("gh");
  });

  it("unions across servers; FIRST server wins a name collision (deterministic routing)", async () => {
    const resolve = rosterResolver({
      a: { tools: [{ name: "search", description: "from-a" }, { name: "only_a" }] },
      b: { tools: [{ name: "search", description: "from-b" }, { name: "only_b" }] },
    });
    const { tools, serverOf } = await resolveTools([new McpServerValue("a"), new McpServerValue("b")], resolve, ctx);
    // one `search` (a's), plus only_a + only_b
    expect(tools.map((t) => t.name)).toEqual(["search", "only_a", "only_b"]);
    expect(tools.find((t) => t.name === "search")?.description).toBe("from-a"); // a won
    expect(serverOf.get("search")?.name).toBe("a"); // routed to the first server
    expect(serverOf.get("only_b")?.name).toBe("b");
  });
});
