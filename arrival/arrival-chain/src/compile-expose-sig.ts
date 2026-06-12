import { execGeneratorExpr, execGeneratorFromString, lipsToJs, parseGenerator, sandboxedEnv } from "@here.build/arrival-scheme";

import type { ExposeInfo } from "./extract-expose.js";
import { BUILTIN_PREAMBLE } from "./project.js";

// ── static expose extraction → canonical tagged-list signature ─────────────
//
// `extractExpose` reads a `(declare/expose …)` declaration's SIGNATURE
// pure-statically — it returns the `:input`/`:output` schema clauses as SOURCE
// SLICES (e.g. `"(s/object (s/field/string \"message\"))"`), never running the
// handler (the security property: a config-plane registry sync must not execute
// arbitrary scheme on every keystroke). But the registry — `exposedFunctions.
// declaredSig` — wants the CANONICAL TAGGED LIST (`["object",["message",
// "string"]]`), the same shape the runtime `onExpose` declaration carries and
// the shape `schemaToZod` / `tagToJsonSchema` lower from. So the slices must be
// evaluated to tagged lists.
//
// This is the bridge between the two: it evaluates ONLY the pure `(s/object …)`
// schema sub-expressions of an `ExposeInfo`, exactly as the `.prompt` loader's
// `compileInferUnit` evaluates a Picoschema-compiled `schemaSrc`
// (`schemaSlot(lipsToJs(execExpr(parse(src), { env })))`). The handler is NEVER
// touched here — `ExposeInfo` carries only the schema slices + the boolean
// `hasHandler`, so there is no handler to run. Evaluating a `(s/object …)` form
// is side-effect-free (the `s/…` preamble procs are pure list constructors:
// `(s/object . fields) ⇒ (cons "object" fields)`), so the static security
// property is preserved end to end: extraction parses, this evaluates pure
// schema list-builders, neither reaches the network, the wallet, or the handler.
//
// The schema env is a fresh `sandboxedEnv` with ONLY the `BUILTIN_PREAMBLE`
// loaded — that preamble is where the `s/object` / `s/field/*` / `s/enum` /
// `s/array` definitions live. No `infer` / `data` / `import` / `onExpose`
// capability is bound, so even a (malformed) declaration that smuggled a
// non-schema form into `:input` could only reach the pure preamble bindings,
// never an effect verb.

/**
 * Lazily-built, shared schema-evaluation environment: a `sandboxedEnv` with the
 * `BUILTIN_PREAMBLE` loaded (the `s/object` / `s/field/*` / `s/enum` / `s/array`
 * constructors). Built once per isolate and reused — the preamble is a constant,
 * and the env is only ever READ from here (each `compileExposeSig` evaluates an
 * expression against it without mutating it), so sharing one is safe and saves
 * re-loading the preamble on every registry-sync diff.
 */
let schemaEnvPromise: Promise<ReturnType<typeof sandboxedEnv.inherit>> | null = null;
function schemaEnv(): Promise<ReturnType<typeof sandboxedEnv.inherit>> {
  if (!schemaEnvPromise) {
    schemaEnvPromise = (async () => {
      const env = sandboxedEnv.inherit("expose-schema-eval");
      await execGeneratorFromString(BUILTIN_PREAMBLE, { env });
      return env;
    })();
  }
  return schemaEnvPromise;
}

/**
 * Evaluate one pure `(s/object …)` schema source slice to its canonical tagged
 * list (`["object", …]` / `["enum", …]` / `["array", …]`), or `null` for an
 * absent slice. Pure: the slice is a list-constructor expression over the
 * preamble's `s/…` procs; nothing here runs a handler or reaches an effect.
 *
 * A slice that fails to parse or evaluate yields `null` (a malformed schema is
 * "no structured schema" — the same null `extractExpose`/`renderSchema` produce
 * for an absent one — rather than throwing and stranding the whole registry
 * sync; the malformed declaration surfaces at runtime registration instead).
 */
async function evalSchemaSlice(src: string | null): Promise<unknown | null> {
  if (src === null) return null;
  try {
    const env = await schemaEnv();
    const [form] = await parseGenerator(src);
    if (form === undefined) return null;
    return lipsToJs(await execGeneratorExpr(form, { env }), {});
  } catch {
    return null;
  }
}

/**
 * The shape `exposedFunctions.declaredSig` stores: the canonical `(s/object …)`
 * tagged lists for input/output (or null) + the static handler-presence fact.
 * Identical to host's `DeclaredSig`, declared here so the engine owns the
 * "static extraction → registry signature" lowering (host re-shapes it onto
 * its column type without re-deriving the tagged lists).
 */
export interface ExposeSig {
  /** Canonical `(s/object …)` tagged list for the input, or null. */
  input: unknown | null;
  /** Canonical `(s/object …)` tagged list for the output, or null. */
  output: unknown | null;
  /** Canonical `(s/object …)` tagged list for the declared filterable `:meta`
   *  observability dimensions, or null. */
  meta: unknown | null;
  /** Whether the declaration carries a `:handler` (static completeness). */
  hasHandler: boolean;
}

/**
 * Compile one statically-extracted {@link ExposeInfo} into its canonical
 * {@link ExposeSig} — evaluating the `:input`/`:output` schema slices to tagged
 * lists. Pure + handler-free (see the module header): the same lowering the
 * runtime `onExpose` path produces, but reached without ever running the
 * handler, so a registry sync can run it on every draft edit safely.
 *
 * `hasHandler` passes through from the static extraction unchanged — it is the
 * one fact about the handler the registry records (presence), and it is already
 * known statically (a declaration without a `:handler` is incomplete and will
 * fail at runtime registration, which the gate can surface).
 */
export async function compileExposeSig(info: ExposeInfo): Promise<ExposeSig> {
  const [input, output, meta] = await Promise.all([
    evalSchemaSlice(info.inputSrc),
    evalSchemaSlice(info.outputSrc),
    evalSchemaSlice(info.metaSrc),
  ]);
  return { input, output, meta, hasHandler: info.hasHandler };
}
