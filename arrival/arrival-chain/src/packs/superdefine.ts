// arrivalSuperDefineCapability — the public-surface declaration family (`declare/expose`,
// `define/overridable`, the approval verbs) as ONE capability.
//
// Grouped together not by accident but because they answer the same question — "how does a program
// expose a hole to the outside world" — and a host that wants one almost always wants the set. Every
// host sink is optional config: absent a sink, each verb still evaluates and resolves to its
// in-program value (an exposed fn stays callable, an overridable resolves to its default), it just
// registers nowhere — so a program runs identically whether or not a host is listening.
//
// Three existing `defineXRosetta(env, …)` helpers wire the verbs, so the symbols use the BUILDER
// form (`captureSymbols`) to keep them as the single source. `buildDict` is a module-level fold, not
// a per-env knob, so it stays a plain import.

import { captureSymbols, EnvCapability, type Activation } from "@here.build/arrival/capability";
import { z } from "zod";

import { defineApprovalRosetta, type OnApprovalRequest, type ResolveApproval } from "../approval.js";
import { defineExposeRosetta, type OnExpose } from "../expose.js";
import { type ArrivalEnv, buildDict } from "../infer-kernel.js";
import { defineMcpRosetta, type OnMcp } from "../mcp-declare.js";
import { defineOverridableRosetta, type OnOverridable, type ResolveOverride } from "../overridable.js";

type SuperDefineActivation = Activation<
  {
    onExpose: z.ZodOptional<z.ZodType<OnExpose>>;
    onOverridable: z.ZodOptional<z.ZodType<OnOverridable>>;
    resolveOverride: z.ZodOptional<z.ZodType<ResolveOverride>>;
    onApprovalRequest: z.ZodOptional<z.ZodType<OnApprovalRequest>>;
    resolveApproval: z.ZodOptional<z.ZodType<ResolveApproval>>;
    onMcp: z.ZodOptional<z.ZodType<OnMcp>>;
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
    onMcp: z.custom<OnMcp>().optional(),
  },
  // helper-delegating → a symbols BUILDER: run the same three `defineXRosetta` helpers
  // against a recording host, capturing their verbs as a declarative symbol record (no
  // re-homing). `buildDict` is a module-level fold, not a per-env knob, so it stays an import.
  symbols: (a: SuperDefineActivation) =>
    captureSymbols((schemeEnv) => {
      const env = schemeEnv as never as ArrivalEnv;
      const { onExpose, onOverridable, resolveOverride, onApprovalRequest, resolveApproval, onMcp } = a.configuration;
      defineExposeRosetta({ env, buildDict, onExpose });
      defineOverridableRosetta({ env, onOverridable, resolveOverride });
      defineApprovalRosetta({ env, onApprovalRequest, resolveApproval });
      defineMcpRosetta({ env, buildDict, onMcp });
    }),
});
