/**
 * The base `EnvCapability` is MCP-agnostic (verbs, config, resources, deps, prelude). A tool
 * transport needs more per verb to expose it to an actor: a `description` for the catalog and
 * an `inputSchema` to derive the input JSON-schema + validate calls.
 *
 * Those could ride on the generic rosetta config, but that would couple the marshalling layer to
 * MCP + zod — so they live HERE instead, on a thin subclass. The MCP fields are written INLINE
 * on each symbol def (the name appears once, the runtime fn and its catalog text co-located); the
 * constructor LIFTS them off into a separate `annotations` record before handing clean rosetta
 * symbols to the base — `annotations` are inert to the runtime wiring, reflected off the
 * capability root-set by a transport to build its surface. A domain subclass widens the lifted
 * key-set (the third constructor arg) to carry extra catalog fields.
 */

import {
  type Activation,
  type CapabilitySpec,
  EnvCapability,
  type SymbolDef,
} from "@here.build/arrival/capability";
import type { Resource } from "@here.build/arrival/resources";
import * as z from "zod";

type AnyActivation = Activation<any, any>;

type MaybePromise<T> = T | Promise<T>;

/** Per-verb MCP metadata: everything the tool transport needs to advertise + validate
 *  a symbol, and nothing the runtime wiring reads. */
export interface McpAnnotation {
  /** Static one-line catalog summary. Always present; shown unless `dynamicDescription`
   *  resolves to a string. */
  description: string;
  /** Optional LIVE/personalized text, resolved (sync or async) at schema-fetch time —
   *  the per-session "welcome screen". Closes over context captured in `capability()`
   *  (it runs before any env/activation exists). A thunk so it fires ONLY for the catalog,
   *  never on tool execution. Resolves to a string ⇒ that text is shown AND the catalog is
   *  flagged session-generated; resolves to `undefined` ⇒ fall back to `description`,
   *  NOT flagged dynamic (so a failed live-fetch can return `undefined` honestly). */
  dynamicDescription?: () => MaybePromise<string | undefined>;
  /**
   * Positional input schemas, PARSED post-membrane (on the marshalled args) and pre-call —
   * so zod transforms run (validate + resolve) before the verb fn. Implement as a GETTER to
   * resolve args against the capability's LIVE resources; the getter's `this` is the
   * `Activation` (bound when the wrapped fn runs), so the transform closures reach it:
   *
   *   get inputSchema() { return [z.string().transform(v => this.resources.x.live.load(v))] }
   *
   * A static array (no resource access) works too. The declaration stays non-contextual; the
   * getter is evaluated per-call with the live activation.
   */
  inputSchema?: readonly z.ZodType[];
  /** Extra names this symbol is ALSO bound under (same fn + same `inputSchema` parsing). Aliases
   *  are runtime bindings only — they never enter the catalog (`allAnnotations` keys by the primary
   *  name), so they're undocumented shorthands an actor can call but the verb list won't advertise. */
  aliases?: readonly string[];
}

/** The annotation property names the BASE lifts off an inline symbol def. A subclass widens
 *  this (via the constructor's third arg) to lift extra, domain-specific catalog fields. */
export const MCP_ANNOTATION_KEYS: readonly string[] = ["description", "dynamicDescription", "inputSchema", "aliases"];

/** The object form of a `SymbolDef` (the rosetta-config member with an `fn`). */
type ObjectSymbolDef = Extract<SymbolDef, { fn: unknown }>;

/** A symbol def that MAY carry inline MCP annotation fields. The constructor lifts the
 *  annotation keys off into the `annotations` record, leaving a clean rosetta `SymbolDef`.
 *  Bare-fn and `{ value }` defs carry no inline fields. */
export type AnnotatedSymbolDef = SymbolDef | (ObjectSymbolDef & Partial<McpAnnotation>);

/** A `symbols` record (which may carry inline annotation fields), or a builder computing it. */
export type McpSymbolsSpec<C extends Record<string, z.ZodType>, R extends Record<string, Resource<unknown>>> =
  | (Record<string, AnnotatedSymbolDef> & ThisType<Activation<C, R>>)
  | ((activation: Activation<C, R>) => Record<string, AnnotatedSymbolDef>);

