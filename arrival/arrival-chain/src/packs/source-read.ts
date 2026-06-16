// arrivalSourceReadCapability — read a file's SOURCE as data (`require/string` → raw text,
// `require/ast` → homoiconic forms for analysis/edit-prep).
//
// Reading source executes NOTHING, so these carry no isolation concern and live on the read plane
// next to the provenance readers — separate from the run-launchers (arrival/run), whose isolation
// machinery they don't need. `Project` is opaque config (the host owns the substrate).

import { type Environment, parse } from "@here.build/arrival";
import { EnvCapability, type Activation } from "@here.build/arrival/capability";
import { z } from "zod";

import { makeProjectLoader } from "../loader.js";
import type { Project } from "../project.js";

async function readFileText(project: Project, file: string): Promise<string> {
  const loader = makeProjectLoader(project);
  const path = await loader.resolve(file, "");
  const contents = await loader.read(path);
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}

type SourceReadActivation = Activation<{ project: z.ZodType<Project> }, Record<string, never>>;

/** The env arrives only at call time via the eval context — an EnvCapability has no imperative
 *  wire to reach it at definition time, so `require/ast` reads `ctx.env` to parse against. */
type CtxWithEnv = { env: Environment };

export const arrivalSourceReadCapability = new EnvCapability("arrival/source-read", {
  configuration: { project: z.custom<Project>() },
  symbols: {
    // No `withContext`: reading text needs nothing from the eval context.
    "require/string": {
      type: "(file: SStr): SStr",
      async fn(this: SourceReadActivation, file: unknown) {
        return readFileText(this.configuration.project, String(file));
      },
    },
    "require/ast": {
      type: "(file: SStr): list",
      withContext: true,
      async fn(this: SourceReadActivation, ctx: unknown, file: unknown) {
        const text = await readFileText(this.configuration.project, String(file));
        // Pass the live env so read-time macros in the source expand against the SAME bindings the
        // file would run under; parsing with `undefined` would silently mis-expand any it contains.
        return parse(text, (ctx as CtxWithEnv).env);
      },
    },
  },
});
