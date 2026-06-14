// capability — EnvCapability: the ONE shape every palette pack uses.
//
// `export default new EnvCapability(name, { configuration, resources, prelude, methods, deps })`
//   • a MODULE SINGLETON (one `new` per package) — no factories, no accidental dupes;
//   • INHERITANCE-FREE — the contribution surface is a CLOSED taxonomy (the 5 spec
//     keys), configured by composition, never subclassed;
//   • IN-DEPTH INFERRABLE — `methods` carries `ThisType<Activation<C,R>>`, so inside
//     any method `this.configuration.<k>` is `z.infer`'d and `this.resources.<k>` is
//     the typed `Ref`, with ZERO annotations. Methods are static (defined once on the
//     spec), bound to the per-env activation at wire time — no per-env closure churn.
//
// Lowers to a kernel `EnvPack`: apply = wire methods (membrane-wrapped) + eval prelude.
// Resources become ref-counted `ResourceCell`s on the activation (the `this.resources`).

import { z } from "zod";

import type { EnvPack } from "./kernel.js";
import { type Ref, type Resource, ResourceCell, spinUpAll, windDownAll } from "./resources.js";
import type { EvalSchemeInto, RosettaSpec, SchemeEnv } from "./scheme-env.js";

/** An `EnvPack` that also carries its resource lifecycle (wind-down = pause; resume
 *  = re-spawn). The kernel uses the EnvPack face; a lifecycle owner calls these. */
export type LoweredPack = EnvPack<SchemeEnv> & {
  /** Release every resource (reverse-DAG), keep wiring. Next touch/resume re-spawns. */
  windDown(): Promise<void>;
  /** Eagerly re-acquire every resource. */
  resume(signal?: AbortSignal): Promise<void>;
};

type ZodMap = Record<string, z.ZodType>;
type InferCfg<C extends ZodMap> = { [K in keyof C]: z.infer<C[K]> };
type HandleOf<T> = T extends Resource<infer H> ? H : never;
type RefsOf<R extends Record<string, Resource<unknown>>> = { readonly [K in keyof R]: Ref<HandleOf<R[K]>> };

/** The per-env binding context a method's `this` sees: validated config + live resource Refs. */
export interface Activation<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  readonly configuration: InferCfg<C>;
  readonly resources: RefsOf<R>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- symbol args are call-shape-checked at the boundary
type Fn = (...args: any[]) => unknown;

/** A symbol is a bare fn, a rosetta config (`withContext`/`type`/`options`), or a raw
 *  value binding (`{ value }`, e.g. a sentinel constant). Fn forms read `this`. */
export type SymbolDef = Fn | (Omit<RosettaSpec, "fn"> & { fn: Fn }) | { value: unknown };

const isValueDef = (m: SymbolDef): m is { value: unknown } => typeof m === "object" && m !== null && "value" in m;
const isSymbolSpec = (m: SymbolDef): m is Omit<RosettaSpec, "fn"> & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** A `symbols` record, or a BUILDER computing it from the activation (per-env config).
 *  The builder form is how helper-delegating packs (`defineXRosettas`) express symbols
 *  without re-homing their logic — see `captureSymbols`. */
export type SymbolsSpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> =
  | (Record<string, SymbolDef> & ThisType<Activation<C, R>>)
  | ((activation: Activation<C, R>) => Record<string, SymbolDef>);

/** Run an imperative `defineXRosettas(env, …)` helper against a recording host and
 *  return its wiring as a symbol record — so a helper-delegating pack becomes a
 *  declarative `symbols` builder, keeping the helper, no re-homing. `defineRosetta`
 *  → a rosetta symbol; `set` → a `{ value }` binding. */
export function captureSymbols(wire: (host: SchemeEnv) => void): Record<string, SymbolDef> {
  const out: Record<string, SymbolDef> = {};
  const host = {
    defineRosetta: (name: string, cfg: RosettaSpec) => void (out[name] = cfg as SymbolDef),
    set: (name: string, value: unknown) => void (out[name] = { value }),
    get: () => undefined,
    inherit() {
      return host as unknown as SchemeEnv;
    },
  } as unknown as SchemeEnv;
  wire(host);
  return out;
}

