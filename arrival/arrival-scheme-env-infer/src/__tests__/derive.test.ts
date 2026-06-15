/**
 * D3 — the generic `derive` algebra. The experiment behind V's question: "why a kinded
 * `llm/derive` when `llm` can be a derivable entity that supports ONE generic `derive`?"
 *
 * The answer this file proves: a {@link DerivableEntity} carries its KIND as a value, the
 * GETTER (`(mcp …)` / `(llm …)`) is the only kind-aware verb (it binds the kind, which
 * picks the honest bottom at dispatch), and `derive` is KIND-AGNOSTIC — the SAME verb
 * appends a middleware to an mcp entity or an llm entity, never inspecting the kind. That
 * works because the honest bottom is supplied at dispatch, never at derive time (which is
 * why the chain runner takes `honest` as a parameter). One verb, N kinds.
 *
 * This is the value+verb surface only — the infer-path wiring that runs an llm entity's
 * chain around the model call is the next increment. Here we prove the algebra in isolation.
 */
import { DerivableEntity } from "@here.build/arrival-inference";
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { assembleEnv } from "@here.build/arrival-scheme/env";
import { type SchemeEnv } from "@here.build/arrival-scheme/scheme-env";
import { describe, expect, it } from "vitest";

import { arrivalDeriveCapability } from "../derive.js";

/** Run scheme against an env with the derive-algebra verbs wired (the config-less
 *  `arrivalDeriveCapability` — these are PURE value constructions, no dispatch crosses the
 *  membrane). Return the last value. */
async function run(scm: string): Promise<unknown> {
  const env = sandboxedEnv.inherit("derivable-entity-test");
  await assembleEnv(env as unknown as SchemeEnv, [arrivalDeriveCapability.lower({})]);
  const r = await exec(scm, { env });
  return r.at(-1);
}

describe("the getter binds the kind (the ONLY kind-aware verb)", () => {
  it('(mcp :name) → a kind="mcp" entity', async () => {
    const v = (await run(`(mcp "linear")`)) as DerivableEntity;
    expect(v).toBeInstanceOf(DerivableEntity);
    expect(v.kind).toBe("mcp");
    expect(v.name).toBe("linear");
    expect(v.middleware).toHaveLength(0);
  });

  it('(llm :name) → a kind="llm" entity (the SECOND kind, same getter shape)', async () => {
    const v = (await run(`(llm "gpt-4")`)) as DerivableEntity;
    expect(v).toBeInstanceOf(DerivableEntity);
    expect(v.kind).toBe("llm");
    expect(v.name).toBe("gpt-4");
    expect(v.middleware).toHaveLength(0);
  });

  it('both getters accept a keyword name (:linear → "linear")', async () => {
    expect(((await run(`(mcp :linear)`)) as DerivableEntity).name).toBe("linear");
    expect(((await run(`(llm :sonnet)`)) as DerivableEntity).name).toBe("sonnet");
  });
});

describe("derive is KIND-AGNOSTIC — one verb across kinds", () => {
  it("derives an LLM entity: appends a middleware, carries kind+name through", async () => {
    const v = (await run(`(derive (llm "gpt-4") :infer (lambda (req next progress) (next req)))`)) as DerivableEntity;
    expect(v.kind).toBe("llm"); // the kind rode the value — derive never set or read it
    expect(v.name).toBe("gpt-4");
    expect(v.middleware).toHaveLength(1);
    expect(v.middleware[0]!.method).toBe("infer"); // an llm method — NOT an McpMethod, just a string
  });

  it("the SAME derive verb derives an MCP entity (proves it doesn't dispatch on kind)", async () => {
    const scm = `(derive (mcp "srv") :tools/call (lambda (req next progress) (next req)))`;
    const v = (await run(scm)) as DerivableEntity;
    expect(v.kind).toBe("mcp");
    expect(v.middleware[0]!.method).toBe("tools/call");
  });

  it("derive is immutable + kind-preserving across a chain of derives", async () => {
    const v = (await run(`
      (derive
        (derive (llm "x") :infer (lambda (req next progress) (next req)))
        :infer (lambda (req next progress) (next req)))
    `)) as DerivableEntity;
    expect(v.kind).toBe("llm");
    expect(v.middleware).toHaveLength(2); // both layers present, outer last
  });

  it("a base is never mutated — two derives of one base stay independent", async () => {
    const base = (await run(`(llm "x")`)) as DerivableEntity;
    const d1 = base.withMiddleware({ method: "infer", handler: () => null });
    const d2 = base.withMiddleware({ method: "infer", handler: () => null });
    expect(base.middleware).toHaveLength(0); // base untouched
    expect(d1.middleware).toHaveLength(1);
    expect(d2.middleware).toHaveLength(1);
    expect(d1).not.toBe(d2);
  });

  it("rejects a non-entity base with a legible error (names both getters)", async () => {
    await expect(run(`(derive "not-an-entity" :infer (lambda (req next progress) (next req)))`)).rejects.toThrow(
      /derivable entity.*\(mcp …\).*\(llm …\)/s,
    );
  });
});

describe("llm/with — bind content params to an (llm …) entity (the tweaks op)", () => {
  it("binds params, carrying kind/name through", async () => {
    const v = (await run(`(llm/with (llm "gpt-4") :temperature 0.7)`)) as DerivableEntity;
    expect(v.kind).toBe("llm");
    expect(v.name).toBe("gpt-4");
    expect(v.params).toEqual({ temperature: 0.7 });
    expect(v.middleware).toHaveLength(0);
  });

  it("shallow-merges across calls; a later key wins", async () => {
    const v = (await run(
      `(llm/with (llm/with (llm "x") :temperature 0.7 :system "a") :temperature 0.2)`,
    )) as DerivableEntity;
    expect(v.params).toEqual({ temperature: 0.2, system: "a" }); // system kept, temperature overridden
  });

  it("composes with derive — params AND middleware coexist, order-independent (G3)", async () => {
    const a = (await run(
      `(derive (llm/with (llm "x") :temperature 0.7) :infer (lambda (req next progress) (next req)))`,
    )) as DerivableEntity;
    const b = (await run(
      `(llm/with (derive (llm "x") :infer (lambda (req next progress) (next req))) :temperature 0.7)`,
    )) as DerivableEntity;
    for (const v of [a, b]) {
      expect(v.params).toEqual({ temperature: 0.7 });
      expect(v.middleware).toHaveLength(1);
    }
  });

  it("base is never mutated", async () => {
    // build a base, then `llm/with` it inside scheme and return BOTH to prove independence
    const v = (await run(`(define base (llm "x")) (llm/with base :temperature 0.7) base`)) as DerivableEntity;
    expect(v.params).toBeUndefined(); // the returned `base` is untouched
  });

  it("typed-not-bag: an unknown :keyword is a legible error naming the allowed set", async () => {
    await expect(run(`(llm/with (llm "x") :temperatrue 0.7)`)).rejects.toThrow(
      /unknown param ":temperatrue".*temperature, system/s,
    );
  });

  it("rejects a wrong-typed value (no silent coerce)", async () => {
    await expect(run(`(llm/with (llm "x") :temperature "hot")`)).rejects.toThrow(/:temperature must be a number/);
    await expect(run(`(llm/with (llm "x") :system 5)`)).rejects.toThrow(/:system must be a string/);
  });

  it("rejects a non-llm base (an (mcp …) server)", async () => {
    await expect(run(`(llm/with (mcp "s") :temperature 0.7)`)).rejects.toThrow(/must be an \(llm …\)/);
  });
});
