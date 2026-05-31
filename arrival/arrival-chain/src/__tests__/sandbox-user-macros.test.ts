/**
 * `define-macro` (Lisp-style macros) works in the sandbox.
 *
 * arrival-chain runs scheme in sandboxedEnv, built fresh (parent=null) and
 * deliberately not inheriting user_env's bootstrap bindings. `define-macro` still
 * reaches it because it's an evaluator SPECIAL FORM (evaluator.ts) that binds the
 * new macro into the CURRENT env — so a user can author macros in a sandboxed
 * program, and the expansion still evaluates under the sandbox allowlist (it adds
 * no capability beyond ordinary code). Runaway expansion is bounded by the
 * budgetMs breaker (see execution-breaker.test.ts).
 *
 * NOTE: the hygienic syntax-rules family (define-syntax / let-syntax) does NOT
 * yet work under the sandbox env — the LIPS pattern matcher behaves differently
 * there than in the full env (where chibi's define-syntax passes through the same
 * dispatch). Tracked separately; this guards the define-macro path that works.
 */
import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "../registry.js";
import type { ModelSpec } from "../model.js";

const router = () => singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "x" })) });
const run = (scm: string) => runPipeline({ files: { "main.scm": scm }, entry: "main.scm", router: router() });

describe("user macros in the sandbox", () => {
  it("define-macro expands and evaluates", async () => {
    expect(await run("(define-macro (twice x) `(* 2 ,x)) (twice 21)")).toBe(42);
  });
});
