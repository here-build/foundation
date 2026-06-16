// arrivalReflectCapability — the "ask a finished run why" half of the discovery plane.
//
// No config, no deps BY DESIGN: it only ever READS provenance off a ResultHandle some other verb
// (`require/eval`/`require/call`) already minted — it never launches a run itself. That clean split
// (run-launchers in arrival/run, readers here) is what lets the read plane be rooted without the
// project/infer config the launchers need.

import { EnvCapability } from "@here.build/arrival/capability";
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
  // why/where/how/dag all `withContext` for the same reason: the lazy teleological re-run happens on
  // first ask, so the ASKING call's `ctx.signal` is the right one to fan in — cancelling e.g. `(why h)`
  // stops the provenance re-run while leaving the already-materialized value intact. (`result-value`
  // reads the settled value, so it needs no signal.)
  symbols: {
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