export interface CapabilitySpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  /** zod schemas for per-env config; values are supplied + validated at `lower()`. */
  configuration?: C;
  /** the ports this capability OWNS — static, or a provider that reads the parsed config.
   *  Spawned by the activation middleware on first symbol touch (see lower()). */
  resources?: { [K in keyof R]: R[K] | ((cfg: InferCfg<C>) => R[K]) };
  /** scheme bootstrap (`define-macro` + `define`s), eval'd into env on apply. */
  prelude?: string;
  /** DAG edges = capability grants. */
  deps?: readonly EnvCapability[];
  /** the verbs this capability exposes: a `Record<name, RosettaConfig>` whose `fn`
   *  reads `this` (`this.configuration.*` / `this.resources.*.live`), with `this`
   *  typed as `Activation<C,R>` (ThisType, inferred). For env access, use a rosetta
   *  spec with `withContext: true` — the env arrives via ctx, no imperative wiring.
   *  Helper-delegating packs use the BUILDER form (`(activation) => captureSymbols(…)`). */
  symbols?: SymbolsSpec<C, R>;
}

/** A configured, lowerable env capability. The default export of every palette pack. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance over the two type params; consumers are precise
export class EnvCapability<C extends ZodMap = any, R extends Record<string, Resource<unknown>> = any> {
  constructor(
    readonly name: string,
    readonly spec: CapabilitySpec<C, R>,
  ) {}

  /** Lower to a kernel `EnvPack`. `evalScheme` runs the prelude (required iff a prelude
   *  exists); `config` is validated against the `configuration` schemas. */
  lower(opts: { evalScheme?: EvalSchemeInto; config?: Partial<InferCfg<C>> } = {}): LoweredPack {
    const { spec, name } = this;

    const schema = spec.configuration ? z.object(spec.configuration as ZodMap) : z.object({});
    const configuration = schema.parse(opts.config ?? {}) as InferCfg<C>;

    // Resources → ref-counted cells. A provider entry reads the parsed config.
    const cells = {} as Record<string, ResourceCell<unknown>>;
    for (const [key, def] of Object.entries(spec.resources ?? {})) {
      const resource = (typeof def === "function" ? (def as (c: InferCfg<C>) => Resource<unknown>)(configuration) : def) as Resource<unknown>;
      cells[key] = new ResourceCell(resource);
    }
    const activation = { configuration, resources: cells } as unknown as Activation<C, R>;

    // First touch of ANY of this capability's symbols spawns ALL its resources
    // (single-flight), BEFORE the method body runs — so methods read `this.resources
    // .x.live` synchronously, never an `await .get()`. The capability dictates the
    // entity set; the env accessor (this wrapper) makes presence a precondition.
    const cellList = Object.values(cells);
    let spawned: Promise<void> | undefined;
    const ensureSpawned = (): Promise<void> => (spawned ??= Promise.all(cellList.map((c) => c.get())).then(() => undefined));

    return {
      name,
      ...(opts.config === undefined ? {} : { config: opts.config }),
      // Deps inherit the SAME raw `config` object (each validates its own slice via its schema; the
      // stored `config` field stays reference-equal across a capability's root + dep appearances, so
      // closure dedup matches by identity instead of tripping AssembleConfigConflictError).
      ...(spec.deps ? { deps: spec.deps.map((d) => d.lower({ evalScheme: opts.evalScheme, config: opts.config })) } : {}),
      // Lifecycle (pause/resume) over this capability's cells. Wiring is untouched.
      windDown: async () => {
        spawned = undefined;
        await windDownAll(cellList);
      },
      resume: async (signal?: AbortSignal) => {
        spawned = spinUpAll(cellList, signal);
        await spawned;
      },
      apply: async (env: SchemeEnv) => {
        const symbolsRec = typeof spec.symbols === "function" ? spec.symbols(activation) : (spec.symbols ?? {});
        for (const [verb, def] of Object.entries(symbolsRec)) {
          if (isValueDef(def)) {
            env.set(verb, def.value); // raw binding (e.g. a sentinel constant)
            continue;
          }
          const sym = isSymbolSpec(def) ? def : { fn: def };
          const bound = (sym.fn as Fn).bind(activation);
          // Activation middleware: first touch of ANY symbol spawns ALL resources
          // (single-flight) before the fn body runs → fns read `.live` synchronously.
          const gated =
            cellList.length === 0
              ? bound
              : async (...args: unknown[]) => {
                await ensureSpawned();
                return bound(...args);
              };
          env.defineRosetta(verb, { ...sym, fn: gated } as RosettaSpec);
        }
        if (spec.prelude !== undefined) {
          if (opts.evalScheme === undefined) throw new Error(`capability "${name}" has a prelude but no evalScheme was provided to lower()`);
          await opts.evalScheme(env, spec.prelude);
        }
      },
    };
  }
}
