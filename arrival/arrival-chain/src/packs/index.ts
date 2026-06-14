import type { EnvCapability } from "@here.build/arrival-scheme/capability";

import { arrivalAgenticCapability } from "./agentic-capability.js";
import { arrivalBudgetCapability } from "./budget-capability.js";
import { arrivalDataCapability } from "./data-capability.js";
import { arrivalReflectCapability } from "./reflect-capability.js";
import { arrivalRunCapability } from "./run-capability.js";
import { arrivalSourceReadCapability } from "./source-read-capability.js";
import { arrivalSuperDefineCapability } from "./superdefine-capability.js";
import { arrivalUtilsCapability } from "./utils-capability.js";

// ─── The arrival capability vocabulary ────────────────────────────────────────
// Each capability is a module singleton (`new EnvCapability(name, spec)`). A registry function names
// the root-set for a plane; `buildArrivalEnv` lowers each with the shared `opts` object as `config`
// (every capability validates its OWN slice; the raw config object is reference-shared, so closure
// dedup matches by identity). Capability scoping = assemble a SUBSET (e.g. `[arrivalUtilsCapability]`
// for a pure-compute sandbox with no infer/effects).

/**
 * The default arrival capability root-set. `arrivalAgenticCapability` deps on — and, via the shared
 * config, configures — BOTH infer and mcp, so rooting it pulls them into the closure; they need not
 * be rooted separately. loader-core is NOT a capability (it is the imperative plumbing floor):
 * `buildArrivalEnv` appends it as a raw `EnvPack`, applied last (lowest precedence).
 */
export function arrivalCapabilities(): readonly EnvCapability[] {
  return [
    arrivalUtilsCapability,
    arrivalBudgetCapability,
    arrivalDataCapability,
    arrivalSuperDefineCapability,
    arrivalAgenticCapability,
  ];
}

/**
 * The DISCOVERY plane root-set — source reads (`require/ast`/`require/string`), run launchers
 * (`require/eval`/`require/call`) and provenance reflection (`why`/`where`/`how`/`result-value`).
 * Deliberately has NO infer, NO loader-core (so no anonymous `(require …)`/`(import …)`): the only
 * way to run is to NAME a file, and that launch goes through the isolated run plane. Lower each with
 * `{ project }` config onto a fresh `sandboxedEnv.inherit(...)` for the read tier.
 */
export function discoveryCapabilities(): readonly EnvCapability[] {
  return [arrivalSourceReadCapability, arrivalRunCapability, arrivalReflectCapability];
}

export { type ArrivalEnv } from "../infer-kernel.js";

// The capability vocabulary (re-exported for the barrel + the `arrival-scheme-env-*` plugin packages).
export { arrivalAgenticCapability } from "./agentic-capability.js";
export { arrivalBudgetCapability } from "./budget-capability.js";
export { arrivalDataCapability } from "./data-capability.js";
export { arrivalInferCapability } from "./infer-capability.js";
export { arrivalMcpCapability } from "./mcp-capability.js";
export { arrivalReflectCapability } from "./reflect-capability.js";
export { arrivalRunCapability } from "./run-capability.js";
export { arrivalSourceReadCapability } from "./source-read-capability.js";
export { arrivalSuperDefineCapability } from "./superdefine-capability.js";
export { arrivalUtilsCapability } from "./utils-capability.js";

// ── Transitional: the original EnvPack factories ──────────────────────────────
// Kept exported while the `arrival-scheme-env-*` plugin packages still import the `*Pack` form. The
// default registry no longer uses them; retire them (and rename `*-capability.ts` → `*.ts`) once the
// plugin packages migrate. `arrivalLoaderCorePack` is NOT transitional — it is the live raw pack
// `buildArrivalEnv` assembles alongside the lowered capabilities.
export { arrivalLoaderCorePack } from "./loader-core.js";
export { arrivalAgenticPack } from "./agentic.js";
export { arrivalBudgetPack } from "./budget.js";
export { arrivalDataPack } from "./data.js";
export { arrivalInferPack } from "./infer.js";
export { arrivalMcpPack } from "./mcp.js";
export { arrivalReflectPack } from "./reflect.js";
export { arrivalRunPack } from "./run.js";
export { arrivalSourceReadPack } from "./source-read.js";
export { arrivalSuperDefinePack } from "./superdefine.js";
export { arrivalUtilsPack } from "./utils.js";
