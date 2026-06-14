// arrivalSuperDefineCapability — the superpowered-define family, as an EnvCapability.
//
// Same impl as `arrivalSuperDefinePack`: `declare/expose` + `define/overridable` + the approval
// verbs — ONE conceptual capability (the public-surface declaration family). It delegates to three
// `defineXRosetta(env, …)` helpers, so it uses the `wire` escape hatch.
//
// The host sinks/channels (onExpose, onOverridable, resolveOverride, onApprovalRequest,
// resolveApproval) are CONFIG. All optional — each helper falls back to its "capability optional,
// verb always present" posture when its sink is absent. `buildDict` is a module-level fold, not a
// per-env knob, so it stays an import (as in the original pack).

import { captureSymbols, EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { defineApprovalRosetta, type OnApprovalRequest, type ResolveApproval } from "../approval.js";
import { defineExposeRosetta, type OnExpose } from "../expose.js";
import { type ArrivalEnv, buildDict } from "../infer-kernel.js";
import { defineOverridableRosetta, type OnOverridable, type ResolveOverride } from "../overridable.js";

type SuperDefineActivation = Activation<
  {
    onExpose: z.ZodOptional<z.ZodType<OnExpose>>;
    onOverridable: z.ZodOptional<z.ZodType<OnOverridable>>;
    resolveOverride: z.ZodOptional<z.ZodType<ResolveOverride>>;
    onApprovalRequest: z.ZodOptional<z.ZodType<OnApprovalRequest>>;
    resolveApproval: z.ZodOptional<z.ZodType<ResolveApproval>>;
  },
  Record<string, never>
>;

export const arrivalSuperDefineCapability = new EnvCapability("arrival/superdefine", {
  configuration: {
    onExpose: z.custom<OnExpose>().optional(),
    onOverridable: z.custom<OnOverridable>().optional(),
    resolveOverride: z.custom<ResolveOverride>().optional(),
    onApprovalRequest: z.custom<OnApprovalRequest>().optional(),
    resolveApproval: z.custom<ResolveApproval>().optional(),
  },
  // helper-delegating → a symbols BUILDER: run the same three `defineXRosetta` helpers
  // against a recording host, capturing their verbs as a declarative symbol record (no
  // re-homing). `buildDict` is a module-level fold, not a per-env knob, so it stays an import.
  symbols: (a: SuperDefineActivation) =>
    captureSymbols((schemeEnv) => {
      const env = schemeEnv as never as ArrivalEnv;
      const { onExpose, onOverridable, resolveOverride, onApprovalRequest, resolveApproval } = a.configuration;
      defineExposeRosetta({ env, buildDict, onExpose });
      defineOverridableRosetta({ env, onOverridable, resolveOverride });
      defineApprovalRosetta({ env, onApprovalRequest, resolveApproval });
    }),
});
