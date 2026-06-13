// capability-scoping.test.ts — P5: an env is assembled from a CHOSEN subset of atomic capability
// packs, not an inherit-the-monolith. A reduced root-set yields a narrower env: the capabilities you
// didn't assemble are simply not bound (the membrane is the pack list).

import { describe, expect, it } from "vitest";

import { execGeneratorFromString, lipsToJs, sandboxedEnv } from "@here.build/arrival-scheme";

import { assembleEnvSync, type EnvPack } from "../env-pack.js";
import { arrivalInferPack, arrivalUtilsPack, type ArrivalEnv } from "../project.js";
import { EvalTrace } from "../trace.js";

const stubInfer = (async () => [""]) as unknown as Parameters<typeof arrivalInferPack>[0]["infer"];

/** Assemble a base from exactly `packs`, run `source`, return the projected last value. */
async function runScoped(packs: EnvPack<ArrivalEnv>[], source: string): Promise<unknown> {
  const base = sandboxedEnv.inherit("scoped");
  const env = assembleEnvSync(base, packs).env;
  const results = await execGeneratorFromString(source, { env, tap: new EvalTrace() });
  let last: unknown = results.at(-1);
  if (last && typeof (last as { then?: unknown }).then === "function") last = await last;
  return lipsToJs(last, {});
}

describe("capability scoping — assemble from a reduced root-set", () => {
  it("a utils-only env binds json/parse", async () => {
    const value = await runScoped([arrivalUtilsPack()], `(json/parse "[1,2,3]")`);
    expect(lipsToJs(value, {})).toEqual([1, 2, 3]);
  });

  it("a utils-only env does NOT bind infer — the capability you didn't assemble is absent", async () => {
    await expect(runScoped([arrivalUtilsPack()], `(infer "m" "p")`)).rejects.toThrow(/infer/);
  });

  it("adding the infer pack binds infer (same base, wider capability set)", async () => {
    // infer is armed with a stub that yields [""]; the call resolves rather than being unbound.
    const value = await runScoped([arrivalUtilsPack(), arrivalInferPack({ infer: stubInfer })], `(infer "m" "p")`);
    expect(value).not.toBeUndefined();
  });
});
