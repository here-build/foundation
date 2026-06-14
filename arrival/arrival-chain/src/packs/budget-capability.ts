// arrivalBudgetCapability — reflective inference-budget reads as an EnvCapability.
//
// Same verbs as `arrivalBudgetPack`: infer/spent, infer/calls. The `RunSpend` (formerly
// `opts.spend`) is CONFIG (validated by zod, optional); the verbs read
// `this.configuration.spend?.…` and keep the inert `?? 0` default when absent.

import type { RunSpend } from "@here.build/arrival-inference";

import { EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

type BudgetActivation = Activation<{ spend: z.ZodType<RunSpend | undefined> }, Record<string, never>>;

export const arrivalBudgetCapability = new EnvCapability("arrival/budget", {
  configuration: { spend: z.custom<RunSpend>().optional() },
  symbols: {
    "infer/spent": {
      fn(this: BudgetActivation) {
        return this.configuration.spend?.spent() ?? 0;
      },
      type: "(): SNum",
    },
    "infer/calls": {
      fn(this: BudgetActivation) {
        return this.configuration.spend?.calls() ?? 0;
      },
      type: "(): SNum",
    },
  },
});
