// arrivalReflectCapability — the provenance reflection of the discovery plane as an EnvCapability.
//
// Same verbs as `arrivalReflectPack`: why / where / how / dag / result-value, each one ONE
// `buildSlice(handle.trace, handle.outputNode)` projected. No config, no deps — it consumes
// handles, never mints them.

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import { dagOf, howOf, whereOf, whyOf } from "../handle-provenance.js";
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

export const arrivalReflectCapability = new EnvCapability("arrival/reflect", {
  symbols: {
    // The lazy teleological re-run happens HERE (first ask), so the ASKING call's `ctx.signal` is the
    // right one to fan in — cancelling `(why h)` stops the provenance re-run, leaving the value intact.
    why: {
      withContext: true,
      fn: (ctx: { signal?: AbortSignal }, h: unknown) => whyOf(handle(h, "why"), ctx?.signal),
      type: "(h: ResultHandle): list",
    },
    where: {
      withContext: true,
      fn: (ctx: { signal?: AbortSignal }, h: unknown) => whereOf(handle(h, "where"), ctx?.signal),
      type: "(h: ResultHandle): list",
    },
    how: {
      withContext: true,
      fn: (ctx: { signal?: AbortSignal }, h: unknown) => howOf(handle(h, "how"), ctx?.signal),
      type: "(h: ResultHandle): SStr",
    },
    dag: {
      withContext: true,
      fn: (ctx: { signal?: AbortSignal }, h: unknown) => dagOf(handle(h, "dag"), ctx?.signal),
      type: "(h: ResultHandle): SStr",
    },
    "result-value": {
      fn: (h: unknown) => handle(h, "result-value").value,
      type: "(h: ResultHandle): unknown",
    },
  },
});
