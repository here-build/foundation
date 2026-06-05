/**
 * Orchestration (Node): scheme source → formatted JS (read-view). Pure async
 * function of its input (given a `requireSource` for `.scm` spill). The pipeline is
 * parse → plan imports → lower body → join → eslint --fix → prettier.
 *
 * The format-free core lives in `assemble.ts`; the browser entry (`browser.ts`)
 * reuses it with a prettier-standalone formatter (no eslint).
 */
import { assemble } from "./assemble.js";
import { formatJs } from "./format.js";
import { type ProjectOptions } from "./imports.js";

export type { ProjectOptions };

/** Project arrival-chain scheme → formatted JS (read-view). */
export async function projectToJs(source: string, opts: ProjectOptions = {}): Promise<string> {
  return formatJs(assemble(source, opts));
}

/** The unformatted projection — for inspecting the raw lowering before eslint/prettier. */
export function projectToJsRaw(source: string, opts: ProjectOptions = {}): string {
  return assemble(source, opts);
}
