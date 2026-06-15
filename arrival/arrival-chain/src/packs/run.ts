// arrivalRunCapability — the discovery plane's only way to RUN code: name a file, launch it in an
// isolated plane, get a ResultHandle back. There is deliberately no anonymous `(require …)` here
// (that's loader-core, off this plane) — the sole launch path goes through a named file + isolation,
// so a discovery session can't reach into the calling env. The `Project` is opaque config (the host
// owns the file substrate); the launch is by NAME, never by program-supplied source.

import { KEYWORD_ACCESSOR_FIELD } from "@here.build/arrival-scheme";
import { EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import type { Project } from "../project.js";
import { runNamed, runNamedCall } from "../run-isolated.js";

/** Coerce a `:fn` keyword accessor (which carries the bare name) or a string to the function name. */
function fnName(arg: unknown): string {
  const field = (arg as { [KEYWORD_ACCESSOR_FIELD]?: string } | null)?.[KEYWORD_ACCESSOR_FIELD];
  return field ?? String(arg).replace(/^:/, "");
}

type RunActivation = Activation<{ project: z.ZodType<Project> }, Record<string, never>>;

export const arrivalRunCapability = new EnvCapability("arrival/run", {
  configuration: { project: z.custom<Project>() },
  symbols: {
    // `withContext` consumes `ctx` host-side (scheme-facing arity unchanged) so the LAUNCHING call's
    // `ctx.signal` fans into the nested run — caller cancellation / parent-run abort stops it too.
    "require/eval": {
      withContext: true,
      type: "(file: SStr): ResultHandle",
      fn(this: RunActivation, ctx: { signal?: AbortSignal }, fileArg: unknown) {
        return runNamed(this.configuration.project, String(fileArg), "causal", ctx?.signal);
      },
    },
    "require/call": {
      withContext: true,
      type: "(file: SStr, fn: keyword, args: dict): ResultHandle",
      fn(this: RunActivation, ctx: { signal?: AbortSignal }, fileArg: unknown, fn: unknown, args: unknown) {
        return runNamedCall(this.configuration.project, String(fileArg), fnName(fn), args, "causal", ctx?.signal);
      },
    },
  },
});
