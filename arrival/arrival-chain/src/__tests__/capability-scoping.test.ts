// capability-scoping.test.ts — P5: an env is assembled from a CHOSEN subset of atomic capability
// packs, not an inherit-the-monolith. A reduced root-set yields a narrower env: the capabilities you
// didn't assemble are simply not bound (the membrane is the pack list).

import { EvalTrace } from "@here.build/arrival-provenance";
import { execGeneratorFromString, lipsToJs, sandboxedEnv } from "@here.build/arrival-scheme";
import { type EnvCapability } from "@here.build/arrival-scheme/capability";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { describe, expect, it } from "vitest";

import { type BuildArrivalEnvOpts } from "../infer-kernel.js";
import { arrivalInferCapability, arrivalUtilsCapability } from "../packs/index.js";

const stubInfer = (async () => [""]) as unknown as BuildArrivalEnvOpts["infer"];

/** Assemble a base from exactly `caps` (lowered with `config`), run `source`, return the projected
 *  last value. The membrane IS the capability list — what you don't assemble is unbound. */
async function runScoped(
  caps: readonly EnvCapability[],
  source: string,
  config: Partial<BuildArrivalEnvOpts> = {},
): Promise<unknown> {
  const base = sandboxedEnv.inherit("scoped");
  const { env } = await assembleEnv<typeof base>(
    base,
    caps.map((cap) => cap.lower({ config })),
  );
  const results = await execGeneratorFromString(source, { env, tap: new EvalTrace() });
  let last: unknown = results.at(-1);
  if (last && typeof (last as { then?: unknown }).then === "function") last = await last;
  return lipsToJs(last, {});
}

describe("capability scoping — assemble from a reduced root-set", () => {
  it("a utils-only env binds json/parse", async () => {
    const value = await runScoped([arrivalUtilsCapability], `(json/parse "[1,2,3]")`);
    expect(lipsToJs(value, {})).toEqual([1, 2, 3]);
  });

  it("a utils-only env does NOT bind infer — the capability you didn't assemble is absent", async () => {
    await expect(runScoped([arrivalUtilsCapability], `(infer "m" "p")`)).rejects.toThrow(/infer/);
  });

  it("adding the infer capability binds infer (same base, wider capability set)", async () => {
    // infer is armed with a stub that yields [""]; the call resolves rather than being unbound.
    const value = await runScoped([arrivalUtilsCapability, arrivalInferCapability], `(infer "m" "p")`, {
      infer: stubInfer,
    });
    expect(value).not.toBeUndefined();
  });
});
