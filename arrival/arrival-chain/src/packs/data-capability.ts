// arrivalDataCapability — the data-effect verbs (`http/*`, `sql/query`) as an EnvCapability.
//
// Same impl as `arrivalDataPack`, reshaped onto the capability surface. This pack is
// HELPER-DELEGATING: it defines its verbs via `defineDataEffectRosettas(env, …)` rather
// than an inline method map, so it uses the `wire` escape hatch. The `DataEffectResolver`
// is CONFIG (validated by zod, optional — INERT until the host arms `data`), and `wire`
// passes `this.configuration.data ?? inertDataResolver` to the same helper data.ts uses.

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
