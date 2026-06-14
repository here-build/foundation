// run-capability.test.ts — the arrivalRunCapability lowers + WIRES its run-channel verbs.
//
// The Project is opaque to wiring (verbs only forward it to runNamed/runNamedCall at CALL time),
// so a cast stub is enough to assert the rosettas are bound onto the assembled env.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import { arrivalRunCapability } from "../packs/run.js";
import type { Project } from "../project.js";

describe("arrivalRunCapability — run-channel verbs wire onto the env", () => {
  it("binds require/eval and require/call", async () => {
    const base = sandboxedEnv.inherit("t");
    const pack = arrivalRunCapability.lower({ config: { project: {} as never as Project } });
    const { env } = await assembleEnv(base, [pack]);

    for (const verb of ["require/eval", "require/call"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
