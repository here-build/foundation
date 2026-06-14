// arrivalSourceReadCapability — the PURE source channel of the discovery plane, as an EnvCapability.
//
// Same impl as `arrivalSourceReadPack`, reshaped onto the capability surface: the `Project` is
// CONFIG (validated by zod as an opaque custom value), the verbs are METHODS reading
// `this.configuration.project`.
//
// `(require/ast "f")`  → the program's homoiconic forms (for analysis / edit-prep)
// `(require/string "f")` → the program's raw text
//
// Neither runs anything: they read SOURCE as data — no isolation concern.

import { type Environment, parse } from "@here.build/arrival-scheme";
import { EnvCapability, type Activation } from "@here.build/arrival-scheme/capability";
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

/** The eval context threaded to a `withContext` rosetta carries the live `env`. */
type CtxWithEnv = { env: Environment };

export const arrivalSourceReadCapability = new EnvCapability("arrival/source-read", {
  configuration: { project: z.custom<Project>() },
  // Inline `symbols` record. `require/ast` needs the live `env` to parse into; it reaches it via the
  // eval context (`withContext: true` → `ctx.env`), so no imperative `wire` is needed.
  symbols: {
    "require/string": {
      type: "(file: SStr): SStr",
      withContext: true,
      async fn(this: SourceReadActivation, _ctx: unknown, file: unknown) {
        return readFileText(this.configuration.project, String(file));
      },
    },
    "require/ast": {
      type: "(file: SStr): list",
      withContext: true,
      async fn(this: SourceReadActivation, ctx: unknown, file: unknown) {
        const text = await readFileText(this.configuration.project, String(file));
        // `ctx.env` is the concrete runtime `Environment` (the `sandboxedEnv.inherit(...)` base);
        // `parse` wants exactly that. Narrowed here at the one parse seam.
        return parse(text, (ctx as CtxWithEnv).env);
      },
    },
  },
});
