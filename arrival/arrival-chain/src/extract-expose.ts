/**
 * Enumerate top-level `(declare/expose …)` forms in a Scheme source — the
 * substrate primitive behind host's exposed-functions registry (the
 * "sealed skill" surface). The static twin of the runtime `declare/expose`
 * rosetta (see `buildArrivalEnv` in project.ts): this reads the *declared
 * signature* without evaluating anything, so the registry can be synced from
 * a draft WITHOUT running the handler.
 *
 * Recognises:
 *   (declare/expose "name"
 *     :input  (s/object …)         ; optional
 *     :output (s/object …)         ; optional
 *     :handler (lambda (input) …))  ; required at runtime, ignored statically
 *
 * The `:input`/`:output` values are captured as SOURCE SLICES — the exact
 * `(s/object …)` text — not evaluated. host (the A2 schema→zod bridge / the
 * picoschema lowering) evaluates just those pure schema expressions later to
 * derive `exposedFunctions.declaredSig`, exactly as the loader stores a
 * `.prompt`'s `schemaSrc` and evaluates it once in `compileInferUnit`. Keeping
 * extraction pure-static is the security property: the handler — arbitrary
 * scheme — never runs during a config-plane sync.
 *
 * Quietly ignores anything that isn't a top-level `(declare/expose "name" …)`
 * (nested forms, forms inside `(begin …)`, a non-string name). Returns `[]` if
 * the source fails to parse; the caller renders parse errors through its own
 * channel — same contract as `extractDefines`.
 *
 * Pair / SchemeSymbol / SchemeString are duck-typed because the concrete
 * classes are not in arrival-scheme's public surface — same approach as
 * `extract-defines.ts`. The `__location__` symbol is a registry symbol
 * (`Symbol.for("__location__")`) read off Pairs without importing primitives.
 */
import { parseGenerator } from "@here.build/arrival-scheme";

import type { SourceLocation } from "./extract-defines.js";

export type { SourceLocation } from "./extract-defines.js";

export interface ExposeInfo {
  /** The exposed function's name (the first arg, a string literal). */
  name: string;
  /** Source slice of the `:input` `(s/object …)` form, or null when absent.
   *  Pure schema text — evaluate (it has no side effects) to get the tagged
   *  list, then lower to JSON-schema / zod. */
  inputSrc: string | null;
  /** Source slice of the `:output` `(s/object …)` form, or null when absent. */
  outputSrc: string | null;
  /** True when a `:handler` clause is present. The handler body is NOT sliced
   *  or evaluated here — its presence is the only static fact (a declaration
   *  without a handler is incomplete and will fail at runtime registration). */
  hasHandler: boolean;
  /** Source location of the `(declare/expose …)` form. */
  location?: SourceLocation;
}

/** The form head we recognise. Exported so the runtime rosetta and any
 *  tooling name it from one place rather than restating the string. */
export const EXPOSE_FORM = "declare/expose";

const LOCATION_KEY = Symbol.for("__location__");

const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

const isSymbol = (v: unknown): v is { __name__: string | symbol } =>
  v !== null && typeof v === "object" && "__name__" in v;

const isString = (v: unknown): v is { __string__: string } =>
  v !== null && typeof v === "object" && "__string__" in v && typeof (v as { __string__: unknown }).__string__ === "string";

const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

const locationOf = (form: unknown): SourceLocation | undefined =>
  (form as Record<symbol, unknown>)[LOCATION_KEY] as SourceLocation | undefined;

/**
 * Slice a balanced parenthesised form out of `source`, starting at `offset`
 * (which must point at the opening `(`). Respects string literals and their
 * escapes so a `)` inside `"…"` doesn't close the form early. Returns the
 * exact text including both delimiters, or null if the slice can't be balanced
 * (truncated source / wrong offset) — the caller then records the schema as
 * absent rather than emitting a malformed slice.
 */
function sliceForm(source: string, offset: number): string | null {
  if (source[offset] !== "(") return null;
  let depth = 0;
  let inString = false;
  for (let i = offset; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped char
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(offset, i + 1);
    }
  }
  return null;
}

/**
 * Fold a `(declare/expose …)` argument tail into its keyword clauses.
 *
 * The keyword tokens (`:input`, `:output`, `:handler`) parse as bare symbols
 * whose name carries the leading colon (`":input"`). We normalise to the
 * bare key (`"input"`) — symmetric with how `dictKey` recovers the field name
 * from a keyword at runtime — and pair each with the FOLLOWING form. We only
 * need the value forms' source locations (to slice schema text) and whether a
 * `:handler` clause exists, so we walk the cdr chain pairing key→value.
 */
function foldClauses(
  tail: unknown,
  source: string,
): { inputSrc: string | null; outputSrc: string | null; hasHandler: boolean } {
  let inputSrc: string | null = null;
  let outputSrc: string | null = null;
  let hasHandler = false;

  let cur = tail;
  while (isPair(cur)) {
    const key = cur.car;
    const rest = cur.cdr;
    if (isSymbol(key) && isPair(rest)) {
      const raw = symName(key);
      const name = raw.startsWith(":") ? raw.slice(1) : raw;
      const valueForm = rest.car;
      if (name === "input" || name === "output") {
        const loc = locationOf(valueForm);
        // Schema values are always `(s/object …)` pairs → sliceable. An atom
        // (no location) leaves the slot null: a non-list schema is malformed
        // and surfaces at runtime, not here.
        const slice = loc ? sliceForm(source, loc.offset) : null;
        if (name === "input") inputSrc = slice;
        else outputSrc = slice;
      } else if (name === "handler") {
        hasHandler = true;
      }
      cur = rest.cdr; // advance past the value form
    } else {
      // Not a `:keyword value` pair (or a trailing odd token) — skip one and
      // keep scanning so a stray form doesn't strand the rest of the clauses.
      cur = rest;
    }
  }
  return { inputSrc, outputSrc, hasHandler };
}

/**
 * Statically enumerate `(declare/expose …)` forms. Pure parse — nothing is
 * evaluated, so the handler never runs. Mirrors `extractDefines`'s contract:
 * `[]` on parse failure, top-level only, declaration order preserved.
 */
export async function extractExpose(source: string): Promise<ExposeInfo[]> {
  let forms: unknown[];
  try {
    forms = (await parseGenerator(source)) as unknown[];
  } catch {
    return [];
  }

  const out: ExposeInfo[] = [];
  for (const form of forms) {
    if (!isPair(form)) continue;
    if (!isSymbol(form.car) || symName(form.car) !== EXPOSE_FORM) continue;

    const cdr1 = form.cdr;
    if (!isPair(cdr1)) continue;
    const nameForm = cdr1.car;
    if (!isString(nameForm)) continue; // name must be a string literal

    const { inputSrc, outputSrc, hasHandler } = foldClauses(cdr1.cdr, source);
    out.push({
      name: nameForm.__string__,
      inputSrc,
      outputSrc,
      hasHandler,
      location: locationOf(form),
    });
  }
  return out;
}
