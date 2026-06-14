// packs/source-read.ts — the PURE source channel of the discovery plane.
//
// `(require/ast "f")`  → the program's homoiconic forms (for analysis / edit-prep)
// `(require/string "f")` → the program's raw text
//
// Neither runs anything: they read SOURCE as data. So they carry no isolation concern — symbols in
// an AST here are inert data on the discovery plane, never crossing into a run.

import { parse } from "@here.build/arrival-scheme";

import type { EnvPack } from "../env-pack.js";
import type { ArrivalEnv } from "../infer-kernel.js";
import { makeProjectLoader } from "../loader.js";
import type { Project } from "../project.js";

async function readFileText(project: Project, file: string): Promise<string> {
  const loader = makeProjectLoader(project);
  const path = await loader.resolve(file, "");
  const contents = await loader.read(path);
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}

/** The pure source-read verbs. `config = project` for assembly dedup identity. */
export function arrivalSourceReadPack(project: Project): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/source-read",
    config: project,
    apply: (env) => {
      env.defineRosetta("require/string", {
        fn: (fileArg: unknown) => readFileText(project, String(fileArg)),
        type: "(file: SStr): SStr",
      });
      env.defineRosetta("require/ast", {
        fn: async (fileArg: unknown) => parse(await readFileText(project, String(fileArg)), env),
        type: "(file: SStr): list",
      });
    },
  };
}
