// ext/prompt — the `.prompt` (dotprompt) file-type resolver as a resource-armed capability.
//
// A `.prompt` is a whole inference unit (frontmatter `model:` + Picoschema `output:` + a
// `{{role}}`-marked body). Unlike `.hbs` (which resolves to a pure render lambda), SEALING a
// `.prompt` needs the INFER resource — and, for an agentic `mcp:` prompt, MCP. So this is the
// first file-type resolver that is a real CAPABILITY, not a loader builtin: the resolver closes
// over `this.configuration.{infer,mcp}` and returns the sealed proc. An env that never rooted
// this capability has no `ext/prompt/resolve` binding, so `require`-ing a `.prompt` there is a
// clean unbound-name error (the registry's by-name late-bind), never a silent ⊥.
//
// The output schema is evaluated lazily against the live run env at the proc's first call — the
// resolver has no env handle, but the sealed proc's EvalContext does. That deferral (see
// sealPromptUnit) is precisely what lets prompt-sealing live as a capability rather than as
// loader-core plumbing: the env is reached at CALL time via ctx, not baked at wire time.

import { type Activation, EnvCapability } from "@here.build/arrival-scheme/capability";
import { z } from "zod";

import { type InferFn, parsePromptUnit, sealPromptUnit } from "../infer-kernel.js";
import { type ContentResolver } from "../loader.js";
import { type McpEffectResolver } from "../mcp-effects.js";

const RESOLVE = "ext/prompt/resolve";

type PromptActivation = Activation<
  { infer: z.ZodType<InferFn>; mcp: z.ZodOptional<z.ZodType<McpEffectResolver>> },
  Record<string, never>
>;

/** `.prompt` → `{ kind: "value", value: sealedProc }`. The proc is a native rosetta wrapper
 *  (a function), so `require`'s `jsToScheme` passes it through untouched; the call site binds
 *  it with `(define run-x (require "x.prompt"))` and runs it `(run-x key :k v …)`. */
export const arrivalPromptCapability = new EnvCapability("ext/prompt", {
  configuration: { infer: z.custom<InferFn>(), mcp: z.custom<McpEffectResolver>().optional() },
  // A symbols BUILDER closing over the infer (+ optional mcp) resource. The resolver is a raw
  // `ContentResolver` bound as `{ value }`: `require` calls it directly as a JS fn, not as a scheme
  // rosetta, so binding it through the rosetta marshaller would be wrong. mcp is optional because
  // `sealPromptUnit` falls back to an inert resolver when an agentic prompt has no mcp armed.
  symbols: (a: PromptActivation) => {
    const resolve: ContentResolver = (contents, { path }) => ({
      kind: "value",
      value: sealPromptUnit(parsePromptUnit(String(contents), path), {
        infer: a.configuration.infer,
        mcp: a.configuration.mcp,
      }),
    });
    return { [RESOLVE]: { value: resolve } };
  },
  prelude: `(require/register-extension ".prompt" "${RESOLVE}")`,
});
