// ramda palette pack — assemble the capability; verbs run through the membrane.
import { exec, sandboxedEnv } from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival/env";
import { type SchemeEnv } from "@here.build/arrival/scheme-env";
import { describe, expect, it } from "vitest";

import ramda, { ramdaVerbs } from "../index.js";

describe("@here.build/arrival-scheme-env-ramda", () => {
  it("wires the Ramda verbs and they run through the membrane", async () => {
    const env = sandboxedEnv.inherit("ramda-test");
    await assembleEnv(env as unknown as SchemeEnv, [ramda.lower({})]);

    // results are membrane-wrapped scheme values (the right thing) — so stay in
    // scheme-land: read fields back through `prop` rather than comparing JS objects.
    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    expect(await num('(prop "a" (dict :a 5 :b 6))')).toBe(5);
    // pick narrows a dict; read a surviving field back, and confirm a dropped one is absent
    expect(await num('(prop "a" (pick (list "a") (dict :a 1 :b 2)))')).toBe(1);
    expect(await num('(length (keys (pick (list "a") (dict :a 1 :b 2))))')).toBe(1);
  });

  it("is a module-singleton capability exposing the verb set", () => {
    expect(ramda.name).toBe("scheme/ramda");
    expect(ramdaVerbs).toContain("prop");
    expect(ramdaVerbs.length).toBeGreaterThan(30);
  });
});
