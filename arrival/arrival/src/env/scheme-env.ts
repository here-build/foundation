// scheme-env — the SCHEME-AWARE layer over the pure C3 kernel (index.ts).
//
// The kernel is env-agnostic: a pack's `apply(env)` may do anything, but the kernel
// itself never touches `env` or knows what scheme is. This module adds the two
// things a scheme env-build needs on top of that seam, WITHOUT modifying the kernel:
//
//   1. the ENV TYPE CONTRACT (`SchemeEnv`) — the surface a pack contributes to,
//      defined here (not imported from arrival-scheme) so the dependency only ever
//      points arrival-scheme → arrival-scheme-env, never back (no cycle).
//   2. BOOTSTRAP-SEQUENCE support — a pack may carry scheme `bootstrap` source
//      (`define-macro` forms + `define`s) ALONGSIDE its JS `wire`, lowered to a
//      plain `EnvPack` whose apply evaluates the bootstrap then runs the wiring.
//      Because the kernel applies packs in C3 (dependency) order, a dependency's
//      macros/defs are present before a dependent's bootstrap runs — the
//      "bootstrap sequence" falls out of the DAG, not a hand-maintained order.
//
// The evaluator is INJECTED (`EvalSchemeInto`): arrival-scheme's `exec(src,{env})`
// satisfies it. This module never imports the interpreter, so it stays the lower,
// dependency-free layer the base sandbox can be re-expressed in terms of.

import type { EnvPack } from "./kernel.js";

/** A rosetta (host-fn) contribution, mirroring arrival-scheme's `defineRosetta`
 *  config structurally (kept here so we don't import the runtime). */
export interface RosettaSpec {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic host fn, matches RosettaFunction
  fn: (...args: any[]) => unknown;
  /** Optional ambient `.d.ts` member-body type fragment, harvested by the type-lens. */
  type?: string;
  /** Receive the EvalContext as a context argument (host-side). */
  withContext?: boolean;
  /** Rosetta options (e.g. `{ provenancePoint: true }`) — passed through verbatim. */
  options?: unknown;
}

/** A catchall resolver contribution, mirroring arrival-scheme's `FallbackResolver`
 *  structurally (kept here so we don't import the runtime). It fires when the env
 *  did NOT bind `name`, mapping a NAME to a value — the polyglot member accessors
 *  (`:key`) and the unbounded `c[ad]+r` family are exactly this. A resolver may
 *  return a membrane primitive (the `:key` pluck): it is NOT rosetta-wrapped — it
 *  IS part of the membrane, like `@`. */
export interface ResolverSpec {
  readonly id: string;
  resolve(name: string): unknown | undefined;
}

/** The minimal surface a scheme-env pack touches. arrival-scheme's `Environment`
 *  satisfies this structurally — packs type against THIS, not the concrete class. */
export interface SchemeEnv {
  set(name: string, value: unknown, docValue?: string | null): unknown;
  get(name: string, options?: { throwError?: boolean }): unknown;
  defineRosetta(name: string, config: RosettaSpec): void;
  inherit(name?: string, obj?: Record<string, unknown>): SchemeEnv;
  /** Register a catchall resolver (fires on a name the env did not bind). */
  registerResolver(resolver: ResolverSpec): void;
}

/** Evaluate scheme `source` into `env`. arrival-scheme's `exec(source, { env })`
 *  is the canonical implementation; injected so this package is evaluator-agnostic. */
export type EvalSchemeInto<E = SchemeEnv> = (env: E, source: string) => unknown | Promise<unknown>;

/** A scheme-aware capability: scheme `bootstrap` (macros + defs) and/or JS `wire`,
 *  composed as ONE pack. `deps`/`config`/`name` carry through to the kernel pack. */
export interface SchemePackSpec<E = SchemeEnv> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Pack identity arming (e.g. the injected vfs/loader). Two same-name packs with
   *  non-equal config in one assembly conflict — see the kernel's `configEqual`. */
  readonly config?: unknown;
  /** Scheme source: `(define-macro …)` forms + `(define …)`s, eval'd into env on apply. */
  readonly bootstrap?: string;
  /** JS wiring (native ops / `defineRosetta`), run AFTER bootstrap so it may
   *  reference symbols the bootstrap introduced. */
  readonly wire?: (env: E) => void | Promise<void>;
}

/**
 * Bind the injected evaluator once, get a `SchemePackSpec → EnvPack` lowering. The
 * produced packs are plain kernel `EnvPack`s (so they compose in the same DAG as
 * pure-JS packs); their `apply` evaluates `bootstrap` then runs `wire`. Async by
 * construction (eval is async) ⇒ assemble with `assembleEnv` (the kernel has no
 * synchronous assembler — there is no synchronous eval path anywhere in arrival).
 *
 *   const pack = schemePacks(exec)({ name: "scheme/srfi-1", bootstrap: SRFI1_SCM });
 *   await assembleEnv(env, [pack]);
 */
export function schemePacks<E = SchemeEnv>(evalScheme: EvalSchemeInto<E>): (spec: SchemePackSpec<E>) => EnvPack<E> {
  return (spec) => ({
    name: spec.name,
    deps: spec.deps,
    config: spec.config,
    apply: async (env) => {
      if (spec.bootstrap !== undefined) await evalScheme(env, spec.bootstrap);
      await spec.wire?.(env);
    },
  });
}
