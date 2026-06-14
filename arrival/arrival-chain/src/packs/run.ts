// packs/run.ts — the RUN channel of the discovery plane.
//
// `(require/eval "f")`            → run the whole program in an isolated plane → ResultHandle
// `(require/call "f" :fn (dict …))` → run the program, call one named fn with WIRE-SAFE args → ResultHandle
//
// These are the ONLY ways to make code run, and both name a visible file — there is no anonymous
// `(run "<source>")`. The launch goes through `runNamed`/`runNamedCall`, which assemble a sibling run
// env (reflection-free) and assert the wire-safe choke on the way out (and, for call, on the way in).

import { KEYWORD_ACCESSOR_FIELD } from "@here.build/arrival-scheme";

import type { EnvPack } from "@here.build/arrival-scheme/env";
import type { ArrivalEnv } from "../infer-kernel.js";
import type { Project } from "../project.js";
import { runNamed, runNamedCall } from "../run-isolated.js";

/** Coerce a `:fn` keyword accessor (which carries the bare name) or a string to the function name. */
function fnName(arg: unknown): string {
  const field = (arg as { [KEYWORD_ACCESSOR_FIELD]?: string } | null)?.[KEYWORD_ACCESSOR_FIELD];
  return field ?? String(arg).replace(/^:/, "");
}

/** The run-channel verbs. `config = project` for assembly dedup identity. */
export function arrivalRunPack(project: Project): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/run",
    config: project,
    apply: (env) => {
      // `withContext` consumes `ctx` host-side (scheme-facing arity unchanged) so the LAUNCHING call's
      // `ctx.signal` fans into the nested run — caller cancellation / parent-run abort stops it too.
      env.defineRosetta("require/eval", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, fileArg: unknown) =>
          runNamed(project, String(fileArg), "causal", ctx?.signal),
        type: "(file: SStr): ResultHandle",
      });
      env.defineRosetta("require/call", {
        withContext: true,
        fn: (ctx: { signal?: AbortSignal }, fileArg: unknown, fn: unknown, args: unknown) =>
          runNamedCall(project, String(fileArg), fnName(fn), args, "causal", ctx?.signal),
        type: "(file: SStr, fn: keyword, args: dict): ResultHandle",
      });
    },
  };
}
