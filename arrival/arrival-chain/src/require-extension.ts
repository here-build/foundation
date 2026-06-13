// require-extension.ts — the `(require/extension :name)` scheme form (P4).
//
// A host arms a REGISTRY of named extension packs (the "predefined names"). A program reaches a
// capability by NAME — `(require/extension :sql)` — and the host decides what that name resolves to.
// This is the membrane-safe counterpart to `(require "path")`: `require` takes a STRING file path
// and loads program-named source; `require/extension` takes a KEYWORD from a fixed registry and
// applies a host-vetted capability pack. The keyword surface is deliberate — `:sql` reads as a name,
// never a path, so the "this is not file I/O" distinction is visible at the call site.
//
// Application is idempotent + single-flight via the live-env RuntimeAssembler (env-pack.ts): a second
// require of the same extension is a no-op; two concurrent requires share one apply. Unknown name →
// a teaching error listing the armed `:names` (errors-as-doors).

import type { sandboxedEnv } from "@here.build/arrival-scheme";
import invariant from "tiny-invariant";

import type { EnvPack, RuntimeAssembler } from "./env-pack.js";

type EnvHandle = ReturnType<typeof sandboxedEnv.inherit>;

/** The brand arrival-scheme tags keyword-accessor pluck functions with (see Environment.ts). A
 *  `:sql` arg evaluates to such a function carrying its bare field name. */
const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

/** Resolve a `(require/extension :name)` argument to the bare extension name. A keyword (`:sql`)
 *  evaluates to a branded pluck function → read its field; a bare string passes through (so
 *  `(require/extension "sql")` also works, though `:sql` is the intended, path-distinct surface). */
function extensionName(arg: unknown): string {
  if (typeof arg === "function") {
    const field = (arg as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(arg);
}

/**
 * Register `(require/extension :name)` against a host-armed pack registry. The form resolves the
 * name, applies the registered pack (and its deps) to the live env through `assembler`, and returns
 * unspecified — the capability's symbols are now live on the env. Absent name ⇒ teaching error.
 */
export function defineRequireExtensionRosetta(opts: {
  env: EnvHandle;
  registry: ReadonlyMap<string, EnvPack<EnvHandle>>;
  assembler: RuntimeAssembler<EnvHandle>;
}): void {
  const { env, registry, assembler } = opts;
  env.defineRosetta("require/extension", {
    fn: async (nameArg: unknown) => {
      const name = extensionName(nameArg);
      const pack = registry.get(name);
      invariant(
        pack,
        () =>
          `require/extension: no extension :${name}. Armed extensions: ${
            [...registry.keys()].map((k) => `:${k}`).join(", ") ||
            "(none — the host registered no extension packs for this env)"
          }`,
      );
      await assembler.require(pack);
      return undefined; // applied for effect; the pack's symbols are now bound on the env
    },
  });
}
