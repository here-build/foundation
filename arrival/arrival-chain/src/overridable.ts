/**
 * The runtime half of `(define/overridable name default schema)` — a binding
 * whose value is host-overridable but otherwise falls back to a declared
 * default.
 *
 * The authoring front is a preamble macro (see `SUPERDEFINE_PREAMBLE`) that
 * expands to a plain `define` over this rosetta:
 *
 *   (define/overridable model-name "gpt-4o" (s/enum "gpt-4o" "claude"))
 *     ⇒ (define model-name
 *          (<overridable> (symbol->string 'model-name) "gpt-4o" (s/enum …)))
 *
 * So the interpreter core only ever sees `define` + an ordinary call — no
 * domain concept leaks into the pure dataflow core (the membrane rule). The
 * name binds and is usable in-program normally; the "superpower" is additive:
 * the rosetta ALSO registers an {@link OverridableDescriptor} with the host
 * (mirroring `onExpose`) and resolves the binding to an externally-supplied
 * override when one is present AND validates.
 *
 * Resolution (host-side):
 *   • lower `schema` (an `(s/…)` tagged list) to zod via `schemaToZod`;
 *   • check the DEFAULT satisfies the schema at registration — a failing
 *     default is an authoring error (thrown), not a silent fallback;
 *   • register `{ name, schemaTag, default }`;
 *   • RESOLVE to the override value IF the host supplies one for this name AND
 *     it validates against the schema; ELSE the default.
 *
 * The NAME is the identity (no frozen token — ADR-022/023, simplified): the
 * override knob's name is its caller-arg identity, which is what callers already
 * pass. Renaming a deployed knob is a breaking change, caught by the
 * dangling-binding linter, not hidden behind a derived token.
 *
 * The override CHANNEL is host-supplied. v1: a single `resolveOverride(name)`
 * callback (deployment env / caller args). A per-key override TABLE authored
 * in-program is explicitly OUT OF SCOPE / deferred.
 *
 * `schema` is REQUIRED. Keys/credentials are never in scope here.
 */
import type { Environment } from "@here.build/arrival-scheme";
import invariant from "tiny-invariant";

import { schemaToZod } from "./schema-to-zod.js";

/** The form head the preamble macro lowers to. */
export const OVERRIDABLE_FORM = "overridable/declare";

/**
 * A registered overridable, handed to the host the moment the form evaluates.
 * The host keys these by `token` (the frozen external identity) and may surface
 * them as the configuration surface of the enclosing exposed function(s).
 */
export interface OverridableDescriptor {
  /** The binding's name — its project-global identity and caller-arg key. */
  name: string;
  /** Canonical `(s/…)` tagged list — the same shape `schemaToZod`/`tagToJsonSchema` lower. */
  schemaTag: unknown;
  /** The declared default. Guaranteed to satisfy `schemaTag` (checked at registration). */
  default: unknown;
}

/** Host sink for registered overridables. Sync or async; return ignored. */
export type OnOverridable = (desc: OverridableDescriptor) => void | Promise<void>;

/**
 * Host override channel. Given an overridable's name, return the
 * externally-supplied override value, or `undefined` when the host has none
 * (⇒ use the default). v1 is per-name; a per-key in-program table is deferred.
 */
export type ResolveOverride = (name: string) => unknown | undefined;

/**
 * `onOverridable` and `resolveOverride` are both optional — omit them to make
 * the form a pure (registering-nowhere, default-only) binding factory, the same
 * "capability is optional, the verb always exists" posture as `declare/expose`.
 */
export function defineOverridableRosetta(opts: {
  env: Environment;
  onOverridable?: OnOverridable;
  resolveOverride?: ResolveOverride;
}): void {
  const { env, onOverridable, resolveOverride } = opts;

  env.defineRosetta(OVERRIDABLE_FORM, {
    fn: async (name: unknown, def: unknown, schemaTag: unknown) => {
      invariant(
        typeof name === "string",
        () => `${OVERRIDABLE_FORM}: name must be a string, got ${name === null ? "null" : typeof name}`,
      );
      invariant(
        schemaTag !== undefined && schemaTag !== null,
        () => `${OVERRIDABLE_FORM}: "${name}" requires a schema (an s/… form)`,
      );

      const zod = schemaToZod(schemaTag);

      // The default MUST satisfy the schema — a failing default is an authoring
      // error, surfaced here at registration rather than silently swallowed.
      const defParsed = zod.safeParse(def);
      invariant(
        defParsed.success,
        () =>
          `${OVERRIDABLE_FORM}: "${name}" default does not satisfy its schema: ${defParsed.success ? "" : defParsed.error.message}`,
      );

      if (onOverridable) {
        await onOverridable({ name, schemaTag, default: def });
      }

      // Resolve: a host override wins IFF it validates; otherwise the default.
      if (resolveOverride) {
        const override = resolveOverride(name);
        if (override !== undefined) {
          const ovParsed = zod.safeParse(override);
          if (ovParsed.success) return ovParsed.data;
          // An invalid override is rejected (falls back to default) — the host
          // override channel is untrusted input, unlike the in-program default.
        }
      }
      return def;
    },
  });
}
