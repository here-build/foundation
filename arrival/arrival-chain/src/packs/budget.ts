import type { EnvPack } from "@here.build/arrival-scheme/env";
import { type ArrivalEnv, type BuildArrivalEnvOpts } from "../infer-kernel.js";

/** Reflective inference-budget reads — armed by `opts.spend` (inert → 0 when absent). */
export function arrivalBudgetPack(opts: Pick<BuildArrivalEnvOpts, "spend">): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/infer-budget",
    apply: (env) => {
      env.defineRosetta("infer/spent", { fn: () => opts.spend?.spent() ?? 0, type: "(): SNum" });
      env.defineRosetta("infer/calls", { fn: () => opts.spend?.calls() ?? 0, type: "(): SNum" });
    },
  };
}
