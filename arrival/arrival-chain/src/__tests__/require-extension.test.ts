// require-extension.test.ts — P4: `(require/extension :name)` over a host-armed pack registry.
// Drives a real buildArrivalEnv with an extensionRegistry and execs scheme against it.

import { describe, expect, it } from "vitest";

import { execGeneratorFromString, lipsToJs } from "@here.build/arrival-scheme";

import { EvalTrace } from "@here.build/arrival-provenance";
import { buildArrivalEnv } from "../project.js";
import { loaderFromResolver } from "../loader.js";
import type { EnvPack } from "@here.build/arrival-scheme/env";

type EnvHandle = Awaited<ReturnType<typeof buildArrivalEnv>>;

const stubInfer = (async () => [""]) as unknown as Parameters<typeof buildArrivalEnv>[0]["infer"];
const stubLoader = loaderFromResolver(() => {
  throw new Error("no requires in this test");
});

/** Build an env armed with `registry`, run `source`, return the JS-projected last value. */
async function runWith(registry: Map<string, EnvPack<EnvHandle>>, source: string): Promise<unknown> {
  const env = await buildArrivalEnv({
    name: "t",
    infer: stubInfer,
    loader: stubLoader,
    extensionRegistry: registry,
  });
  const results = await execGeneratorFromString(source, { env, tap: new EvalTrace() });
  let last: unknown = results.at(-1);
  if (last && typeof (last as { then?: unknown }).then === "function") last = await last;
  return lipsToJs(last, {});
}

describe("(require/extension :name)", () => {
  it("applies the named pack — its symbol is unbound before, callable after", async () => {
    const registry = new Map<string, EnvPack<EnvHandle>>([
      ["greeter", { name: "ext/greeter", apply: (env) => env.defineRosetta("greet", { fn: () => "hi" }) }],
    ]);
    const value = await runWith(registry, `(require/extension :greeter) (greet)`);
    expect(value).toBe("hi");
  });

  it("accepts a bare string too (`:name` is the intended surface, string is tolerated)", async () => {
    const registry = new Map<string, EnvPack<EnvHandle>>([
      ["greeter", { name: "ext/greeter", apply: (env) => env.defineRosetta("greet", { fn: () => "hi" }) }],
    ]);
    const value = await runWith(registry, `(require/extension "greeter") (greet)`);
    expect(value).toBe("hi");
  });

  it("is idempotent — requiring twice applies the pack ONCE", async () => {
    let applies = 0;
    const registry = new Map<string, EnvPack<EnvHandle>>([
      [
        "counter",
        {
          name: "ext/counter",
          apply: (env) => {
            applies += 1;
            env.defineRosetta("noop", { fn: () => applies });
          },
        },
      ],
    ]);
    const value = await runWith(registry, `(require/extension :counter) (require/extension :counter) (noop)`);
    expect(applies).toBe(1);
    expect(value).toBe(1);
  });

  it("an unknown name errors, listing the armed `:names`", async () => {
    const registry = new Map<string, EnvPack<EnvHandle>>([
      ["sql", { name: "ext/sql", apply: () => {} }],
      ["http", { name: "ext/http", apply: () => {} }],
    ]);
    await expect(runWith(registry, `(require/extension :nope)`)).rejects.toThrow(/no extension :nope.*:sql.*:http/s);
  });

  it("applies a pack's deps first (the dep's symbol is live when the dependent applies)", async () => {
    const order: string[] = [];
    const base: EnvPack<EnvHandle> = {
      name: "ext/base",
      apply: (env) => {
        order.push("base");
        env.defineRosetta("base-fn", { fn: () => "base" });
      },
    };
    const feature: EnvPack<EnvHandle> = {
      name: "ext/feature",
      deps: [base],
      apply: (env) => {
        order.push("feature");
        // base-fn must already be live here (deps applied first)
        env.defineRosetta("feature-fn", { fn: () => "feature" });
      },
    };
    const registry = new Map<string, EnvPack<EnvHandle>>([["feature", feature]]);
    const value = await runWith(registry, `(require/extension :feature) (feature-fn)`);
    expect(order).toEqual(["base", "feature"]); // dep first
    expect(value).toBe("feature");
  });
});
