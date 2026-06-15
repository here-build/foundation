/**
 * The `c[ad]+r` pair-accessor family as an UNBOUNDED catchall.
 *
 * Before, the family was a hand-maintained list: a bounded bootstrap loop in
 * `global_env` (2–5 inner letters) and an even narrower, incomplete allowlist
 * copied into `sandboxedEnv` (SAFE_BUILTINS — missing the `cd*` 4-letter words
 * and everything 5+). A chain the sweet lens fused to a deep accessor — `caddddr`,
 * `cadddddr`, `caddadar` — fell through to an "unbound symbol" error.
 *
 * The fix: `cxrAccessor` is the single synthesis (car/cdr composition), and an
 * always-on resolver installs it on BOTH roots. The sandbox has a null parent and
 * does not inherit `global_env`'s resolvers, so it is registered on each directly.
 */
import { describe, expect, it } from "vitest";

import { cxrAccessor, exec, global_env } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { schemeToJs } from "../rosetta";

const evalIn = (env: typeof global_env) => async (expr: string): Promise<unknown> =>
  schemeToJs((await exec(expr, { env }))[0], {});

// element index k ≡ (car (cdr^k x)) ≡ "ca" + "d"×k + "r"
const cxrForIndex = (k: number): string => `ca${"d".repeat(k)}r`;

describe("cxrAccessor — pure synthesis", () => {
  it("returns undefined for non-accessor heads (yields to parent / errors)", () => {
    for (const w of ["list", "first", "cr", "c", "cxr", "ccar", "cara", "cadr-ish"]) {
      expect(cxrAccessor(w), w).toBeUndefined();
    }
  });

  it("accepts the whole family, including words past r7rs and the SAFE_BUILTINS slice", () => {
    for (const w of ["car", "cdr", "cadr", "caddr", "caar", "cdar", "cddddr", "caddddr", "cadddddr", "caddadar"]) {
      expect(typeof cxrAccessor(w), w).toBe("function");
    }
  });
});

// Run the SAME expressions through both roots. global_env carries the eager loop
// + resolver; sandboxedEnv carries only the (incomplete) allowlist + resolver.
for (const [label, env] of [["global_env", global_env], ["sandboxedEnv", sandboxedEnv]] as const) {
  describe(`c[ad]+r evaluation in ${label}`, () => {
    const run = evalIn(env);

    it("standard words still resolve (regression)", async () => {
      expect(await run("(car (list 10 20 30 40 50 60))")).toBe(10);
      expect(await run("(cadr (list 10 20 30 40 50 60))")).toBe(20);
      expect(await run("(caddr (list 10 20 30 40 50 60))")).toBe(30);
      expect(await run("(cadddr (list 10 20 30 40 50 60))")).toBe(40);
    });

    it("deep linear accessors resolve to the right element", async () => {
      // k=4: 5 inner letters — present in global's eager loop but ABSENT from
      // SAFE_BUILTINS, so the sandbox could not evaluate it before the resolver.
      expect(await run(`(${cxrForIndex(4)} (list 10 20 30 40 50 60))`)).toBe(50);
      // k=5: 6 inner letters — past BOTH the eager loop and the allowlist.
      expect(await run(`(${cxrForIndex(5)} (list 10 20 30 40 50 60))`)).toBe(60);
    });

    it("mixed combos compose car/cdr correctly", async () => {
      // cdar = drop-1 of the first element
      expect(await run("(cdar (list (list 1 2 3) 9))")).toEqual([2, 3]);
      // caadr = first of the second element
      expect(await run("(caadr (list 10 (list 100 200) 30))")).toBe(100);
      // caddar = third of the first element: car→(1 2 3 4), cdr, cdr, car→3
      expect(await run("(caddar (list (list 1 2 3 4) 9))")).toBe(3);
    });

    it("an accessor that walks off the end is a pair typecheck error, not unbound", async () => {
      await expect(run("(cadr (list 1))")).rejects.toThrow();
    });
  });
}
