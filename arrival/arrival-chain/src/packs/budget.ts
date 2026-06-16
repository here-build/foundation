// arrivalBudgetCapability — a program reading what THIS run has spent so far (the ROI/TCO loop).
//
// `spend` is OPTIONAL config so the verbs are present-but-inert when the host doesn't feed a
// budget: `?? 0` means `(infer/spent)` answers honestly (nothing spent) instead of throwing in a
// non-metered run. Same "verb always there, capability optional" posture as data/mcp/infer — a
// program never branches on whether it's being metered.

import type { RunSpend } from "@here.build/arrival-inference";

import { EnvCapability, type Activation } from "@here.build/arrival/capability";
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
