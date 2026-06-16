// Unified SRFI palette — assemble each capability onto a real env and run one verb.
import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv } from "../kernel.js";
import { type SchemeEnv } from "../scheme-env.js";
import { describe, expect, it } from "vitest";

import { allSrfi, srfi1, srfi26, srfi43, srfi128, srfi189, srfi2, srfi8 } from "../srfi/index.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

/** Assemble one capability onto a fresh env; return a `(num src)` runner. */
async function withCap(cap: { lower: (o: { evalScheme: typeof evalScheme }) => unknown }, name: string) {
  const env = sandboxedEnv.inherit(name);
  await assembleEnv(env as unknown as SchemeEnv, [cap.lower({ evalScheme }) as never]);
  return async (src: string) => Number((await exec(src, { env }))[0]);
}

describe("@here.build/arrival/srfi", () => {
  it("SRFI-1 list library", async () => {
    const num = await withCap(srfi1, "s1");
    expect(await num("(length+ (list 1 2 3 4))")).toBe(4);
  });
  it("SRFI-43 vectors", async () => {
    const num = await withCap(srfi43, "s43");
    expect(await num("(vector-count odd? (vector 1 2 3 4 5))")).toBe(3);
  });
  it("SRFI-189 Maybe/Either", async () => {
    const num = await withCap(srfi189, "s189");
    expect(await num("(maybe-ref (just 7))")).toBe(7);
  });
  it("SRFI-128 comparators", async () => {
    const num = await withCap(srfi128, "s128");
    expect(await num("(if (=? (make-default-comparator) 1 1) 1 0)")).toBe(1);
  });
  it("SRFI-26 cut/cute", async () => {
    const num = await withCap(srfi26, "s26");
    expect(await num("((cut + 1 <>) 5)")).toBe(6);
  });
  it("SRFI-8 receive (define-syntax — may not survive the sandbox)", async () => {
    const num = await withCap(srfi8, "s8");
    expect(await num("(receive (a b) (values 1 2) (+ a b))")).toBe(3);
  });
  it("SRFI-2 and-let* (define-syntax — may not survive the sandbox)", async () => {
    const num = await withCap(srfi2, "s2");
    expect(await num("(and-let* ((x 5)) (+ x 1))")).toBe(6);
  });

  it("allSrfi exposes the whole set", () => {
    expect(allSrfi).toHaveLength(7);
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-1");
  });
});
