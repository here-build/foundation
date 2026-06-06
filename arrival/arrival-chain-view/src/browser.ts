/**
 * Browser-safe projection entry — for the studio's `js` tab. Reuses the pure
 * `assemble` core and formats with **prettier standalone** (browser-bundleable),
 * NOT the Node `ESLint` class. The tradeoff vs the Node path: no eslint --fix, so
 * `{ x: x }` isn't collapsed to `{ x }` — but layout + wrapping (the legibility
 * that matters for a read-view) are fully applied.
 */
import * as prettier from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import { assemble } from "./assemble.js";
import { type ProjectOptions } from "./imports.js";

export type { ProjectOptions };
export { assemble as projectToJsRaw };
// Browser-safe siblings (no eslint/prettier/fs): the Python program emitter and the
// prompt backends, for the studio's python / *+lc target views.
export { projectToPy, type PyOptions } from "./python.js";
export { getPromptBackend, PROMPT_BACKENDS, type PromptBackend } from "./prompt.js";

/** Project arrival-chain scheme → formatted JS, entirely in the browser. */
export async function projectToJsBrowser(source: string, opts: ProjectOptions = {}): Promise<string> {
  const raw = assemble(source, opts);
  return prettier.format(raw, {
    parser: "babel",
    plugins: [babel, estree],
    semi: true,
    singleQuote: false,
    printWidth: 100,
  });
}
