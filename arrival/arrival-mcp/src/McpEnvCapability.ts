/**
 * The base `EnvCapability` is MCP-agnostic (verbs, config, resources, deps, prelude). A tool
 * transport needs two more things per verb to expose it to an actor: a `description` for the
 * catalog and an `inputSchema` to derive the input JSON-schema + validate calls.
 *
 * Those could ride on the generic rosetta config, but that would couple the marshalling layer to
 * MCP + zod — so they live HERE instead, on a thin subclass whose ONLY addition is `annotations`.
 * Everything else is inherited; annotations are inert to the runtime wiring, reflected off the
 * capability root-set by a transport to build its surface.
 */

import { type Activation, type CapabilitySpec, EnvCapability } from "@here.build/arrival-scheme/capability";
import type { Resource } from "@here.build/arrival-scheme/resources";
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
}

/** A `CapabilitySpec` plus per-symbol MCP annotations (keyed by symbol name). */
export interface McpCapabilitySpec<
  C extends Record<string, z.ZodType>,
  R extends Record<string, Resource<unknown>>,
> extends CapabilitySpec<C, R> {
  /** Keyed by symbol name. Drives the catalog + arg parsing; inert to plain `lower()`. An
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
  const wrapRecord = (rec: Record<string, any>): Record<string, any> =>
    Object.fromEntries(Object.entries(rec).map(([name, def]) => [name, wrapSymbol(def, annotations[name])]));

  return typeof symbols === "function" ? (activation: any) => wrapRecord(symbols(activation)) : wrapRecord(symbols);
}

/** An `EnvCapability` carrying MCP annotations. The only addition over the base is
 *  `annotations`; everything else (lowering, resources, deps, prelude) is inherited. */

export class McpEnvCapability<
  C extends Record<string, z.ZodType> = any,
  R extends Record<string, Resource<unknown>> = any,
> extends EnvCapability<C, R> {
  constructor(name: string, spec: McpCapabilitySpec<C, R>) {
    // Wrap each annotated symbol's fn with its `inputSchema` parse (post-membrane, pre-call),
    // so zod transforms run with resource access (the wrapped fn's `this` is the Activation,
    // bound by `lower()`). Symbols without an `inputSchema` annotation pass through untouched.
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
