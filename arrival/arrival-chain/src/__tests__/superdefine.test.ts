/**
 * The "superpowered define" family — `define/overridable` + `define/exposed`.
 *
 * Both are PREAMBLE MACROS that expand to a plain `(define name (<rosetta> …))`,
 * so the interpreter core only ever sees `define` + an ordinary call (the
 * membrane rule — no expose/override concept in the pure dataflow core). The
 * name binds and stays usable in-program; the superpower (host registration +
 * override resolution + a derived arg surface) is additive and host-side.
 *
 *   1. RUNTIME: the rosettas registered in `buildArrivalEnv` — `define/overridable`
 *      resolves default/override + registers a descriptor; `define/exposed`
 *      registers an expose declaration keyed by name.
 *   2. STATIC: `extractReachableOverridables` derives, per exposed function, the
 *      transitively-referenced overridables — its argument surface.
 */
import { execGeneratorFromString as exec, schemeToJs } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

/** Evaluate a program and bridge the LAST top-level form's value to plain JS.
 *  `exec` returns the list of every top-level form's value; the trailing
 *  expression is the one under test (a leading `define` yields `undefined`). */
const run = async (src: string, env: Awaited<ReturnType<typeof buildArrivalEnv>>): Promise<unknown> => {
  const results = schemeToJs(await exec(src, { env }), {});
  return Array.isArray(results) ? results[results.length - 1] : results;
};

import { type ExposeDeclaration } from "../expose.js";
import { type OverridableDescriptor, type ResolveOverride } from "../overridable.js";
import { extractReachableOverridables } from "../extract-expose.js";
import { BUILTIN_PREAMBLE, buildArrivalEnv } from "../project.js";
import { loaderFromResolver } from "../loader.js";

async function envWith(resolveOverride?: ResolveOverride): Promise<{
  env: Awaited<ReturnType<typeof buildArrivalEnv>>;
  exposes: ExposeDeclaration[];
  overridables: OverridableDescriptor[];
}> {
  const exposes: ExposeDeclaration[] = [];
  const overridables: OverridableDescriptor[] = [];
  const env = await buildArrivalEnv({
    name: "superdefine-test",
    infer: async () => "stub",
    loader: loaderFromResolver(async () => {
      throw new Error("no requires in this test");
    }),
    onExpose: (d) => {
      exposes.push(d);
    },
    onOverridable: (d) => {
      overridables.push(d);
    },
    resolveOverride,
  });
  await exec(BUILTIN_PREAMBLE, { env });
  return { env, exposes, overridables };
}

describe("define/overridable (runtime)", () => {
  it("resolves to the default when no override is supplied", async () => {
    const { env } = await envWith();
    const out = await run(`(define/overridable model "gpt-4o" (s/enum "gpt-4o" "claude")) model`, env);
    expect(out).toBe("gpt-4o");
  });

  it("resolves to a valid host override over the default", async () => {
    const { env } = await envWith((name) => (name === "model" ? "claude" : undefined));
    const out = await run(`(define/overridable model "gpt-4o" (s/enum "gpt-4o" "claude")) model`, env);
    expect(out).toBe("claude");
  });

  it("rejects an invalid override and falls back to the default", async () => {
    const { env } = await envWith(() => "not-a-listed-enum-value");
    const out = await run(`(define/overridable model "gpt-4o" (s/enum "gpt-4o" "claude")) model`, env);
    expect(out).toBe("gpt-4o");
  });

  it("errors when the default does not satisfy its schema", async () => {
    const { env } = await envWith();
    await expect(
      exec(`(define/overridable model "mistral" (s/enum "gpt-4o" "claude")) model`, { env }),
    ).rejects.toThrow(/default does not satisfy/i);
  });

  it("registers a descriptor with name, schema tag and default", async () => {
    const { env, overridables } = await envWith();
    await exec(`(define/overridable maxRetries 3 "number") maxRetries`, { env });
    expect(overridables).toHaveLength(1);
    const d = overridables[0]!;
    expect(d.name).toBe("maxRetries");
    expect(d.default).toBe(3);
  });

  it("keeps natural define behavior — the name is usable in-program", async () => {
    const { env } = await envWith();
    const out = await run(`(define/overridable n 2 "number") (+ n n)`, env);
    expect(out).toBe(4);
  });
});

