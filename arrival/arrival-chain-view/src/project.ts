/**
 * Orchestration: scheme source → formatted JS (read-view). Pure async function of
 * its input (given a `requireSource` for `.scm` spill). The pipeline is
 * parse → plan imports → lower body → join → eslint --fix → prettier.
 */
import { parseSexprs } from "@here.build/arrival-chain/sweet";
import { formatJs } from "./format.js";
import { collectImports, type ProjectOptions } from "./imports.js";
import { makeLowerer } from "./lower.js";

export type { ProjectOptions };

function assemble(source: string, opts: ProjectOptions): string {
  const forest = parseSexprs(source);
  const { importLines, requireSubst, skipForms } = collectImports(forest, opts);
  const lowerer = makeLowerer({ requireSubst });
  const body = forest.filter((f) => !skipForms.has(f)).map((f) => lowerer.lowerTop(f));
  return [importLines.join("\n"), body.join("\n\n")].filter((s) => s.length > 0).join("\n\n");
}

/** Project arrival-chain scheme → formatted JS (read-view). */
export async function projectToJs(source: string, opts: ProjectOptions = {}): Promise<string> {
  return formatJs(assemble(source, opts));
}

/** The unformatted projection — for inspecting the raw lowering before eslint/prettier. */
export function projectToJsRaw(source: string, opts: ProjectOptions = {}): string {
  return assemble(source, opts);
}
