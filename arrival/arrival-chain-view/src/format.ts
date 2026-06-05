/**
 * The "optimize + format" tail of the pipeline. The lowering pass emits naive,
 * verbose-but-correct JS; this pass idiomatizes it (eslint --fix) and lays it out
 * (prettier). Faithfulness lives in the naive pass; idiom + layout live here.
 *
 * Both run IN-PROCESS (no shelling out, no temp files) so the projection stays a
 * pure async function of its input — same source → same formatted output.
 */
import { ESLint } from "eslint";
import * as prettier from "prettier";

// A tiny fixable-only ruleset. These are the reductions the naive emitter leans
// on: `{ x: x }` → `{ x }`, redundant `{ return e }` arrow bodies → `e`. No
// type-aware rules (the read-view output is plain JS, no annotations), so this
// needs no tsconfig / project service — it runs on a bare espree parse.
const eslint = new ESLint({
  fix: true,
  overrideConfigFile: true,
  overrideConfig: {
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "object-shorthand": ["error", "always"],
      "arrow-body-style": ["error", "as-needed"],
      "prefer-const": "error",
      "no-useless-rename": "error",
    },
  },
});

/** eslint --fix then prettier. Pure: depends only on `code`. */
export async function formatJs(code: string): Promise<string> {
  // `.mjs` so eslint treats it as an ES module without a config file.
  let fixed = code;
  try {
    const [result] = await eslint.lintText(code, { filePath: "projection.mjs" });
    fixed = result?.output ?? code;
    return await prettier.format(fixed, { parser: "babel", semi: true, singleQuote: false, printWidth: 100 });
  } catch (err) {
    // A format failure means the lowering emitted invalid JS — surface the offending
    // source, not an opaque parser stack trace.
    throw new Error(
      `arrival-chain-view: generated JS failed to format (likely an emit bug).\n` +
        `--- generated ---\n${fixed}\n--- cause ---\n${(err as Error).message}`,
    );
  }
}
