/**
 * C3 — the middleware chain: `mcp/derive` (install-middleware) + the chain runner +
 * `mcp/break`. The interception primitive behind flows 2-4 (rewrite tool descriptions /
 * re-encode responses / force-halt). The membrane crossing (scheme λ ↔ JS next ↔ break
 * sentinel) is exercised through real scheme middlewares.
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import {
  defineMcpRosettas,
  dispatchThroughChain,
  MCP_BREAK,
  McpServerValue,
  runMiddlewareChain,
  type McpEffect,
  type McpEffectResolver,
  type McpMiddleware,
} from "../mcp-effects.js";

const ctx = {};
const tc = (method: McpMiddleware["method"], handler: McpMiddleware["handler"]): McpMiddleware => ({ method, handler });

describe("runMiddlewareChain — composition + break (JS middlewares)", () => {
  const honest = async (req: unknown): Promise<unknown> => ({ reply: req });

  it("no middleware → honest", async () => {
    expect(await runMiddlewareChain([], "tools/call", honest, { x: 1 }, {})).toEqual({ reply: { x: 1 } });
  });

  it("pass-through middleware → honest reply", async () => {
    const mw = tc("tools/call", (req, next) => next(req));
    expect(await runMiddlewareChain([mw], "tools/call", honest, { x: 1 }, {})).toEqual({ reply: { x: 1 } });
  });

  it("short-circuit middleware (never calls next) → its own value", async () => {
    const mw = tc("tools/call", () => ({ canned: true }));
    expect(await runMiddlewareChain([mw], "tools/call", honest, {}, {})).toEqual({ canned: true });
  });

  it("a middleware returning MCP_BREAK → the chain returns MCP_BREAK", async () => {
    const mw = tc("tools/call", () => MCP_BREAK);
    expect(await runMiddlewareChain([mw], "tools/call", honest, {}, {})).toBe(MCP_BREAK);
  });

  it("only method-matching middlewares participate", async () => {
    const listMw = tc("tools/list", () => ({ wrong: true }));
    expect(await runMiddlewareChain([listMw], "tools/call", honest, { x: 1 }, {})).toEqual({ reply: { x: 1 } });
  });

  it("composes outermost-first (mw1 wraps mw2 wraps honest)", async () => {
    const order: string[] = [];
    const wrap = (tag: string): McpMiddleware =>
      tc("tools/call", async (req, next) => {
        order.push(`${tag}-in`);
        const r = await next(req);
        order.push(`${tag}-out`);
        return r;
      });
    await runMiddlewareChain([wrap("mw1"), wrap("mw2")], "tools/call", honest, {}, {});
    expect(order).toEqual(["mw1-in", "mw2-in", "mw2-out", "mw1-out"]);
  });

  it("a middleware can transform the reply (flow 3: re-encode the response)", async () => {
    const mw = tc("tools/call", async (req, next) => {
      const r = (await next(req)) as { reply: unknown };
      return { wrapped: r.reply };
    });
    expect(await runMiddlewareChain([mw], "tools/call", honest, { q: 1 }, {})).toEqual({ wrapped: { q: 1 } });
  });
});

describe("mcp/derive + dispatchThroughChain (scheme middleware)", () => {
  /** Build an env with the mcp verbs over a resolver that echoes the request. */
  function harness(): { env: ReturnType<typeof sandboxedEnv.inherit>; seen: McpEffect[]; resolve: McpEffectResolver } {
    const seen: McpEffect[] = [];
    const resolve: McpEffectResolver = async (_c, e) => {
      seen.push(e);
      return { from: "honest", request: e.request };
    };
    const env = sandboxedEnv.inherit("mcp-mw-test");
    defineMcpRosettas(env, resolve);
    return { env, seen, resolve };
  }
  const derive = async (env: ReturnType<typeof sandboxedEnv.inherit>, scm: string): Promise<McpServerValue> => {
    const r = await exec(scm, { env });
    return r.at(-1) as McpServerValue;
  };

  it("derive appends middleware IMMUTABLY (base untouched) + carries the method", async () => {
    const { env } = harness();
    const derived = await derive(env, `(mcp/derive (mcp "s") :tools/call (lambda (req next progress) (next req)))`);
    expect(derived).toBeInstanceOf(McpServerValue);
    expect(derived.name).toBe("s");
    expect(derived.middleware).toHaveLength(1);
    expect(derived.middleware[0]!.method).toBe("tools/call");
    // a second derive on the SAME base yields an independent 1-middleware value
    const base = await derive(env, `(mcp "s")`);
    const d2 = base.withMiddleware({ method: "tools/list", handler: () => null });
    expect(base.middleware).toHaveLength(0); // base unchanged
    expect(d2.middleware).toHaveLength(1);
  });

  it("a pass-through scheme middleware reaches the honest resolver", async () => {
    const { env, seen, resolve } = harness();
    const derived = await derive(env, `(mcp/derive (mcp "s") :tools/call (lambda (req next progress) (next req)))`);
    const reply = await dispatchThroughChain(derived, "tools/call", { tool: "ping", args: { a: 1 } }, resolve, ctx);
    expect(reply).toEqual({ from: "honest", request: { tool: "ping", args: { a: 1 } } });
    expect(seen).toHaveLength(1); // honest fired (pass-through)
  });

  it("a short-circuit scheme middleware never reaches honest", async () => {
    const { env, seen, resolve } = harness();
    const derived = await derive(env, `(mcp/derive (mcp "s") :tools/call (lambda (req next progress) "mocked-reply"))`);
    const reply = await dispatchThroughChain(derived, "tools/call", { tool: "ping", args: {} }, resolve, ctx);
    expect(reply).toBe("mocked-reply");
    expect(seen).toHaveLength(0); // honest never fired
  });

  it("a break scheme middleware returns MCP_BREAK and never reaches honest (flow 4)", async () => {
    const { env, seen, resolve } = harness();
    // mcp/break is bound only in buildArrivalEnv; expose it here so the λ can reference it.
    env.set("mcp/break", MCP_BREAK);
    const derived = await derive(env, `(mcp/derive (mcp "s") :tools/call (lambda (req next progress) mcp/break))`);
    const reply = await dispatchThroughChain(derived, "tools/call", { tool: "danger", args: {} }, resolve, ctx);
    expect(reply).toBe(MCP_BREAK);
    expect(seen).toHaveLength(0); // suppressed — the destructive call never fired
  });
});

