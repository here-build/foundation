/**
 * `(sql/query …)` faithful PARAM coercion — node A3-sql/query.
 *
 * The `data-effects.test.ts` sibling covers the shared membrane contract (inert
 * default, the canonical descriptor, the result crossing back). This file owns the
 * sql verb's param-list discipline: the SEPARATION of positional binds from the
 * query text (the whole injection-safety property) plus the scalar-only v1 bind
 * contract — including the empty-scheme-list membrane gap the scaffold missed
 * (`(list)` crosses as a `Nil`, not a JS `[]`).
 *
 * Tests the MEMBRANE directly — `defineDataEffectRosettas` over a bare
 * `sandboxedEnv`, no Project — so the coercion is verified independent of the
 * run / effect-log wiring (kept a separate file from the http fan so the two A3
 * instances never collide on one source — the FAN-OUT file-per-instance rule).
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { type DataEffect, type DataEffectResolver, defineDataEffectRosettas } from "../data-effects.js";

/** Fresh sandbox per test, sql/http verbs armed with `resolve`. A minimal `dict`
 *  is registered locally (the real one lives in `buildArrivalEnv`, which this test
 *  deliberately doesn't build — the membrane is exercised in isolation) so the
 *  composite-rejection cases can author a dict in scheme. */
function envWith(resolve: DataEffectResolver): ReturnType<typeof sandboxedEnv.inherit> {
  const env = sandboxedEnv.inherit("data-effects-sql-test");
  env.defineRosetta("dict", {
    fn: (...args: unknown[]) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) out[String(args[i])] = args[i + 1];
      return out;
    },
  });
  defineDataEffectRosettas(env, resolve);
  return env;
}

const run = async (env: ReturnType<typeof sandboxedEnv.inherit>, scm: string): Promise<unknown> => {
  const results = await exec(scm, { env });
  const last = results.at(-1);
  return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
};

/** Capture the canonical effect a single (sql/query …) form produces. */
const captureSql = async (scm: string): Promise<DataEffect> => {
  let captured: DataEffect | undefined;
  await run(
    envWith(async (_ctx, e) => {
      captured = e;
      return [];
    }),
    scm,
  );
  if (!captured) throw new Error("resolver was not called");
  return captured;
};

describe("sql/query — the empty param list crosses the membrane as []", () => {
  it("an EXPLICIT empty list (list) ⇒ params === [] (not a spurious [nil])", async () => {
    // The membrane gap the scaffold missed: `(list)` crosses as a `Nil` instance,
    // NOT a JS []. The naive `[params]` fallback bound a junk nil sentinel to a
    // placeholder-free query AND poisoned the effect-log content key. Must be [].
    const e = await captureSql(`(sql/query "db" "select 1" (list))`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual([]);
  });

  it("a quoted empty list '() ⇒ params === []", async () => {
    const e = await captureSql(`(sql/query "db" "select 1" '())`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual([]);
  });

  it("an omitted params arg ⇒ params === []", async () => {
    const e = await captureSql(`(sql/query "db" "select 1")`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual([]);
  });
});

describe("sql/query — positional binds stay SEPARATE from the query text (injection-safe)", () => {
  it("the query string carries the placeholders; values ride in params, never spliced", async () => {
    const e = await captureSql(`(sql/query "analytics" "select * from t where id = $1 and name = $2" (list 7 "ada"))`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.query).toBe("select * from t where id = $1 and name = $2"); // text untouched
    expect(e.params).toEqual([7, "ada"]); // values bound positionally, off the text
  });

  it("scalar params are preserved BY TYPE (number/bool stay number/bool — the content key is faithful)", async () => {
    const e = await captureSql(`(sql/query "db" "select … $1 $2 $3" (list "ada" 42 #t))`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual(["ada", 42, true]);
  });

  it("a bare (non-list) scalar param is sugar for a one-element list", async () => {
    const e = await captureSql(`(sql/query "db" "select $1" 42)`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual([42]);
  });
});

describe("sql/query — the scalar-only v1 bind contract", () => {
  it("a nil ELEMENT in the list binds as SQL NULL (a legitimate positional value)", async () => {
    // `'()` used as a *value* (not the whole-list empty case) ⇒ null, so the driver
    // sends `$2 = NULL` rather than choking on a Nil object / a wrong content key.
    const e = await captureSql(`(sql/query "db" "select … where a = $1 and b = $2 and c = $3" (list 1 '() 3))`);
    if (e.kind !== "sql") throw new Error("expected sql");
    expect(e.params).toEqual([1, null, 3]);
  });

  it("a COMPOSITE element (a list) is REJECTED with a teaching error naming the 1-based position", async () => {
    // a positional bind can't be a structure — reject at the verb (errors-as-doors),
    // never hand the resolver a non-scalar or mint an uncanonicalisable content key.
    await expect(captureSql(`(sql/query "db" "select $1" (list (list 1 2)))`)).rejects.toThrow(
      /param \$1 must be a scalar/i,
    );
  });

  it("a COMPOSITE element (a dict) is REJECTED, naming its 1-based position", async () => {
    await expect(captureSql(`(sql/query "db" "select … $1 $2" (list 7 (dict "k" "v")))`)).rejects.toThrow(
      /param \$2 must be a scalar/i,
    );
  });

  it("the rejection routes to the fix (bind scalars separately / serialise) — errors-as-doors", async () => {
    await expect(captureSql(`(sql/query "db" "select $1" (list (list 1 2)))`)).rejects.toThrow(
      /bind each scalar separately|serialise/i,
    );
  });
});
