import type { EnvCapability } from "@here.build/arrival-scheme/capability";
import { arrivalAgenticCapability } from "@here.build/arrival-scheme-env-infer";

import { arrivalBudgetCapability } from "./budget.js";
import { arrivalDataCapability } from "./data.js";
import { arrivalHandlebarsCapability } from "./ext-handlebars.js";
import { arrivalPromptCapability } from "./ext-prompt.js";
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
    // C3 root order is precedence order: a DEPENDENT must precede its deps. `ext/handlebars`
    // deps `utils` (its resolved lambda calls `template/handlebars`), so it lists before utils
    // — the same diamond shape as agentic→{infer,mcp}→derive, which C3 dedups + linearizes.
    arrivalHandlebarsCapability,
    arrivalUtilsCapability,
    arrivalBudgetCapability,
    arrivalDataCapability,
    // `ext/prompt` registers `.prompt` and seals it with the infer/mcp resource (shared config).
    // No capability deps (it reaches the schema DSL via the run env at call time), so order-free.
    arrivalPromptCapability,
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

// The capability vocabulary, re-exported for the chain barrel. The inference cluster
// (infer / mcp / agentic) lives in `@here.build/arrival-scheme-env-infer`; chain consumes it
// one-way (the dep edge runs chain → env-infer, never back) and surfaces it here so a consumer
// reaches the whole palette through one barrel.
export { arrivalAgenticCapability, arrivalInferCapability, arrivalMcpCapability } from "@here.build/arrival-scheme-env-infer";
export { arrivalBudgetCapability } from "./budget.js";
export { arrivalDataCapability } from "./data.js";
export { arrivalHandlebarsCapability } from "./ext-handlebars.js";
export { arrivalPromptCapability } from "./ext-prompt.js";
export { arrivalReflectCapability } from "./reflect.js";
export { arrivalRunCapability } from "./run.js";
export { arrivalSourceReadCapability } from "./source-read.js";
export { arrivalSuperDefineCapability } from "./superdefine.js";
export { arrivalUtilsCapability } from "./utils.js";

// loader-core is the one raw `EnvPack` (the imperative plumbing floor — `require` + when armed
// `require/extension`), NOT a capability. It stays raw BY NECESSITY, not omission: the `require`
// rosetta closes over per-env mutable state (the single-flight `inflight` cache, the cycle
// `loadingStack`, the `dirStack`) and returns a `clearCache()` to the host, and `require/extension`
// needs the live-env RuntimeAssembler — all of which want the concrete env at WIRE time, which the
// declarative capability surface (symbols + prelude, env-at-CALL-time via ctx) does not provide.
// `buildArrivalEnv` assembles it alongside the lowered capabilities, applied last (lowest precedence).
export { arrivalLoaderCorePack } from "./loader-core.js";