describe("define/exposed (runtime)", () => {
  it("registers an expose declaration keyed by name", async () => {
    const { env, exposes } = await envWith();
    await exec(`(define/exposed runResearch (lambda (input) (list "ok" input)))`, { env });
    expect(exposes).toHaveLength(1);
    const d = exposes[0]!;
    expect(d.name).toBe("runResearch");
    expect(d.inputSchema).toBeNull();
    expect(d.outputSchema).toBeNull();
    expect(d.metaSchema).toBeNull();
    expect(typeof d.handler).toBe("function");
  });

  it("passes :input/:output/:meta schema slots through to the declaration", async () => {
    const { env, exposes } = await envWith();
    await exec(
      `(define/exposed classify
         :input  (s/object (s/field/string "message"))
         :output (s/object (s/field/string "label") (s/field/number "confidence"))
         :meta   (s/object (s/field/enum "tier" (s/enum "free" "pro")))
         (lambda (input) input))`,
      { env },
    );
    expect(exposes).toHaveLength(1);
    const d = exposes[0]!;
    expect(d.name).toBe("classify");
    expect(d.inputSchema).toEqual(["object", ["message", "string"]]);
    expect(d.outputSchema).toEqual(["object", ["label", "string"], ["confidence", "number"]]);
    expect(d.metaSchema).toEqual(["object", ["tier", ["enum", "free", "pro"]]]);
    expect(typeof d.handler).toBe("function");
  });

  it("collapses to declare/expose — both fronts produce an equivalent declaration", async () => {
    const { env: e1, exposes: viaDefine } = await envWith();
    await exec(
      `(define/exposed classify
         :input  (s/object (s/field/string "message"))
         :meta   (s/object (s/field/enum "tier" (s/enum "free" "pro")))
         (lambda (input) input))`,
      { env: e1 },
    );
    const { env: e2, exposes: viaDeclare } = await envWith();
    await exec(
      `(declare/expose "classify"
         :input  (s/object (s/field/string "message"))
         :meta   (s/object (s/field/enum "tier" (s/enum "free" "pro")))
         :handler (lambda (input) input))`,
      { env: e2 },
    );
    const strip = (d: ExposeDeclaration) => ({
      name: d.name,
      inputSchema: d.inputSchema,
      outputSchema: d.outputSchema,
      metaSchema: d.metaSchema,
    });
    expect(strip(viaDefine[0]!)).toEqual(strip(viaDeclare[0]!));
  });

  it("the registered handler runs the body and returns plain JS", async () => {
    const { env, exposes } = await envWith();
    await exec(`(define/exposed echo (lambda (input) (list "echo" input)))`, { env });
    expect(await exposes[0]!.handler("hi")).toEqual(["echo", "hi"]);
  });

  it("keeps natural define behavior — the function is callable in-program", async () => {
    const { env } = await envWith();
    const out = await run(`(define/exposed dbl (lambda (x) (* 2 x))) (dbl 21)`, env);
    expect(out).toBe(42);
  });

  it("coexists with legacy declare/expose on the same registry", async () => {
    const { env, exposes } = await envWith();
    await exec(`(define/exposed a (lambda (i) i))`, { env });
    await exec(`(declare/expose "b" :handler (lambda (i) i))`, { env });
    expect(exposes.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("extractReachableOverridables (static derived arg surface)", () => {
  it("[] on parse failure", async () => {
    expect(await extractReachableOverridables("(define/exposed f (")).toEqual([]);
  });

  it("derives the overridables a function transitively references — a subset", async () => {
    const src = `
      (define/overridable apiKey "" (s/object))
      (define/overridable model "gpt-4o" (s/enum "gpt-4o" "claude"))
      (define/overridable unused "x" (s/object))
      (define (call-model q) (list model q))
      (define/exposed runResearch
        (lambda (q) (call-model q)))
    `;
    const [fn] = await extractReachableOverridables(src);
    expect(fn!.name).toBe("runResearch");
    // Reaches `model` (via call-model) but NOT `apiKey` or `unused`.
    expect(fn!.overridables.map((o) => o.name)).toEqual(["model"]);
    expect(fn!.overridables[0]!.schemaSrc).toBe(`(s/enum "gpt-4o" "claude")`);
    expect(fn!.overridables[0]!.defaultSrc).toBe(`"gpt-4o"`);
  });

  it("reaches multiple overridables transitively across helper defines", async () => {
    const src = `
      (define/overridable a 1 (s/object))
      (define/overridable b 2 (s/object))
      (define (helper) (list a))
      (define (mid) (list (helper) b))
      (define/exposed top (lambda () (mid)))
    `;
    const [fn] = await extractReachableOverridables(src);
    expect(fn!.overridables.map((o) => o.name).sort()).toEqual(["a", "b"]);
  });

  it("isolates each exposed function's own surface", async () => {
    const src = `
      (define/overridable x 1 (s/object))
      (define/overridable y 2 (s/object))
      (define/exposed usesX (lambda () (list x)))
      (define/exposed usesY (lambda () (list y)))
    `;
    const fns = await extractReachableOverridables(src);
    const byName = Object.fromEntries(fns.map((f) => [f.name, f.overridables.map((o) => o.name)]));
    expect(byName.usesX).toEqual(["x"]);
    expect(byName.usesY).toEqual(["y"]);
  });
});
