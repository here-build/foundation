/**
 * mcp-effects — the MCP membrane (inert-by-default) + the server-tape replay model.
 *
 * The properties under test are the warrant behind MCP replay/what-if:
 *   - inert-by-default: invoking MCP unwired throws a teaching error (never a silent
 *     no-op, never a network call)
 *   - HERMETIC replay: a recorded call replays without EVER touching the honest
 *     resolver (so a what-if cannot re-fire a destructive tool)
 *   - read-after-write FIDELITY: positional per-(inference, server) keying keeps two
 *     same-`{tool,args}` calls with different values distinct — content-keying would
 *     collapse them (last-write-wins) and corrupt the earlier read
 *   - per-server tapes are independent
 *   - DIVERGENCE is caught: a replay whose nth call differs from the record stops
 *     (crash or host-supplied answer), never silently serves a stale value
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { effectLogCollector, mcpEffectKey } from "../effect-log.js";
import {
  defineMcpRosettas,
  inertMcpResolver,
  wrapMcpResolver,
  type McpEffect,
  type McpEffectResolver,
} from "../mcp-effects.js";
import { Project } from "../project.js";

const ctx = {};
const call = (server: string, method: McpEffect["method"], request: unknown): McpEffect => ({
  kind: "mcp",
  server,
  method,
  request,
});

describe("mcp-effects — inert default", () => {
  it("throws a teaching error pointing at buildArrivalEnv({ mcp })", () => {
    // inertMcpResolver throws SYNCHRONOUSLY (matching inertDataResolver) — an async
    // caller's `await inner(...)` still surfaces it as a rejection.
    expect(() => inertMcpResolver(ctx, call("linear", "tools/call", { tool: "x", args: {} }))).toThrow(
      /MCP is not enabled.*buildArrivalEnv\(\{ mcp \}\)/,
    );
  });
});

describe("mcp-effects — server-tape record/replay", () => {
  it("replays hermetically: the honest resolver is NEVER called on replay", async () => {
    const live: McpEffectResolver = async (_c, e) => ({ ok: e.method });
    const rec = effectLogCollector();
    const recording = wrapMcpResolver(live, { inferenceId: "I", onEffectResult: rec.record });
    expect(await recording(ctx, call("linear", "tools/call", { tool: "create_issue", args: { t: "A" } }))).toEqual({
      ok: "tools/call",
    });

    const forbidden = vi.fn<McpEffectResolver>(async () => {
      throw new Error("LIVE CALL DURING REPLAY");
    });
    const replaying = wrapMcpResolver(forbidden, { inferenceId: "I", effectLog: rec.log });
    expect(await replaying(ctx, call("linear", "tools/call", { tool: "create_issue", args: { t: "A" } }))).toEqual({
      ok: "tools/call",
    });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("read-after-write fidelity: same {tool,args} with different values replays in order (NOT collapsed)", async () => {
    // server state: read → A, write, read → B; the two reads have IDENTICAL content.
    const replies = ["A", "WROTE", "B"];
    let i = 0;
    const live: McpEffectResolver = async () => replies[i++];
    const rec = effectLogCollector();
    const w = wrapMcpResolver(live, { inferenceId: "I", onEffectResult: rec.record });
    expect(await w(ctx, call("db", "tools/call", { tool: "read", args: {} }))).toBe("A");
    await w(ctx, call("db", "tools/call", { tool: "write", args: {} }));
    expect(await w(ctx, call("db", "tools/call", { tool: "read", args: {} }))).toBe("B");

    // three DISTINCT positional keys on the same server (n = 0,1,2) — not one collapsed entry
    expect(rec.log.size).toBe(3);
    expect(rec.log.has(mcpEffectKey("I", "db", 0))).toBe(true);
    expect(rec.log.has(mcpEffectKey("I", "db", 2))).toBe(true);

    // replay reproduces pre- and post-write reads correctly (content-keying would give B,B)
    const forbidden: McpEffectResolver = async () => {
      throw new Error("LIVE");
    };
    const r = wrapMcpResolver(forbidden, { inferenceId: "I", effectLog: rec.log });
    expect(await r(ctx, call("db", "tools/call", { tool: "read", args: {} }))).toBe("A");
    await r(ctx, call("db", "tools/call", { tool: "write", args: {} }));
    expect(await r(ctx, call("db", "tools/call", { tool: "read", args: {} }))).toBe("B");
  });

  it("tapes are per-server independent (each starts at n=0)", async () => {
    const live: McpEffectResolver = async (_c, e) => e.server;
    const rec = effectLogCollector();
    const w = wrapMcpResolver(live, { inferenceId: "I", onEffectResult: rec.record });
    await w(ctx, call("a", "tools/list", {}));
    await w(ctx, call("b", "tools/list", {}));
    expect(rec.log.has(mcpEffectKey("I", "a", 0))).toBe(true);
    expect(rec.log.has(mcpEffectKey("I", "b", 0))).toBe(true);
  });

  it("catches divergence: a replay whose nth call differs from the record stops (no silent stale serve)", async () => {
    const live: McpEffectResolver = async () => "recorded";
    const rec = effectLogCollector();
    const w = wrapMcpResolver(live, { inferenceId: "I", onEffectResult: rec.record });
    await w(ctx, call("db", "tools/call", { tool: "read", args: { id: 1 } }));

    const forbidden: McpEffectResolver = async () => "live";
    const r = wrapMcpResolver(forbidden, { inferenceId: "I", effectLog: rec.log });
    await expect(r(ctx, call("db", "tools/call", { tool: "read", args: { id: 2 } }))).rejects.toThrow(
      /replay divergence/,
    );
  });

  it("onDivergence supplies a substitute reply instead of throwing", async () => {
    const live: McpEffectResolver = async () => "recorded";
    const rec = effectLogCollector();
    const w = wrapMcpResolver(live, { inferenceId: "I", onEffectResult: rec.record });
    await w(ctx, call("db", "tools/call", { tool: "read", args: { id: 1 } }));

    const forbidden: McpEffectResolver = async () => "live";
    const r = wrapMcpResolver(forbidden, {
      inferenceId: "I",
      effectLog: rec.log,
      onDivergence: () => "substitute",
    });
    expect(await r(ctx, call("db", "tools/call", { tool: "read", args: { id: 999 } }))).toBe("substitute");
  });
});

// ── the scheme-facing dispatch verbs, in isolation (like data-effects.test.ts) ──

function mcpEnv(resolve: McpEffectResolver): ReturnType<typeof sandboxedEnv.inherit> {
  const env = sandboxedEnv.inherit("mcp-verb-test");
  env.defineRosetta("dict", {
    fn: (...args: unknown[]) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) out[String(args[i])] = args[i + 1];
      return out;
    },
  });
  defineMcpRosettas(env, resolve);
  return env;
}
const runScm = async (env: ReturnType<typeof sandboxedEnv.inherit>, scm: string): Promise<unknown> => {
  const results = await exec(scm, { env });
  const last = results.at(-1);
  return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
};

describe("mcp-effects — dispatch verbs cross the membrane", () => {
  it("(mcp/call …) builds the canonical McpEffect (no-args ⇒ {})", async () => {
    let captured: McpEffect | undefined;
    const env = mcpEnv(async (_c, e) => {
      captured = e;
      return { ok: true };
    });
    // keyword-dict args go through the REAL `dict` (keyword-accessor aware), exercised by
    // the Project.run e2e below (which also proves the reply crosses back via lipsToJs);
    // here we pin the verb's shape mapping with the no-args path (undefined ⇒ {}).
    await runScm(env, `(mcp/call "linear" "ping")`);
    expect(captured).toEqual({
      kind: "mcp",
      server: "linear",
      method: "tools/call",
      request: { tool: "ping", args: {} },
    });
  });

  it("(mcp/list …) → tools/list", async () => {
    let captured: McpEffect | undefined;
    const env = mcpEnv(async (_c, e) => {
      captured = e;
      return [];
    });
    await runScm(env, `(mcp/list "linear")`);
    expect(captured).toMatchObject({ server: "linear", method: "tools/list" });
  });

  it("inert by default — the verb throws the teaching error", async () => {
    await expect(runScm(mcpEnv(inertMcpResolver), `(mcp/call "linear" "x" (dict))`)).rejects.toThrow(
      /MCP is not enabled/,
    );
  });
});

// ── full Project.run: opts.mcp threaded → record → hermetic replay ──────────────

const freshProject = () => ArrivalChain.bootstrap(new Project()).root;

describe("mcp-effects — Project.run record + hermetic replay (end to end)", () => {
  const program = `(mcp/call "db" "read" (dict :id 1))`;

  it("threads opts.mcp, records the call into the effect-log, then replays it hermetically", async () => {
    const live = vi.fn<McpEffectResolver>(async () => ({ id: 1, name: "row" }));
    const collector = effectLogCollector();
    const value = await freshProject().run(program, { mcp: live, onEffectResult: collector.record });
    expect(value).toEqual({ id: 1, name: "row" });
    expect(live).toHaveBeenCalledTimes(1);
    // recorded under the run-scoped positional key (inferenceId "", server "db", n 0)
    expect(collector.log.has(mcpEffectKey("", "db", 0))).toBe(true);

    // replay: a resolver that throws if reached — the full log short-circuits it (ZERO hits)
    const forbidden = vi.fn<McpEffectResolver>(async () => {
      throw new Error("replay must not reach the MCP resolver");
    });
    const replayValue = await freshProject().run(program, { mcp: forbidden, effectLog: collector.log });
    expect(replayValue).toEqual({ id: 1, name: "row" });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("disarmed by default — a program calling MCP with no resolver throws the teaching error", async () => {
    await expect(freshProject().run(program, {})).rejects.toThrow(/MCP is not enabled/);
  });
});
