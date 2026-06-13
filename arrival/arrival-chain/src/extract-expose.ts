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

import type { SourceLocation } from "@here.build/arrival-provenance";

export type { SourceLocation } from "@here.build/arrival-provenance";

export interface ExposeInfo {
  /** The exposed function's name (the first arg, a string literal). */
  name: string;
  /** Source slice of the `:input` `(s/object …)` form, or null when absent.
   *  Pure schema text — evaluate (it has no side effects) to get the tagged
   *  list, then lower to JSON-schema / zod. */
  inputSrc: string | null;
  /** Source slice of the `:output` `(s/object …)` form, or null when absent. */
  outputSrc: string | null;
  /** Source slice of the `:meta` `(s/object …)` form (declared filterable
   *  observability dimensions), or null when absent. */
  metaSrc: string | null;
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

/** The superpowered-define authoring heads (preamble macros — see project.ts
 *  `SUPERDEFINE_PREAMBLE`). They survive into the parse tree verbatim because a
 *  static scan never expands macros, so this scanner reads them directly. */
export const EXPOSED_DEFINE_HEAD = "define/exposed";
export const OVERRIDABLE_DEFINE_HEAD = "define/overridable";

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
): { inputSrc: string | null; outputSrc: string | null; metaSrc: string | null; hasHandler: boolean } {
  let inputSrc: string | null = null;
  let outputSrc: string | null = null;
  let metaSrc: string | null = null;
  let hasHandler = false;

  let cur = tail;
  while (isPair(cur)) {
    const key = cur.car;
    const rest = cur.cdr;
    if (isSymbol(key) && isPair(rest)) {
      const raw = symName(key);
      const name = raw.startsWith(":") ? raw.slice(1) : raw;
      const valueForm = rest.car;
      if (name === "input" || name === "output" || name === "meta") {
        const loc = locationOf(valueForm);
        // Schema values are always `(s/object …)` pairs → sliceable. An atom
        // (no location) leaves the slot null: a non-list schema is malformed
        // and surfaces at runtime, not here.
        const slice = loc ? sliceForm(source, loc.offset) : null;
        if (name === "input") inputSrc = slice;
        else if (name === "output") outputSrc = slice;
        else metaSrc = slice;
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
  return { inputSrc, outputSrc, metaSrc, hasHandler };
}

/**
 * Statically enumerate the expose declarations in `source` — BOTH authoring
 * fronts:
 *   • `(declare/expose "name" :input … :output … :meta … :handler …)` — string
 *     name, `:handler` clause carries the body.
 *   • `(define/exposed name :input … :output … :meta … <body>)` — symbol name,
 *     the trailing form is the body (always present ⇒ `hasHandler` is true).
 *
 * Both carry the same `:input`/`:output`/`:meta` schema clauses now, so the
 * static view never diverges from the runtime one (both lower to the same
 * `declare/expose` rosetta + `ExposeDeclaration`). Pure parse — nothing is
 * evaluated, so the handler never runs. `[]` on parse failure, top-level only,
 * declaration order preserved.
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
    if (!isSymbol(form.car)) continue;
    const head = symName(form.car);
    const isDeclare = head === EXPOSE_FORM;
    const isDefine = head === EXPOSED_DEFINE_HEAD;
    if (!isDeclare && !isDefine) continue;

    const cdr1 = form.cdr;
    if (!isPair(cdr1)) continue;
    const nameForm = cdr1.car;

    // `declare/expose` names with a string literal; `define/exposed` with a
    // bare symbol. Skip anything that doesn't match its front's name shape.
    let name: string;
    if (isDeclare) {
      if (!isString(nameForm)) continue;
      name = nameForm.__string__;
    } else {
      if (!isSymbol(nameForm)) continue;
      name = symName(nameForm);
    }

    const { inputSrc, outputSrc, metaSrc, hasHandler } = foldClauses(cdr1.cdr, source);
    out.push({
      name,
      inputSrc,
      outputSrc,
      metaSrc,
      // `define/exposed`'s trailing body IS the handler — always present. The
      // `:handler` keyword only exists on the `declare/expose` front.
      hasHandler: isDefine ? true : hasHandler,
      location: locationOf(form),
    });
  }
  return out;
}

// ── reachable-overridable derivation (the derived argument surface) ─────────
//
// `define/exposed` carries NO `:input` schema in v1. Its INPUT CONTRACT is
// DERIVED: the set of `define/overridable`s that the exposed function
// TRANSITIVELY REFERENCES is its argument surface — each overridable
// contributes its {name, schema, default}.
//
// This is a pure-static reachability over the top-level reference graph:
//   nodes  = every top-level define / define/exposed / define/overridable name
//   edges  = "definition A's body mentions symbol B" (B a defined name)
//   sinks  = the overridable names
//   query  = for each exposed name, the overridables reachable from its body.
//
// "Mentions" = the bare symbol appears anywhere in the body sub-tree. This
// over-approximates (a shadowed local binding of the same name still counts) —
// acceptable for an argument-surface hint, and it never runs the handler.

/** A statically-derived overridable declaration (the parse-only view). */
export interface OverridableInfo {
  /** The binding name (first arg of `define/overridable`). */
  name: string;
  /** Source slice of the `(s/…)` schema form (third arg), or null if unsliceable. */
  schemaSrc: string | null;
  /** Source slice of the default value (second arg), or null if unsliceable. */
  defaultSrc: string | null;
  /** Source location of the `(define/overridable …)` form. */
  location?: SourceLocation;
}

/** An exposed function with its derived reachable-overridable argument surface. */
export interface ReachableExposed {
  /** The exposed binding name (first arg of `define/exposed`). */
  name: string;
  /** Source location of the `(define/exposed …)` form. */
  location?: SourceLocation;
  /** The overridables this function transitively references — its arg surface,
   *  in source order. */
  overridables: OverridableInfo[];
}

/**
 * Render a parsed atom back to its source-literal text. Strings re-quote (with
 * `"`/`\` escaping); symbols render as their name; numbers/booleans via their
 * scheme repr (`#t`/`#f`). Returns null for a shape we can't faithfully render —
 * the caller records the default as absent rather than emitting wrong text.
 */
function renderAtom(v: unknown): string | null {
  if (isString(v)) return `"${v.__string__.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (isSymbol(v)) return symName(v);
  if (typeof v === "boolean") return v ? "#t" : "#f";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  // arrival-scheme boxes a boolean literal as SchemeBool { value: boolean } — match it
  // BEFORE the numeric box below (whose `.value` is numeric), so the discriminant holds.
  if (v !== null && typeof v === "object" && typeof (v as { value?: unknown }).value === "boolean") {
    return (v as { value: boolean }).value ? "#t" : "#f";
  }
  // arrival-scheme numbers box as objects carrying `num`/`value`; fall through.
  if (v !== null && typeof v === "object") {
    const n = (v as { num?: unknown; value?: unknown }).num ?? (v as { value?: unknown }).value;
    if (typeof n === "bigint" || typeof n === "number") return String(n);
  }
  return null;
}

/** Recursively collect every bare symbol name appearing in a parsed sub-tree. */
function collectSymbols(node: unknown, into: Set<string>): void {
  if (isSymbol(node)) {
    into.add(symName(node));
    return;
  }
  if (isPair(node)) {
    collectSymbols(node.car, into);
    collectSymbols(node.cdr, into);
  }
}

/** The defined name of a top-level form, or undefined if it isn't a define-shape. */
function definedName(head: unknown, afterName: unknown): string | undefined {
  // (define (name args…) …) — function shorthand.
  if (isPair(head) && isSymbol(head.car)) return symName(head.car);
  // (define name …) / (define/exposed name …) / (define/overridable name …)
  if (isSymbol(head)) return symName(head);
  // string-named (declare/expose "name" …) is not a binding here.
  void afterName;
  return undefined;
}

/**
 * Parse one top-level `(define/overridable name <default> <schema>)` form into its static
 * {@link OverridableInfo}, or null if it isn't that shape. The shared per-hole parse behind
 * both the exposed-reachability pass and the flat {@link extractOverridables} lister: a
 * list-form default/schema is sliced from source by location; an atom renders to its
 * literal text — either way a re-parseable, re-evaluable slice.
 */
function overridableInfoOf(form: unknown, source: string): OverridableInfo | null {
  if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== OVERRIDABLE_DEFINE_HEAD) return null;
  const cdr1 = form.cdr;
  if (!isPair(cdr1)) return null;
  const name = definedName(cdr1.car, cdr1.cdr);
  if (name === undefined) return null;
  const rest = cdr1.cdr; // (default schema)
  const defForm = isPair(rest) ? rest.car : undefined;
  const schemaForm = isPair(rest) && isPair(rest.cdr) ? rest.cdr.car : undefined;
  const sliceOf = (f: unknown): string | null => {
    if (isPair(f)) {
      const loc = locationOf(f);
      return loc ? sliceForm(source, loc.offset) : null;
    }
    return renderAtom(f);
  };
  return {
    name,
    defaultSrc: defForm !== undefined ? sliceOf(defForm) : null,
    schemaSrc: schemaForm !== undefined ? sliceOf(schemaForm) : null,
    location: locationOf(form),
  };
}

/**
 * Every top-level `(define/overridable …)` in a source, in declaration order — the flat
 * knob surface (NOT exposed-function-scoped: a notebook cell commonly declares overridable
 * knobs with no `define/exposed`, so the reachability pass would report none). Pure static
 * parse; `[]` on parse failure. The N3 form lens renders exactly this list.
 */
export async function extractOverridables(source: string): Promise<OverridableInfo[]> {
  let forms: unknown[];
  try {
    forms = (await parseGenerator(source)) as unknown[];
  } catch {
    return [];
  }
  const out: OverridableInfo[] = [];
  for (const form of forms) {
    const info = overridableInfoOf(form, source);
    if (info) out.push(info);
  }
  return out;
}

/**
 * Every top-level `(require "path")` string argument in a source, in order — a cell's direct
 * config dependencies. The form lens follows these to reach overridable knobs declared in a
 * required file (`(require "config.scm")` → config.scm's knobs). Pure parse; `[]` on failure.
 * Top-level only; reads the path string, never executes the require.
 */
export async function extractRequires(source: string): Promise<string[]> {
  let forms: unknown[];
  try {
    forms = (await parseGenerator(source)) as unknown[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const form of forms) {
    if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== "require") continue;
    const arg = isPair(form.cdr) ? form.cdr.car : undefined;
    if (isString(arg)) {
      const s = (arg as { __string__?: string }).__string__;
      out.push(s ?? String(arg));
    }
  }
  return out;
}

/**
 * Derive, per `define/exposed`, the set of `define/overridable`s it transitively
 * references. Pure static parse — macros are NOT expanded (the heads survive
 * verbatim), and nothing is evaluated. `[]` on parse failure, declaration order
 * preserved both for the exposed list and each function's overridable surface.
 */
export async function extractReachableOverridables(source: string): Promise<ReachableExposed[]> {
  let forms: unknown[];
  try {
    forms = (await parseGenerator(source)) as unknown[];
  } catch {
    return [];
  }

  // Pass 1: index every top-level definition by its bound name, recording the
  // symbols its body references and whether it is an exposed / overridable node.
  interface DefNode {
    name: string;
    refs: Set<string>;
    kind: "plain" | "exposed" | "overridable";
    location?: SourceLocation;
  }
  const defs = new Map<string, DefNode>();
  const overridables = new Map<string, OverridableInfo>();
  const exposedOrder: { name: string; location?: SourceLocation }[] = [];

  for (const form of forms) {
    if (!isPair(form) || !isSymbol(form.car)) continue;
    const headSym = symName(form.car);
    const isPlainDefine = headSym === "define";
    const isExposed = headSym === EXPOSED_DEFINE_HEAD;
    const isOverridable = headSym === OVERRIDABLE_DEFINE_HEAD;
    if (!isPlainDefine && !isExposed && !isOverridable) continue;

    const cdr1 = form.cdr;
    if (!isPair(cdr1)) continue;
    const name = definedName(cdr1.car, cdr1.cdr);
    if (name === undefined) continue;
    const location = locationOf(form);

    // Body = everything after the name (for function shorthand, the head's cdr
    // holds the arg list, which is fine to include — a body never references a
    // define-name through its own parameter list in a way that matters here).
    const refs = new Set<string>();
    collectSymbols(cdr1.cdr, refs);
    if (isPair(cdr1.car)) collectSymbols(cdr1.car.cdr, refs); // function-shorthand body lives only in cdr1.cdr; arg list ignored

    const kind = isExposed ? "exposed" : isOverridable ? "overridable" : "plain";
    defs.set(name, { name, refs, kind, location });

    if (isOverridable) {
      const info = overridableInfoOf(form, source);
      if (info) overridables.set(name, info);
    }
    if (isExposed) exposedOrder.push({ name, location });
  }

  // Pass 2: for each exposed node, transitively close over its body references,
  // collecting reachable overridable names. BFS over the define-name graph.
  const result: ReachableExposed[] = [];
  for (const exposed of exposedOrder) {
    const seen = new Set<string>();
    const reachedOverridables: OverridableInfo[] = [];
    const start = defs.get(exposed.name);
    const queue: string[] = start ? [...start.refs] : [];
    while (queue.length > 0) {
      const sym = queue.shift()!;
      if (seen.has(sym)) continue;
      seen.add(sym);
      if (overridables.has(sym)) reachedOverridables.push(overridables.get(sym)!);
      const node = defs.get(sym);
      if (node) for (const r of node.refs) if (!seen.has(r)) queue.push(r);
    }
    result.push({ name: exposed.name, location: exposed.location, overridables: reachedOverridables });
  }
  return result;
}
