/**
 * `project/<seg>[/<seg>…]` as a bare-symbol form for env access.
 *
 * `project/get` (the rosetta) is still bound as a direct symbol, but for
 * static env keys the resolver makes the noun-form readable: the
 * expression IS the value, no quoted-string indirection.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";

const fresh = (): Project => ArrivalChain.bootstrap(new Project()).root;

describe("env-as-symbol resolver", () => {
  it("project/<key> resolves a single-segment env entry", async () => {
    const p = fresh();
    p.setEnv("replays", 10);
    expect(await p.run(`project/replays`)).toBe(10);
  });

  it("project/<a>/<b> resolves a nested env path", async () => {
    const p = fresh();
    p.setEnv("audience", "count", 5);
    expect(await p.run(`project/audience/count`)).toBe(5);
  });

  it("hyphens in keys pass through unchanged", async () => {
    const p = fresh();
    p.setEnv("system-prompt", "be terse");
    expect(await p.run(`project/system-prompt`)).toBe("be terse");
  });

  it("missing key surfaces as 'Unbound variable'", async () => {
    const p = fresh();
    await expect(p.run(`project/absent`)).rejects.toThrow(/Unbound variable/);
  });

  it("project/get (rosetta) still works alongside the resolver", async () => {
    const p = fresh();
    p.setEnv("name", "Lens");
    expect(await p.run(`(project/get "name")`)).toBe("Lens");
    expect(await p.run(`project/name`)).toBe("Lens");
  });

  it("threads into string-append the same as project/get", async () => {
    const p = fresh();
    p.setEnv("name", "Lens");
    const r = await p.run(`(string-append "hello " project/name)`);
    expect(r).toBe("hello Lens");
  });
});
