// superdefine-capability.test.ts — arrivalSuperDefineCapability lowers + WIRES the declaration family.
//
// The host sinks are all optional; with none supplied the verbs still bind (capability-optional,
// verb-always-present). Asserts the three declaration-family rosettas land on the assembled env.

import { sandboxedEnv } from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival/env";
import { describe, expect, it } from "vitest";

import { APPROVAL_FORM } from "../approval.js";
import { EXPOSE_FORM } from "../extract-expose.js";
import { OVERRIDABLE_FORM } from "../overridable.js";
import { arrivalSuperDefineCapability } from "../packs/superdefine.js";

describe("arrivalSuperDefineCapability — declaration-family verbs wire onto the env", () => {
  it("binds declare/expose + define/overridable + approval (no host sinks needed)", async () => {
    const base = sandboxedEnv.inherit("t");
    const pack = arrivalSuperDefineCapability.lower({ config: {} });
    const { env } = await assembleEnv(base, [pack]);

    for (const verb of [EXPOSE_FORM, OVERRIDABLE_FORM, APPROVAL_FORM]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
