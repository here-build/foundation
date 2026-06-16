// utils-capability.test.ts — assemble arrivalUtilsCapability onto a sandboxed base and assert
// each verb binds.

import { sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { assembleEnv } from "@here.build/arrival/env";
import { arrivalUtilsCapability } from "../packs/utils.js";

describe("arrivalUtilsCapability", () => {
  it("binds every utils verb", async () => {
    const { env } = await assembleEnv(sandboxedEnv.inherit("t") as never, [arrivalUtilsCapability.lower({ config: {} })]);
    for (const verb of ["string-dedent", "template/handlebars"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
