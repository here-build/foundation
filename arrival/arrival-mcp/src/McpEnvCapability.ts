// McpEnvCapability — an EnvCapability that also carries MCP tool annotations.
//
// The base `EnvCapability` (arrival-scheme/env) is MCP-agnostic: it knows verbs
// (symbols), config, resources, deps, prelude — the WHAT. The MCP transport (a
// DiscoveryToolInteraction) needs two more things per verb to expose it to an
// actor: a human-readable `description` for the tool catalog, and `args` schemas to
// derive the input JSON-schema + validate incoming calls — the HOW-it's-advertised.
//
// Rather than push those onto the generic rosetta config (which would couple the
// marshalling layer to MCP + zod), they live HERE, on a thin subclass: the ONLY
// addition over `EnvCapability` is `annotations`. Lowering, resources, deps, and
// prelude are all inherited unchanged — annotations are inert to the runtime wiring;
// a transport reflects them off the capability root-set to build its surface.

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import type { Activation, CapabilitySpec } from "@here.build/arrival-scheme/capability";
import type { Resource } from "@here.build/arrival-scheme/resources";
import * as z from "zod";

/** zod-schema map, mirroring `EnvCapability`'s configuration constraint. */
type ZodMap = Record<string, z.ZodType>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- activation generics erased at this boundary
type AnyActivation = Activation<any, any>;

/** A catalog description: plain text, or a `{ dynamic, value }` marker (live/personalized
 *  text that flags the schema as session-generated). */
export type McpDescription = string | { dynamic: true; value: string };

/** Per-verb MCP metadata: everything the tool transport needs to advertise + validate
 *  a symbol, and nothing the runtime wiring reads. */
export interface McpAnnotation {
  /** One-line catalog summary. A (possibly async) FUNCTION — closing over captured context
   *  — is resolved at schema-fetch time for live/personalized text; mark a live result
   *  `{ dynamic: true, value }` so the transport notes the schema is session-generated. */
  description: McpDescription | (() => McpDescription | Promise<McpDescription>);
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
}

/** A `CapabilitySpec` plus per-symbol MCP annotations (keyed by symbol name). */
export interface McpCapabilitySpec<C extends ZodMap, R extends Record<string, Resource<unknown>>>
  extends CapabilitySpec<C, R> {
  /** Keyed by symbol name. Drives the catalog + arg parsing; inert to plain `lower()`. The
   *  `ThisType` types each annotation's `inputSchema` getter `this` as the `Activation`, so
   *  it can read `this.resources` / `this.configuration`. */
  annotations?: Record<string, McpAnnotation & ThisType<Activation<C, R>>>;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural wrap over SymbolDef
function wrapSymbol(def: any, annotation: McpAnnotation | undefined): any {
  // getOwnPropertyDescriptor checks presence WITHOUT invoking a (resource-using) getter.
  if (!annotation || !Object.getOwnPropertyDescriptor(annotation, "inputSchema")) return def;
  const norm = typeof def === "function" ? { fn: def } : def;
  if (!norm || typeof norm.fn !== "function") return def;
  const orig = norm.fn;
  return {
    ...norm,
    fn: function (this: AnyActivation, ...raw: unknown[]) {
      return orig.apply(this, parseArgs(annotation, this, raw));
    },
  };
}

/** Wrap every symbol that has an `inputSchema` annotation with arg-parsing. Handles both the
 *  record and the builder (`(activation) => record`) `symbols` forms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SymbolsSpec is record | builder
function withArgParsing(symbols: any, annotations: Record<string, McpAnnotation>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapRecord = (rec: Record<string, any>): Record<string, any> =>
    Object.fromEntries(Object.entries(rec).map(([name, def]) => [name, wrapSymbol(def, annotations[name])]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof symbols === "function" ? (activation: any) => wrapRecord(symbols(activation)) : wrapRecord(symbols);
}

/** An `EnvCapability` carrying MCP annotations. The only addition over the base is
 *  `annotations`; everything else (lowering, resources, deps, prelude) is inherited. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance over the two type params; consumers are precise
export class McpEnvCapability<C extends ZodMap = any, R extends Record<string, Resource<unknown>> = any>
  extends EnvCapability<C, R> {
  constructor(name: string, spec: McpCapabilitySpec<C, R>) {
    // Wrap each annotated symbol's fn with its `args` parse (post-membrane, pre-call), so
    // zod transforms run with resource access (the wrapped fn's `this` is the Activation,
    // bound by `lower()`). Symbols without an `args` annotation pass through untouched.
    super(
      name,
      spec.symbols === undefined
        ? spec
        : {
            ...spec,
            symbols: withArgParsing(spec.symbols, spec.annotations ?? {}) as McpCapabilitySpec<C, R>["symbols"],
          },
    );
  }

  /** The MCP annotations for THIS capability's own verbs (not its deps). */
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
