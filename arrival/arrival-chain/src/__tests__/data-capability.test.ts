// data-capability.test.ts — the `arrivalDataCapability` lowers to a pack that binds the
// data-effect verbs. Assembled INERT (no `data` config): the verbs are present (defined)
// but route to `inertDataResolver`, so a call would throw the teaching error. Presence,
// not arming, is what this asserts — the capability surface is identical whether a
// host wired a resolver.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import { arrivalDataCapability } from "../packs/data.js";

describe("arrivalDataCapability — inert assembly binds the data verbs", () => {
  it("binds http/get, http/post and sql/query", async () => {
    const base = sandboxedEnv.inherit("t");
    const { env } = await assembleEnv(base, [arrivalDataCapability.lower({})]);

    for (const verb of ["http/get", "http/post", "sql/query"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