describe("mcp/define — total server fabrication", () => {
  const neverResolve: McpEffectResolver = async () => {
    throw new Error("a defined server must NOT reach the resolver");
  };

  it("fabricates a server whose method IS the handler (no resolver crossing)", async () => {
    const env = sandboxedEnv.inherit("mcp-define-test");
    defineMcpRosettas(env, neverResolve);
    const r = await exec(`(mcp/define "fab" :tools/call (lambda (req) "fabricated-reply"))`, { env });
    const server = r.at(-1) as McpServerValue;
    expect(server).toBeInstanceOf(McpServerValue);
    expect(server.name).toBe("fab");
    expect(typeof server.defined?.["tools/call"]).toBe("function");
    const reply = await dispatchThroughChain(server, "tools/call", { tool: "x", args: {} }, neverResolve, ctx);
    expect(reply).toBe("fabricated-reply"); // the fabricated impl answered; resolver never thrown
  });

  it("derive layers middleware over a defined server's honest (scheme transform of the reply)", async () => {
    const env = sandboxedEnv.inherit("mcp-define-derive-test");
    defineMcpRosettas(env, neverResolve);
    // defined tools/call → "base"; a derive middleware awaits next + transforms the reply.
    const r = await exec(
      `(mcp/derive
         (mcp/define "fab" :tools/call (lambda (req) "base"))
         :tools/call
         (lambda (req next progress) (string-append "wrapped:" (next req))))`,
      { env },
    );
    const server = r.at(-1) as McpServerValue;
    const reply = await dispatchThroughChain(server, "tools/call", {}, neverResolve, ctx);
    expect(reply).toBe("wrapped:base"); // proves a scheme middleware can consume next's reply
  });
});
