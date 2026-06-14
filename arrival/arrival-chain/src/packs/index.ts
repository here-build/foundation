import type { EnvCapability } from "@here.build/arrival-scheme/capability";

import { arrivalAgenticCapability } from "./agentic.js";
import { arrivalBudgetCapability } from "./budget.js";
import { arrivalDataCapability } from "./data.js";
import { arrivalReflectCapability } from "./reflect.js";
import { arrivalRunCapability } from "./run.js";
import { arrivalSourceReadCapability } from "./source-read.js";
import { arrivalSuperDefineCapability } from "./superdefine.js";
import { arrivalUtilsCapability } from "./utils.js";

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
export { arrivalAgenticCapability } from "./agentic.js";
export { arrivalBudgetCapability } from "./budget.js";
export { arrivalDataCapability } from "./data.js";
export { arrivalInferCapability } from "./infer.js";
export { arrivalMcpCapability } from "./mcp.js";
export { arrivalReflectCapability } from "./reflect.js";
export { arrivalRunCapability } from "./run.js";
export { arrivalSourceReadCapability } from "./source-read.js";
export { arrivalSuperDefineCapability } from "./superdefine.js";
export { arrivalUtilsCapability } from "./utils.js";

// loader-core is the one raw `EnvPack` (the imperative plumbing floor — `import`/`require` +
// `require/extension`), NOT a capability. `buildArrivalEnv` assembles it alongside the lowered
// capabilities, applied last (lowest precedence).
export { arrivalLoaderCorePack } from "./loader-core.js";
