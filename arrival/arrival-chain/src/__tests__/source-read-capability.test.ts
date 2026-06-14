// source-read-capability.test.ts — the arrivalSourceReadCapability lowers + WIRES its source verbs.
//
// The Project is opaque to wiring (verbs only forward it to the loader at CALL time), so a cast
// stub is enough to assert the rosettas are bound onto the assembled env.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import { arrivalSourceReadCapability } from "../packs/source-read.js";
import type { Project } from "../project.js";

describe("arrivalSourceReadCapability — source verbs wire onto the env", () => {
  it("binds require/string and require/ast", async () => {
    const base = sandboxedEnv.inherit("t");
    const pack = arrivalSourceReadCapability.lower({ config: { project: {} as never as Project } });
    const { env } = await assembleEnv(base, [pack]);

    for (const verb of ["require/string", "require/ast"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
