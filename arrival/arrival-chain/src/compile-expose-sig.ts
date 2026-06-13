import {
  execGeneratorExpr,
  execGeneratorFromString,
  lipsToJs,
  parseGenerator,
  sandboxedEnv,
} from "@here.build/arrival-scheme";

import { extractOverridables, extractRequires, type ExposeInfo } from "./extract-expose.js";
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
 * Evaluate one pure source slice to a JS value via the sandboxed schema env — a schema
 * `(s/…)` form to its canonical tagged list (`["object", …]` / `["enum", …]`), OR an
 * overridable's literal default to its value (`"gpt-4o"` → `"gpt-4o"`, `5` → `5`). `null`
 * for an absent slice. Pure: the slice is a list-constructor / literal over the preamble's
 * `s/…` procs; nothing here runs a handler or reaches an effect.
 *
 * A slice that fails to parse or evaluate yields `null` (a malformed schema is "no
 * structured schema" — the same null `extractExpose`/`renderSchema` produce for an absent
 * one — rather than throwing and stranding the consumer; the malformed declaration surfaces
 * at runtime registration instead).
 */
async function evalPureSlice(src: string | null): Promise<unknown | null> {
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
    evalPureSlice(info.inputSrc),
    evalPureSlice(info.outputSrc),
    evalPureSlice(info.metaSrc),
  ]);
  return { input, output, meta, hasHandler: info.hasHandler };
}

// ── overridable holes → form-field spec (the N3 form lens) ─────────────────
//
// The form lens renders each top-level `define/overridable` as a typed input: its schema
// picks the control, its default seeds the value. Evaluated pure-statically (same sandbox
// as the expose sigs) — opening the form costs no inference and runs no handler. The form
// is a projection of the declaration; field edits feed `kernel.setOverride(name, value)`.

/** Which input control a hole's schema maps to. The studio renders by `kind`, so the
 *  `s/…` tag encoding stays inside the engine (never re-parsed in the UI). An object /
 *  array / unrecognised schema is `unsupported` — the form shows a read-only fallback
 *  rather than guessing a control. */
export type FormFieldKind =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "integer" }
  | { kind: "boolean" }
  | { kind: "enum"; options: unknown[] }
  | { kind: "unsupported"; schemaTag: unknown };

/** One rendered form field: the hole's name (its caller-arg identity + override key), its
 *  declared default (the seed value), and the control its schema selects. */
export interface FormHole {
  name: string;
  default: unknown;
  field: FormFieldKind;
}

/** Map an evaluated `(s/…)` schema tag to a form-field control choice. */
function fieldKindOf(schemaTag: unknown): FormFieldKind {
  if (schemaTag === "string") return { kind: "string" };
  if (schemaTag === "number") return { kind: "number" };
  if (schemaTag === "integer") return { kind: "integer" };
  if (schemaTag === "boolean") return { kind: "boolean" };
  if (Array.isArray(schemaTag) && schemaTag[0] === "enum") return { kind: "enum", options: schemaTag.slice(1) };
  return { kind: "unsupported", schemaTag };
}

/** Options for {@link extractFormSpec}. */
export interface FormSpecOptions {
  /** Source resolver for `(require …)`. When provided, the spec ALSO includes the overridable
   *  knobs of each DIRECTLY-required file (one level) — so a cell that is just
   *  `(require "config.scm")` renders config.scm's knobs. Returns the file's source, or null
   *  when unresolvable. Reads source only (never executes), so the pure-static property holds. */
  resolveRequire?: (path: string) => Promise<string | null>;
}

/**
 * The N3 form spec for a source: every top-level `define/overridable` as a typed field
 * ({@link FormHole}), optionally reaching THROUGH `(require …)` into required files (the
 * config-in-config.scm pattern). Pure + handler-free — `extractOverridables` parses
 * statically, each hole's schema + default slices evaluate in the sandboxed schema env, and
 * `resolveRequire` reads (never runs) the required source. Opening the form spends nothing;
 * the field values feed `kernel.setOverride(name, value)` at run.
 */
export async function extractFormSpec(source: string, opts: FormSpecOptions = {}): Promise<FormHole[]> {
  // The cell's own source, then (if a resolver is given) each directly-required file — a cell
  // that only `(require "config.scm")`s renders config.scm's knobs.
  const sources = [source];
  if (opts.resolveRequire) {
    for (const r of await extractRequires(source)) {
      const s = await opts.resolveRequire(r).catch(() => null);
      if (s != null) sources.push(s);
    }
  }
  // Holes across the cell + required files, deduped by name (cell-first wins a collision).
  const seen = new Set<string>();
  const out: FormHole[] = [];
  for (const src of sources) {
    for (const h of await extractOverridables(src)) {
      if (seen.has(h.name)) continue;
      seen.add(h.name);
      out.push({
        name: h.name,
        default: await evalPureSlice(h.defaultSrc),
        field: fieldKindOf(await evalPureSlice(h.schemaSrc)),
      });
    }
  }
  return out;
}
