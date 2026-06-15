import { createRuntimeAssembler, type EnvPack } from "@here.build/arrival-scheme/env";
import { type ArrivalEnv, type BuildArrivalEnvOpts } from "../infer-kernel.js";
import { defineRequireRosetta } from "../loader.js";
import { defineRequireExtensionRosetta } from "../require-extension.js";

/** The irreducible loader core — `require` + (when armed) `require/extension`. NOT a capability
 *  the way the others are; the env's plumbing floor. Applies LAST (lowest precedence), so anything
 *  an extracted pack registers shadows it (in practice their symbols are disjoint, so there is no
 *  clash). File-type sealing that needs a resource (e.g. `.prompt` → infer) is NOT here — it lives
 *  in the owning capability (packs/ext-prompt.ts), registered via the prelude. */
export function arrivalLoaderCorePack(opts: BuildArrivalEnvOpts): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/loader-core",
    apply: (env) => {
      const clearRequireCache = defineRequireRosetta({
        env,
        loader: opts.loader,
        tap: opts.tap,
        baseDir: opts.dirname ?? "",
      });
      opts.onRequireCache?.(clearRequireCache);
      // (P4) `(require/extension :name)` — host-armed pack registry, applied onto THIS live env via a
      // runtime assembler (idempotent + single-flight). Registered only when the host arms a registry;
      // absent ⇒ the verb is unbound. The assembler is handed to the lifecycle owner so its runtime
      // disposers fold into env teardown.
      if (opts.extensionRegistry) {
        const assembler = createRuntimeAssembler(env);
        defineRequireExtensionRosetta({ env, registry: opts.extensionRegistry, assembler });
        opts.onExtensionAssembler?.(assembler);
      }
    },
  };
}
