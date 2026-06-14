// mcp-capability.test.ts — the `arrivalMcpCapability` lowers to a pack that binds the MCP
// dispatch verbs plus the `mcp/break` sentinel. Assembled INERT (no `mcp` config): the
// dispatch verbs are present (defined) but route to `inertMcpResolver`, so a call would
// throw the teaching error. `mcp/break` is a bound value (the halt sentinel), present
// regardless of arming. Presence, not arming, is what this asserts.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import { arrivalMcpCapability } from "../packs/mcp-capability.js";

describe("arrivalMcpCapability — inert assembly binds the mcp verbs", () => {
  it("binds mcp/call, mcp/list and the mcp/break sentinel", async () => {
    const base = sandboxedEnv.inherit("t");
    const { env } = await assembleEnv(base, [arrivalMcpCapability.lower({})]);

    for (const verb of ["mcp/call", "mcp/list", "mcp/break"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
