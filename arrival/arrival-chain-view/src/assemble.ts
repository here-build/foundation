/**
 * The pure, format-free core of the projection: parse → plan imports → lower → join.
 * No eslint, no prettier — so it is browser-safe and can be wrapped by either the
 * Node formatter (`project.ts`) or the browser formatter (`browser.ts`).
 */
import { parseSexprs } from "@here.build/arrival-chain/sweet";
import { collectImports, type ProjectOptions } from "./imports.js";
import { makeLowerer } from "./lower.js";

export type { ProjectOptions };

/** Parse → plan imports → lower body → join into one (unformatted) JS module string. */
export function assemble(source: string, opts: ProjectOptions = {}): string {
  const forest = parseSexprs(source);
  const { importLines, requireSubst, skipForms } = collectImports(forest, opts);
  const lowerer = makeLowerer({ requireSubst });
  const body = forest.filter((f) => !skipForms.has(f)).map((f) => lowerer.lowerTop(f));
  return [importLines.join("\n"), body.join("\n\n")].filter((s) => s.length > 0).join("\n\n");
}
