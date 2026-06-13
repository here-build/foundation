import type { EnvPack } from "../env-pack.js";
import { type ArrivalEnv, type BuildArrivalEnvOpts } from "../infer-kernel.js";
import { arrivalAgenticPack } from "./agentic.js";
import { arrivalBudgetPack } from "./budget.js";
import { arrivalDataPack } from "./data.js";
import { arrivalInferPack } from "./infer.js";
import { arrivalLoaderCorePack } from "./loader-core.js";
import { arrivalMcpPack } from "./mcp.js";
import { arrivalSuperDefinePack } from "./superdefine.js";
import { arrivalUtilsPack } from "./utils.js";

// ─── Atomic capability packs (P5) ────────────────────────────────────────────
// Each pack is a module-level factory over `opts`: a named, independently-composable contribution to
// an ArrivalEnv. `buildArrivalEnv` assembles the default root-set (`arrivalPacks`); a capability-scoped
// consumer assembles a SUBSET (e.g. just `[arrivalUtilsPack()]` for a pure-compute sandbox with no
// infer/effects). `config` carries host arming so divergent-config dedup is real.



/**
 * The default arrival capability root-set. Builds each atomic pack from `opts` and wires the one
 * dep edge (agentic → infer, mcp). Root order is C3-consistent: a dependent (agentic) precedes its
 * deps in the list, or C3 throws `AssembleLinearizationError`. A capability-scoped consumer can
 * instead hand-pick a subset of these factories and assemble that.
 */
export function arrivalPacks(opts: BuildArrivalEnvOpts): EnvPack<ArrivalEnv>[] {
  const infer = arrivalInferPack(opts);
  const mcp = arrivalMcpPack(opts);
  const agentic = arrivalAgenticPack(opts, [infer, mcp]);
  return [
    arrivalUtilsPack(),
    arrivalBudgetPack(opts),
    arrivalDataPack(opts),
    arrivalSuperDefinePack(opts),
    agentic,
    infer,
    mcp,
    arrivalLoaderCorePack(opts),
  ];
}

export { type ArrivalEnv } from "../infer-kernel.js";
export { arrivalAgenticPack } from "./agentic.js";
export { arrivalDataPack } from "./data.js";
export { arrivalBudgetPack } from "./budget.js";

export {arrivalInferPack} from "./infer.js";
export {arrivalMcpPack} from "./mcp.js";
export {arrivalLoaderCorePack} from "./loader-core.js";
export {arrivalUtilsPack} from "./utils.js";
export {arrivalSuperDefinePack} from "./superdefine.js";