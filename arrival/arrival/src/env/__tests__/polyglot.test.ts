// polyglot pack — assemble onto a real env, then RUN the threading macros.
import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv } from "../kernel.js";
import { type SchemeEnv } from "../scheme-env.js";
import { describe, expect, it } from "vitest";

import polyglot from "../polyglot.js";

describe("@here.build/arrival/polyglot", () => {
  it("installs the idiom macros and they thread correctly", async () => {
    const env = sandboxedEnv.inherit("polyglot-test");
    const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });
    await assembleEnv(env as unknown as SchemeEnv, [polyglot.lower({ evalScheme })]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // -> threads FIRST: (+ 5 1)=6 ; (* 6 2)=12
    expect(await num("(-> 5 (+ 1) (* 2))")).toBe(12);
    // ~> is an alias of ->
    expect(await num("(~> 5 (+ 10))")).toBe(15);
    // compose is right-to-left: (*2 (+1 5)) = 12
    expect(await num("((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe(12);
    // pipe is left-to-right: (*2 (+1 5)) = 12
    expect(await num("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglot.name).toBe("scheme/polyglot");
    expect(polyglot.spec.prelude).toContain("define-macro (->");
  });
});
