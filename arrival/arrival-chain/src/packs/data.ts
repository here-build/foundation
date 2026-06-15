// arrivalDataCapability — the data-effect membrane (`http/*`, `sql/query`).
//
// Inert by construction: when the host doesn't arm `data`, the verbs fall back to
// `inertDataResolver`, which THROWS a teaching error at call time — so the OSS engine ships the
// verbs present but disarmed, never reaching a network or DB and never silently no-op'ing. The SaaS
// host injects the credentialed resolver via config.
//
// The verbs are wired by the existing `defineDataEffectRosettas(env, …)` helper, so the symbols use
// the BUILDER form (`captureSymbols`): run that helper against a recording env and capture what it
// sets — the helper stays the single source of the verbs, with zero re-homing into a method map.

import { captureSymbols, EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { type DataEffectResolver, defineDataEffectRosettas, inertDataResolver } from "../data-effects.js";

type DataActivation = Activation<{ data: z.ZodOptional<z.ZodType<DataEffectResolver>> }, Record<string, never>>;

export const arrivalDataCapability = new EnvCapability("arrival/data", {
  configuration: { data: z.custom<DataEffectResolver>().optional() },
  // helper-delegating → a symbols BUILDER: run the same helper data.ts uses against a
  // recording host, capturing its verbs as a declarative symbol record (no re-homing).
  symbols: (a: DataActivation) =>
    captureSymbols((env) => defineDataEffectRosettas(env as never, a.configuration.data ?? inertDataResolver)),
});