/** A `CapabilitySpec` whose `symbols` may carry inline MCP annotations, plus an optional
 *  explicit `annotations` record (the legacy form: annotation keyed by symbol name). When a
 *  symbol declares inline fields they win; otherwise the explicit entry is used verbatim. */
export interface McpCapabilitySpec<
  C extends Record<string, z.ZodType>,
  R extends Record<string, Resource<unknown>>,
> extends Omit<CapabilitySpec<C, R>, "symbols"> {
  symbols?: McpSymbolsSpec<C, R>;
  /** Keyed by symbol name. The legacy form — prefer inline fields on the symbol def. An
   *  `inputSchema` getter's `this` is the `Activation` at call time (bound via `Reflect.get`),
   *  but TS can't type accessor `this` — so getter bodies assert the activation shape. */
  annotations?: Record<string, McpAnnotation>;
}

/** Resolve a verb's `inputSchema` (invoking its getter with `this`=activation, so resources
 *  are reachable) and parse the marshalled args through it — validate + transform, pre-call. */
function parseArgs(annotation: McpAnnotation, activation: AnyActivation, raw: unknown[]): unknown[] {
  // Reflect.get invokes an `inputSchema` GETTER with `this`=activation (or returns a static
  // array). The getter's transform closures then close over the activation lexically.
  const schemas = Reflect.get(annotation, "inputSchema", activation) as readonly z.ZodType[] | undefined;
  if (!schemas || schemas.length === 0) return raw;
  return [...z.tuple(schemas as [z.ZodType, ...z.ZodType[]]).parse(raw)];
}

/** Wrap one symbol's fn with its `inputSchema` parse. `this` is the Activation (bound by
 *  `lower()`), so the getter + its transform closures reach resources. `{ value }` is untouched. */
function wrapSymbol(def: any, annotation: McpAnnotation | undefined): any {
  // getOwnPropertyDescriptor checks presence WITHOUT invoking a (resource-using) getter.
  if (!annotation || !Object.getOwnPropertyDescriptor(annotation, "inputSchema")) return def;
  const norm = typeof def === "function" ? { fn: def } : def;
  if (!norm || typeof norm.fn !== "function") return def;
  const orig = norm.fn;
  return {
    ...norm,
    fn(this: AnyActivation, ...raw: unknown[]) {
      return orig.apply(this, parseArgs(annotation, this, raw));
    },
  };
}

/** Wrap every symbol that has an `inputSchema` annotation with arg-parsing. Handles both the
 *  record and the builder (`(activation) => record`) `symbols` forms. */
function withArgParsing(symbols: any, annotations: Record<string, McpAnnotation>): any {
  const wrapRecord = (rec: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [name, def] of Object.entries(rec)) {
      const wrapped = wrapSymbol(def, annotations[name]);
      out[name] = wrapped;
      // Bind each alias to the SAME wrapped fn (identical arg-parsing). Catalog-invisible: only
      // `name` is an annotation key, so `allAnnotations` never lists the alias.
      for (const alias of annotations[name]?.aliases ?? []) out[alias] = wrapped;
    }
    return out;
  };

  return typeof symbols === "function" ? (activation: any) => wrapRecord(symbols(activation)) : wrapRecord(symbols);
}

/** Split inline annotation fields off each (object-form) symbol def into a separate annotations
 *  record, leaving a clean rosetta symbol. Property DESCRIPTORS are moved (never read), so an
 *  `inputSchema` getter survives un-invoked. A bare-fn / `{ value }` def carries no inline fields
 *  and passes through; a symbol that declares no inline fields falls back to the explicit
 *  `annotations[name]` (legacy form). Inline fields win over an explicit entry of the same name. */
