// agentic-capability.test.ts — arrivalAgenticCapability lowers + WIRES infer/agentic/end-to-end.
//
// DEP-BEARING: it deps on arrivalInferCapability, so assembleEnv linearizes infer before it. The
// infer fn is forwarded at CALL time only, so a stub is enough to assert the rosetta binds.

import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import type { InferFn } from "../infer-kernel.js";
import { arrivalAgenticCapability } from "../packs/agentic.js";

const stubInfer = (async () => [""]) as unknown as InferFn;

describe("arrivalAgenticCapability — agentic verb wires onto the env (deps: infer)", () => {
  it("binds infer/agentic/end-to-end (and pulls in its infer dep)", async () => {
    const base = sandboxedEnv.inherit("t");
    const pack = arrivalAgenticCapability.lower({ config: { infer: stubInfer } });
    const { env } = await assembleEnv(base, [pack]);

    // The agentic verb itself.
    expect(env.get("infer/agentic/end-to-end", { throwError: false })).toBeDefined();
    // Its declared dep (infer) is linearized in too — `infer` is bound on the same env.
    expect(env.get("infer", { throwError: false })).toBeDefined();
  });
});
