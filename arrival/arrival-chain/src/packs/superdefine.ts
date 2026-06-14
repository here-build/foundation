import { defineApprovalRosetta } from "../approval.js";
import type { EnvPack } from "@here.build/arrival-scheme/env";
import { defineExposeRosetta } from "../expose.js";
import { type ArrivalEnv, buildDict, type BuildArrivalEnvOpts } from "../infer-kernel.js";
import { defineOverridableRosetta } from "../overridable.js";

/** The superpowered-define family — `declare/expose` + `define/overridable` + approval verbs. One
 *  conceptual capability (the public-surface declaration family), so one pack. */
export function arrivalSuperDefinePack(
  opts: Pick<
    BuildArrivalEnvOpts,
    "onExpose" | "onOverridable" | "resolveOverride" | "onApprovalRequest" | "resolveApproval"
  >,
): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/superdefine",
    apply: (env) => {
      defineExposeRosetta({ env, buildDict, onExpose: opts.onExpose });
      defineOverridableRosetta({ env, onOverridable: opts.onOverridable, resolveOverride: opts.resolveOverride });
      defineApprovalRosetta({ env, onApprovalRequest: opts.onApprovalRequest, resolveApproval: opts.resolveApproval });
    },
  };
}
