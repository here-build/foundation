/**
 * `(declare/expose …)` — the sealed-skill form (node A1). Two halves:
 *
 *   1. `extractExpose` — STATIC parse-time extraction (the config-plane sync
 *      path). Mirrors `extractDefines`: top-level only, declaration order, `[]`
 *      on parse failure, and — the security property — the handler NEVER runs.
 *      `:input`/`:output` come back as exact `(s/object …)` source slices.
 *
 *   2. The RUNTIME rosetta wired into `buildArrivalEnv`: evaluating the form
 *      hands the host (`onExpose`) a typed declaration — name + the evaluated
 *      schemas + a JS-bridged handler — and returns the handler so the function
 *      is usable in-program in the same draft.
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival-scheme";
import { describe, expect, it } from "vitest";

import { type ExposeDeclaration, defineExposeRosetta } from "../expose.js";
import { extractExpose } from "../extract-expose.js";
import { BUILTIN_PREAMBLE, buildArrivalEnv } from "../project.js";
import { loaderFromResolver } from "../loader.js";

// ── static extraction ────────────────────────────────────────────────

describe("extractExpose (static)", () => {
  it("returns [] for empty / whitespace source", async () => {
    expect(await extractExpose("")).toEqual([]);
    expect(await extractExpose("   \n\n")).toEqual([]);
  });

  it("returns [] for unparseable source", async () => {
    expect(await extractExpose("(declare/expose (unbalanced")).toEqual([]);
  });

  it("extracts name + input/output source slices + handler presence", async () => {
    const [decl] = await extractExpose(`
      (declare/expose "classify-ticket"
        :input  (s/object (s/field/string "message"))
        :output (s/object (s/field/string "label") (s/field/number "confidence"))
        :handler (lambda (input) (list "label" "bug" "confidence" 0.9)))
    `);
    expect(decl).toBeDefined();
    expect(decl!.name).toBe("classify-ticket");
    expect(decl!.inputSrc).toBe(`(s/object (s/field/string "message"))`);
    expect(decl!.outputSrc).toBe(`(s/object (s/field/string "label") (s/field/number "confidence"))`);
    expect(decl!.hasHandler).toBe(true);
  });

  it("does NOT evaluate the handler (a throwing body still extracts cleanly)", async () => {
    // If extraction evaluated anything, this `(error …)` in the handler would
    // surface. It must not — extraction is pure parse.
    const decls = await extractExpose(`
      (declare/expose "boom"
        :input (s/object (s/field/string "x"))
        :handler (lambda (input) (error "handler must not run during extraction")))
    `);
    expect(decls.map((d) => d.name)).toEqual(["boom"]);
    expect(decls[0]!.hasHandler).toBe(true);
  });

  it("tolerates a declaration without :input or :output", async () => {
    const [decl] = await extractExpose(`
      (declare/expose "ping" :handler (lambda (input) "pong"))
    `);
    expect(decl!.name).toBe("ping");
    expect(decl!.inputSrc).toBeNull();
    expect(decl!.outputSrc).toBeNull();
    expect(decl!.hasHandler).toBe(true);
  });

  it("flags a declaration missing its handler (hasHandler=false)", async () => {
    const [decl] = await extractExpose(`
      (declare/expose "incomplete" :input (s/object (s/field/string "x")))
    `);
    expect(decl!.name).toBe("incomplete");
    expect(decl!.hasHandler).toBe(false);
  });

  it("ignores a non-string name", async () => {
    expect(await extractExpose(`(declare/expose some-symbol :handler (lambda (i) i))`)).toEqual([]);
  });

  it("enumerates multiple top-level declarations in order", async () => {
    const decls = await extractExpose(`
      (declare/expose "first"  :handler (lambda (i) i))
      (define unrelated 42)
      (declare/expose "second" :handler (lambda (i) i))
      (declare/expose "third"  :handler (lambda (i) i))
    `);
    expect(decls.map((d) => d.name)).toEqual(["first", "second", "third"]);
  });

  it("ignores nested (declare/expose …) inside another form", async () => {
    const decls = await extractExpose(`
      (define (wrapper)
        (declare/expose "nested" :handler (lambda (i) i)))
      (declare/expose "top" :handler (lambda (i) i))
    `);
    expect(decls.map((d) => d.name)).toEqual(["top"]);
  });

  it("keeps a `)` inside a string literal from closing the slice early", async () => {
    const [decl] = await extractExpose(`
      (declare/expose "tricky"
        :input (s/object (s/field/string "note" "has a ) paren and a \\" quote"))
        :handler (lambda (i) i))
    `);
    expect(decl!.inputSrc).toBe(`(s/object (s/field/string "note" "has a ) paren and a \\" quote"))`);
  });

  it("attaches a source location to each declaration, in order", async () => {
    const decls = await extractExpose(
      `(declare/expose "a" :handler (lambda (i) i))\n(declare/expose "b" :handler (lambda (i) i))`,
    );
    expect(decls[0]!.location).toBeDefined();
    expect(decls[1]!.location).toBeDefined();
    expect(decls[0]!.location!.offset).toBeLessThan(decls[1]!.location!.offset);
  });
});

// ── runtime form ─────────────────────────────────────────────────────

/** Build a full arrival env (the `s/…` preamble present) with an `onExpose`
 *  sink that records every declaration. `infer` is a stub — these tests never
 *  call it. */
