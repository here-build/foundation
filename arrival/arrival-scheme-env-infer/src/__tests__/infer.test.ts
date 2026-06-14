// infer palette pack — arm with a fake InferFn, assemble, verify the verbs wire.
import { sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { type SchemeEnv } from "@here.build/arrival-scheme/scheme-env";
import { describe, expect, it, vi } from "vitest";

import { arrivalInferCapability } from "../index.js";

describe("@here.build/arrival-scheme-env-infer", () => {
  it("is config-armed by the InferFn and the capability identity reflects it", () => {
    const fakeInfer = vi.fn(async () => "completion");
    expect(arrivalInferCapability.name).toBe("arrival/infer");
    // the InferFn arms `this.configuration.infer`; lowering validates it against the zod schema.
    const pack = arrivalInferCapability.lower({ config: { infer: fakeInfer as never } });
    expect(pack.name).toBe("arrival/infer");
  });

  it("assembles onto an env and wires the infer / infer/chat rosettas", async () => {
    const env = sandboxedEnv.inherit("infer-test");
    const fakeInfer = async () => "completion";
    await assembleEnv(env as unknown as SchemeEnv, [
      arrivalInferCapability.lower({ config: { infer: fakeInfer as never } }),
    ]);

    expect(env.get("infer", { throwError: false })).toBeDefined();
    expect(env.get("infer/chat", { throwError: false })).toBeDefined();
  });
});
