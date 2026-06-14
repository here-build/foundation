// @here.build/arrival-scheme-env-infer — the inference verbs (`infer`, `infer/chat`).
//
// The impl correctly lives in arrival-chain (its `infer-kernel` helpers are there —
// no extraction needed). This palette package re-exports the capability:
//   • `arrivalInferCapability` — the EnvCapability surface: the InferFn is zod-validated
//     config, the verbs are rosetta-spec methods reading `this.configuration.infer`
//     (default-export style; `.lower({ config })`).

export { arrivalInferCapability } from "@here.build/arrival-chain";
export type { ArrivalEnv, BuildArrivalEnvOpts } from "@here.build/arrival-chain";