async function envWithExpose(): Promise<{
  env: Awaited<ReturnType<typeof buildArrivalEnv>>;
  declarations: ExposeDeclaration[];
}> {
  const declarations: ExposeDeclaration[] = [];
  const env = await buildArrivalEnv({
    name: "expose-test",
    infer: async () => "stub",
    loader: loaderFromResolver(async () => {
      throw new Error("no requires in this test");
    }),
    onExpose: (d) => {
      declarations.push(d);
    },
  });
  await exec(BUILTIN_PREAMBLE, { env });
  return { env, declarations };
}

describe("declare/expose (runtime form)", () => {
  it("registers a typed declaration with the host on evaluation", async () => {
    const { env, declarations } = await envWithExpose();
    await exec(
      `(declare/expose "classify"
         :input  (s/object (s/field/string "message"))
         :output (s/object (s/field/string "label"))
         :handler (lambda (input) (list "label" "bug")))`,
      { env },
    );
    expect(declarations).toHaveLength(1);
    const decl = declarations[0]!;
    expect(decl.name).toBe("classify");
    // The schemas evaluate to canonical tagged lists — the same shape the
    // picoschema / schema→zod lowering consumes.
    expect(decl.inputSchema).toEqual(["object", ["message", "string"]]);
    expect(decl.outputSchema).toEqual(["object", ["label", "string"]]);
    expect(typeof decl.handler).toBe("function");
  });

  it("the registered handler runs the scheme body and returns plain JS", async () => {
    const { env, declarations } = await envWithExpose();
    await exec(
      `(declare/expose "greet"
         :input  (s/object (s/field/string "who"))
         :output (s/object (s/field/string "greeting"))
         :handler (lambda (input) (list "greeting" (string-append "hi " (@ input "who")))))`,
      { env },
    );
    const out = await declarations[0]!.handler({ who: "V" });
    // Handler returns a scheme list `("greeting" "hi V")`, bridged to a JS array.
    expect(out).toEqual(["greeting", "hi V"]);
  });

  it("the form's value IS the handler — usable in-program in the same draft", async () => {
    const { env } = await envWithExpose();
    const results = await exec(
      `(define classify
         (declare/expose "classify"
           :input  (s/object (s/field/string "msg"))
           :output (s/object (s/field/string "label"))
           :handler (lambda (input) (list "label" (@ input "msg")))))
       (classify (dict "msg" "hello"))`,
      { env },
    );
    const last = results.at(-1);
    const resolved = last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
    // `(classify …)` returns the scheme list `("label" "hello")`.
    expect(JSON.stringify(resolved)).toContain("hello");
  });

  it("omitting :input / :output leaves those schema slots null", async () => {
    const { env, declarations } = await envWithExpose();
    await exec(`(declare/expose "ping" :handler (lambda (input) "pong"))`, { env });
    expect(declarations[0]!.inputSchema).toBeNull();
    expect(declarations[0]!.outputSchema).toBeNull();
  });

  it("throws a teaching error when :handler is missing", async () => {
    const { env } = await envWithExpose();
    await expect(
      exec(`(declare/expose "no-handler" :input (s/object (s/field/string "x")))`, { env }),
    ).rejects.toThrow(/missing a :handler/i);
  });

  it("static extraction and runtime registration agree on name (the correlation key)", async () => {
    const source = `(declare/expose "agree"
  :input (s/object (s/field/string "x"))
  :handler (lambda (input) input))`;
    const staticDecls = await extractExpose(source);
    const { env, declarations } = await envWithExpose();
    await exec(source, { env });
    // The host correlates the two views by NAME (the registry key). Location is
    // a static-only fact (the runtime handler is a JS closure with no source
    // offset) — the static entry owns it.
    expect(staticDecls.map((d) => d.name)).toEqual(declarations.map((d) => d.name));
    expect(staticDecls[0]!.location).toBeDefined();
    // The static input slice and the runtime tagged list describe the same schema.
    expect(staticDecls[0]!.inputSrc).toBe(`(s/object (s/field/string "x"))`);
    expect(declarations[0]!.inputSchema).toEqual(["object", ["x", "string"]]);
  });

  it("evaluates the form (registering nowhere) when no onExpose sink is supplied", async () => {
    // Same "capability optional, verb always present" posture as import/data:
    // the form still produces its handler even with no host registry.
    const env = await buildArrivalEnv({
      name: "expose-no-sink",
      infer: async () => "stub",
      loader: loaderFromResolver(async () => {
        throw new Error("no requires");
      }),
    });
    await exec(BUILTIN_PREAMBLE, { env });
    const results = await exec(
      `(define f (declare/expose "x" :handler (lambda (i) i))) (f "echo")`,
      { env },
    );
    const last = results.at(-1);
    const resolved = last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
    expect(JSON.stringify(resolved)).toContain("echo");
  });
});
