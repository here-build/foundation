/**
 * The trusted threading macros (->, ->>, ~>, ~>>) reach the SANDBOX.
 *
 * arrival-chain runs scheme in sandboxedEnv, which deliberately doesn't install
 * user define-macros. The bootstrap defines the threading macros into user_env;
 * initBridge copies those Macro values into sandboxedEnv (bridge.ts) so showcase
 * code can pipe. They're pure code-rewrites — the expansion still evaluates
 * under the sandbox allowlist, so no capability is added. This test guards that
 * wiring (it regressed to `Unbound variable '->>'` before the fix).
 */
import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";

const router = () => singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "x" })) });
const run = (scm: string) => runPipeline({ files: { "main.scm": scm }, entry: "main.scm", router: router() });

describe("threading macros reach the sandbox", () => {
  it("->> threads the value as the LAST argument", async () => {
    expect(await run(`(->> (list 1 2 3) reverse car)`)).toBe(3); // car(reverse(xs))
    expect(await run(`(->> 10 (- 3))`)).toBe(-7); //                (- 3 10)
  });
  it("-> threads the value as the FIRST argument", async () => {
    expect(await run(`(-> 10 (- 3))`)).toBe(7); //                  (- 10 3)
  });
  it("~> / ~>> are Racket-style aliases", async () => {
    expect(await run(`(~> 10 (- 3))`)).toBe(7);
    expect(await run(`(~>> (list 1 2 3) cdr car)`)).toBe(2);
  });
});
