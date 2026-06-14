// packs/reflect.ts — the provenance reflection of the discovery plane: why / where / how.
//
// The trichotomy is the Buneman/Green–Tannen provenance classification, and all three are ONE
// `buildSlice(handle.trace, handle.outputNode)` projected three ways:
//   (why h)   → .points    — why-provenance / lineage (the evidence reads)
//   (where h) → .scopeIds   — where-provenance / source locations (`head@line:col`)
//   (how h)   → .program    — how-provenance / the runnable re-derivation slice
//
// These verbs live ONLY here, never in a run env — so a run can't call `(why)`, and the discovery
// plane can't be tricked into running one (a handle isn't wire-safe). `(result-value h)` reads the
// transparent value.

import type { EnvPack } from "../env-pack.js";
import { dagOf, howOf, whereOf, whyOf } from "../handle-provenance.js";
import type { ArrivalEnv } from "../infer-kernel.js";
import { is_result_handle, type ResultHandle } from "../result-handle.js";

function handle(v: unknown, verb: string): ResultHandle {
  if (!is_result_handle(v)) {
    throw new TypeError(
      `(${verb} …) expects a result handle from (require/eval …) / (require/call …), got ${typeof v}. ` +
        `Provenance is read off the handle a run hands back, not off a bare value.`,
    );
  }
  return v;
}

/** why / where / how / result-value over a ResultHandle. No deps — it consumes handles, never mints. */
export function arrivalReflectPack(): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/provenance",
    apply: (env) => {
      // The lazy teleological re-run happens HERE (first ask), so the ASKING call's `ctx.signal` is the
      // right one to fan in — cancelling `(why h)` stops the provenance re-run, leaving the value intact.
      env.defineRosetta("why", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, h: unknown) => whyOf(handle(h, "why"), ctx?.signal),
        type: "(h: ResultHandle): list",
      });
      env.defineRosetta("where", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, h: unknown) => whereOf(handle(h, "where"), ctx?.signal),
        type: "(h: ResultHandle): list",
      });
      env.defineRosetta("how", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, h: unknown) => howOf(handle(h, "how"), ctx?.signal),
        type: "(h: ResultHandle): SStr",
      });
      env.defineRosetta("dag", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, h: unknown) => dagOf(handle(h, "dag"), ctx?.signal),
        type: "(h: ResultHandle): SStr",
      });
      env.defineRosetta("result-value", {
        fn: (h: unknown) => handle(h, "result-value").value,
        type: "(h: ResultHandle): unknown",
      });
    },
  };
}
