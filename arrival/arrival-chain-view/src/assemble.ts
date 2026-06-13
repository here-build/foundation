/**
 * The pure, format-free core of the projection: parse → plan imports → lower → join.
 * No eslint, no prettier — so it is browser-safe and can be wrapped by either the
 * Node formatter (`project.ts`) or the browser formatter (`browser.ts`).
 */
import { parseSexprs } from "@here.build/arrival-sweet";

import { computeAsyncNames, inferPrimitives } from "./async-analysis.js";
import { desugar } from "./desugar.js";
import { collectImports, type ProjectOptions } from "./imports.js";
import { makeLowerer } from "./lower.js";
import { resolveNames } from "./scheme-scope.js";

/** Parse → plan imports → lower body → join into one (unformatted) JS module string. */
export function assemble(source: string, opts: ProjectOptions = {}): string {
  const forest = desugar(parseSexprs(source));
  const { importLines, requireSubst, skipForms } = collectImports(forest, opts);
  const target = opts.target ?? "read";
  const inferReqs = target === "run" ? inferPrimitives(forest) : new Set<string>();
  const asyncNames = target === "run" ? computeAsyncNames(forest, inferReqs) : new Set<string>();
  // Scope-aware names: collision-free → every binding is its cleanName (output unchanged).
  const nameOf = resolveNames(forest, []);
  const lowerer = makeLowerer({ requireSubst, target, asyncNames, inferReqs, nameOf });
  const body = forest.filter((f) => !skipForms.has(f)).map((f) => lowerer.lowerTop(f));
  return [importLines.join("\n"), body.join("\n\n")].filter((s) => s.length > 0).join("\n\n");
}

export { type ProjectOptions } from "./imports.js";
