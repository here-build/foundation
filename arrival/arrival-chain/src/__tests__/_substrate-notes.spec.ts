/**
 * Substrate behaviour notes — passing tests that document what works
 * and what to watch for in arrival-scheme's promise handling.
 *
 * arrival-scheme auto-resolves Promises through its `unpromise` /
 * `promise_all` machinery at consumption boundaries (function calls,
 * primitive ops like string-append, etc.). This means in MOST shapes,
 * you don't need explicit awaits — values that look like resolved
 * strings flow through scheme naturally even though the rosetta layer
 * returned a Promise to the evaluator.
 *
 * The seam: when the result of an async rosetta call is `let`-bound
 * and that binding is later read AS-A-VALUE (not consumed by an op
 * that forces), the binding can carry the un-forced Promise into the
 * next call's args. Concretely:
 *
 *   ;; works — string-append forces both inner infers at observation
 *   (string-append "x" (car (infer "m" "a")) (car (infer "m" "b")))
 *
 *   ;; works — outer map's iteration boundary forces
 *   (map (lambda (n) (car (infer "m" n))) (list "a" "b" "c"))
 *
 *   ;; works — inner let is consumed by string-append
 *   (let ((a (car (infer "m" "a"))))
 *     (car (infer "m" (string-append a "/b"))))
 *
 *   ;; works — single-arg lambda receives resolved value
 *   (define (f x) (car (infer "m" x)))
 *   (map f questions)
 *
 *   ;; the seam — let-bound value used as cache-key directly,
 *   ;; not threaded through a force-able op first
 *   (let ((a (car (infer "m" "a"))))
 *     (car (infer "m" "b" #f a)))   ;; `a` may reach upsertTask un-forced
 */
import { describe, expect, it, vi } from "vitest";

import { runPipeline } from "../runner.js";
import type { ModelSpec } from "../model.js";

const stub = () => {
  const complete = vi.fn(async (_s: ModelSpec) => "out");
  return { complete };
};

describe("substrate — promise propagation through common shapes", () => {
  it("works: inner infer's result feeds the next via string-append", async () => {
    const backend = stub();
    await runPipeline({
      files: {
        "main.scm": `
          (define a (car (infer "m" "first")))
          (car (infer "m" (string-append a "/second")))
        `,
      },
      entry: "main.scm",
      backends: backend,
    });
    // 2 distinct prompts ⇒ 2 distinct tasks
    expect(backend.complete).toHaveBeenCalledTimes(2);
    const prompts = backend.complete.mock.calls.map((c) => c[0].prompt);
    expect(prompts).toContain("first");
    expect(prompts).toContain("out/second");
  });

  it("works: map over a list of strings forces each per-iteration", async () => {
    const backend = stub();
    await runPipeline({
      files: {
        "list.json": JSON.stringify(["a", "b", "c"]),
        "main.scm": `
          (require "list.json")
          (map (lambda (n) (car (infer "m" n))) list)
        `,
      },
      entry: "main.scm",
      backends: backend,
    });
    expect(backend.complete).toHaveBeenCalledTimes(3);
  });

  it("works: outer map invokes a fn whose body does its own infer", async () => {
    const backend = stub();
    await runPipeline({
      files: {
        "list.json": JSON.stringify(["x", "y"]),
        "main.scm": `
          (require "list.json")
          (define (handle n) (car (infer "m" n)))
          (map handle list)
        `,
      },
      entry: "main.scm",
      backends: backend,
    });
    expect(backend.complete).toHaveBeenCalledTimes(2);
  });
});