function liftInlineAnnotations(
  symbols: Record<string, any>,
  explicit: Record<string, McpAnnotation>,
  annotationKeys: readonly string[],
): { symbols: Record<string, any>; annotations: Record<string, McpAnnotation> } {
  const keySet = new Set(annotationKeys);
  const cleanSymbols: Record<string, any> = {};
  const annotations: Record<string, McpAnnotation> = { ...explicit };
  for (const [name, def] of Object.entries(symbols)) {
    if (typeof def !== "object" || def === null) {
      cleanSymbols[name] = def; // bare fn — no inline fields to lift
      continue;
    }
    const clean: any = {};
    const ann: any = {};
    let hasInline = false;
    for (const key of Object.keys(def)) {
      const desc = Object.getOwnPropertyDescriptor(def, key)!;
      if (keySet.has(key)) {
        Object.defineProperty(ann, key, desc); // descriptor copy preserves an inputSchema getter
        hasInline = true;
      } else {
        Object.defineProperty(clean, key, desc);
      }
    }
    cleanSymbols[name] = clean;
    if (hasInline) annotations[name] = ann; // inline wins over an explicit entry
  }
  return { symbols: cleanSymbols, annotations };
}

/** An `EnvCapability` carrying MCP annotations. Annotation fields live inline on each symbol
 *  def; the constructor lifts them off (descriptor-preserving) and arms `inputSchema` parsing.
 *  Everything else (lowering, resources, deps, prelude) is inherited. */
export class McpEnvCapability<
  C extends Record<string, z.ZodType> = any,
  R extends Record<string, Resource<unknown>> = any,
> extends EnvCapability<C, R> {
  /**
   * @param annotationKeys which property names to lift off the inline symbol defs. Defaults to
   *   the base MCP fields; a domain subclass passes a WIDER set to also lift its catalog fields.
   *   Must be a constructor arg (not a virtual method) — `this` is unavailable before `super()`.
   */
  constructor(name: string, spec: McpCapabilitySpec<C, R>, annotationKeys: readonly string[] = MCP_ANNOTATION_KEYS) {
    const explicit = spec.annotations ?? {};
    // Only the record form can be inspected statically; a builder passes through (its annotations
    // come from the explicit record). Lift inline fields, then arm inputSchema parsing.
    const lifted =
      typeof spec.symbols === "function" || spec.symbols === undefined
        ? { symbols: spec.symbols, annotations: explicit }
        : liftInlineAnnotations(spec.symbols, explicit, annotationKeys);
    super(name, {
      ...spec,
      symbols: lifted.symbols === undefined ? undefined : withArgParsing(lifted.symbols, lifted.annotations),
      annotations: lifted.annotations,
    } as McpCapabilitySpec<C, R> as CapabilitySpec<C, R>);
  }

  /** The MCP annotations for THIS capability's own verbs (not its deps) — inline-lifted and
   *  explicit, merged at construction. */
  get annotations(): Record<string, McpAnnotation> {
    return (this.spec as McpCapabilitySpec<C, R>).annotations ?? {};
  }

  /**
   * The catalog of an AGGREGATING capability: this capability's annotations UNIONED
   * across its whole `deps` closure — so a discovery tool takes ONE capability whose
   * `deps` are the constituents, and the env-capability dependency DAG does the
   * aggregating (mirroring how `assembleEnv` closes over `deps` for the env itself).
   *
   * Walk order is deps-first, self-last, so a nearer capability's annotation wins a
   * name clash — matching `assembleEnv`'s last-write-wins C3 precedence (the root is
   * highest). Only `McpEnvCapability` nodes contribute; a plain `EnvCapability` dep
   * still grants live verbs, just undocumented-to-the-catalog (by design).
   */
  allAnnotations(): Record<string, McpAnnotation> {
    const out: Record<string, McpAnnotation> = {};
    const seen = new Set<EnvCapability>();
    const visit = (cap: EnvCapability): void => {
      if (seen.has(cap)) return;
      seen.add(cap);
      for (const dep of cap.spec.deps ?? []) visit(dep);
      if (cap instanceof McpEnvCapability) Object.assign(out, cap.annotations);
    };
    visit(this);
    return out;
  }
}
