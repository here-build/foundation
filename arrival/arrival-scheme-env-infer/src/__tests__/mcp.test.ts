// mcp pack — the dependent capability: mcp dispatch verbs + the agentic loop, deps on infer.
import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { type SchemeEnv } from "@here.build/arrival-scheme/scheme-env";
import { describe, expect, it } from "vitest";

import { type InferFn } from "../infer.js";
import { arrivalAgenticCapability, arrivalMcpCapability } from "../mcp.js";

const stubInfer = (async () => [""]) as unknown as InferFn;

describe("@here.build/arrival-scheme-env-infer/mcp", () => {
  it("arrivalMcpCapability wires the dispatch verbs + the mcp/break sentinel (inert by default)", async () => {
    const env = sandboxedEnv.inherit("mcp-test");
    await assembleEnv(env as unknown as SchemeEnv, [arrivalMcpCapability.lower({})]);

    for (const verb of ["mcp", "llm", "derive", "llm/with", "mcp/define", "mcp/call", "mcp/list", "mcp/break"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });

  it("arrivalAgenticCapability binds infer/agentic/end-to-end and pulls in its infer + mcp deps", async () => {
    const env = sandboxedEnv.inherit("agentic-test");
    await assembleEnv(env as unknown as SchemeEnv, [arrivalAgenticCapability.lower({ config: { infer: stubInfer } })]);

    expect(env.get("infer/agentic/end-to-end", { throwError: false })).toBeDefined();
    // declared deps linearize in: the infer verb (arrival/infer) and the mcp verbs (arrival/mcp).
    expect(env.get("infer", { throwError: false })).toBeDefined();
    expect(env.get("mcp/call", { throwError: false })).toBeDefined();
  });
});
