// reflect-capability.test.ts — assemble arrivalReflectCapability onto a sandboxed base and assert
// each provenance verb binds.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import { assembleEnv } from "@here.build/arrival-scheme/env";
import { arrivalReflectCapability } from "../packs/reflect.js";

describe("arrivalReflectCapability", () => {
  it("binds every provenance verb", async () => {
    const { env } = await assembleEnv(sandboxedEnv.inherit("t") as never, [arrivalReflectCapability.lower({ config: {} })]);
    for (const verb of ["why", "where", "how", "dag", "result-value"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
