import { defineDataEffectRosettas, inertDataResolver } from "../data-effects.js";
import type { EnvPack } from "@here.build/arrival-scheme/env";
import { type ArrivalEnv, type BuildArrivalEnvOpts } from "../infer-kernel.js";

/** Data-effect verbs (`http/*`, `sql/query`) — INERT until the host arms `opts.data`. */
export function arrivalDataPack(opts: Pick<BuildArrivalEnvOpts, "data">): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/data-effects",
    config: opts.data,
    apply: (env) => {
      defineDataEffectRosettas(env, opts.data ?? inertDataResolver);
    },
  };
}
