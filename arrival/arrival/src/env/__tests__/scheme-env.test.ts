// scheme-env — bootstrap-sequence packs lower to kernel EnvPacks and run in C3 order.
import { describe, expect, it } from "vitest";

import { assembleEnv, type EnvPack } from "../kernel.js";
import { type EvalSchemeInto, schemePacks, type SchemeEnv } from "../scheme-env.js";

/** A fake env that records every contribution in order (bootstrap evals + wires). */
function recorder(): { env: SchemeEnv; log: string[] } {
  const log: string[] = [];
  const env: SchemeEnv = {
    set: (name) => (log.push(`set:${name}`), undefined),
    get: () => undefined,
    defineRosetta: (name) => log.push(`rosetta:${name}`),
    inherit: () => env,
  };
  return { env, log };
}

describe("schemePacks — bootstrap + wire, in dependency order", () => {
  it("evaluates bootstrap THEN runs wire for a single pack", async () => {
    const { env, log } = recorder();
    const evalScheme: EvalSchemeInto = (_e, src) => void log.push(`eval:${src}`);
    const make = schemePacks(evalScheme);

    const pack = make({ name: "p", bootstrap: "(define-macro …)", wire: (e) => e.defineRosetta("op", { fn: () => 0 }) });
    await assembleEnv(env, [pack]);

    expect(log).toEqual(["eval:(define-macro …)", "rosetta:op"]);
  });

  it("a dependency's bootstrap runs before its dependent's (C3 order)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<SchemeEnv>((_e, src) => void log.push(src));

    const base = make({ name: "base", bootstrap: "BASE" });
    const dependent = make({ name: "dependent", deps: [base], bootstrap: "DEPENDENT" });
    await assembleEnv(env, [dependent]);

    // least-precedence (deps) applied first ⇒ BASE before DEPENDENT.
    expect(log).toEqual(["BASE", "DEPENDENT"]);
  });

  it("produces a plain kernel EnvPack (composes with pure-JS packs)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<SchemeEnv>((_e, src) => void log.push(`scm:${src}`));

    const schemePack = make({ name: "scheme", bootstrap: "DEFS" });
    const jsPack: EnvPack<SchemeEnv> = { name: "js", apply: (e) => e.set("native", 1) };
    await assembleEnv(env, [jsPack, schemePack]);

    expect(log.sort()).toEqual(["scm:DEFS", "set:native"]);
  });

  it("a bootstrap-less pack is just its wire (no eval)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<SchemeEnv>(() => void log.push("EVAL-SHOULD-NOT-RUN"));
    await assembleEnv(env, [make({ name: "wire-only", wire: (e) => e.set("x", 1) })]);
    expect(log).toEqual(["set:x"]);
  });
});
