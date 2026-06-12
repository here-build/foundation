// Exposed-functions analysis — the host-side reader of `define/expose` / `expose`.
//
// This is the ANALYZER side of ADR-022. It is deliberately NOT readable from
// within Scheme: interface/provenance is external (the membrane rule). The
// evaluator binds `define/expose` exactly like `define` (see SPECIAL_FORMS in
// evaluator.ts); this module is the only place that reads the export
// annotation, by scanning already-parsed top-level forms.
//
// An ExportRecord is the unit of the "interface face" navigator world:
//   { token, name, span } — token is the project-global frozen primary key,
//   derived from the name at creation; name is the (renameable) lexical symbol;
//   span locates the define site in source for gutter projection / linting.

import { type SourceLocation } from "./errors.js";
import { SchemeSymbol } from "./LSymbol.js";
import { __location__ } from "./primitives.js";
import { type Pair } from "./Pair.js";
import { is_pair } from "./value-guards.js";

/** A single exposed symbol surfaced to the interface world. */
export interface ExportRecord {
  /**
   * Project-global frozen identity. Derived from `name` at creation time, then
   * frozen — rename of `name` must NOT change this. Cross-file collisions mint
   * a suffixed token (`pub/run-research-2`). The token is the sole external
   * referent; deployments bind to it.
   */
  token: string;
  /** Lexical name of the binding — internal, freely renameable. */
  name: string;
  /** Define-site location in source, for gutter projection and linting. */
  span?: SourceLocation;
}

/** Special-form heads this analysis recognizes. */
const DEFINE_EXPOSE = "define/expose";
const EXPOSE = "expose";

const TOKEN_PREFIX = "pub/";

/**
 * Derive an unfrozen token candidate from a lexical name. The freeze + collision
 * suffixing is applied by `scanExposed` across the whole form set; this is the
 * pure name→token shape (kebab the name under the `pub/` namespace).
 */
export function deriveToken(name: string): string {
  const kebab = name
    // camelCase / PascalCase → kebab
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return TOKEN_PREFIX + kebab;
}

function symbolName(v: unknown): string | undefined {
  return v instanceof SchemeSymbol ? String(v.__name__) : undefined;
}

/** Read a leading `#:id <token>` annotation pair from a form's body, if present. */
function readIdAnnotation(afterName: unknown): string | undefined {
  if (!is_pair(afterName)) return undefined;
  const kw = symbolName((afterName as Pair).car);
  // Keyword form `#:id`; parser surfaces it as a `#:id`-named symbol.
  if (kw === "#:id" || kw === ":id") {
    const rest = (afterName as Pair).cdr;
    if (is_pair(rest)) {
      const tok = symbolName((rest as Pair).car);
      if (tok) return tok;
    }
  }
  return undefined;
}

/**
 * Extract the (name, frozen-token-if-written, span) from one `define/expose`
 * form. Returns undefined if the form is not an exposing define.
 */
function readDefineExpose(form: Pair): { name: string; frozenToken?: string; span?: SourceLocation } | undefined {
  if (symbolName(form.car) !== DEFINE_EXPOSE) return undefined;
  const rest = form.cdr;
  if (!is_pair(rest)) return undefined;
  const first = (rest as Pair).car;
  // (define/expose (f x) body) — function shorthand: name is the head symbol.
  const name = is_pair(first) ? symbolName((first as Pair).car) : symbolName(first);
  if (!name) return undefined;
  const frozenToken = is_pair(first) ? undefined : readIdAnnotation((rest as Pair).cdr);
  return { name, frozenToken, span: form[__location__] };
}

/**
 * Extract from one `(expose :token value)` standalone form. The token is
 * mandatory here (there is no define-site to derive from). Reserved for v1.
 */
function readExpose(form: Pair): { token: string; span?: SourceLocation } | undefined {
  if (symbolName(form.car) !== EXPOSE) return undefined;
  const rest = form.cdr;
  if (!is_pair(rest)) return undefined;
  const tok = symbolName((rest as Pair).car);
  if (!tok) return undefined;
  // `:token` keyword → strip leading colon for the bare token string.
  const token = tok.replace(/^#?:/, "");
  return { token: TOKEN_PREFIX + token.replace(/^pub\//, ""), span: form[__location__] };
}

/**
 * Scan a set of top-level parsed forms and produce the export-record list for
 * the interface world. Pure: same input forms → same records. Tokens are
 * derived-then-frozen and collision-suffixed deterministically in source order.
 *
 * This is the artifact consumers (deploy registry, MCP, functions-view) read.
 * It never runs the program.
 */
export function scanExposed(forms: Iterable<unknown>): ExportRecord[] {
  const records: ExportRecord[] = [];
  const taken = new Set<string>();

  const mint = (candidate: string): string => {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
    let n = 2;
    while (taken.has(`${candidate}-${n}`)) n++;
    const minted = `${candidate}-${n}`;
    taken.add(minted);
    return minted;
  };

  for (const form of forms) {
    if (!is_pair(form)) continue;
    const de = readDefineExpose(form as Pair);
    if (de) {
      // A frozen token written in source wins verbatim; otherwise derive then
      // collision-suffix. Either way it is registered so later forms suffix off it.
      const token = de.frozenToken ? mint(de.frozenToken) : mint(deriveToken(de.name));
      records.push({ token, name: de.name, span: de.span });
      continue;
    }
    const ex = readExpose(form as Pair);
    if (ex) {
      records.push({ token: mint(ex.token), name: ex.token.replace(/^pub\//, ""), span: ex.span });
    }
  }

  return records;
}
