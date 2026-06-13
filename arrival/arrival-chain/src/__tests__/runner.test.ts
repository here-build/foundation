import { describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "@here.build/arrival-inference";
import { singletonRouter, StaticRouter } from "@here.build/arrival-inference";
import { runPipeline } from "../runner.js";

const stubBackend = (impl?: (s: ModelSpec) => unknown) => {
  const complete = vi.fn(async (s: ModelSpec) => ({ value: impl ? impl(s) : `echo:${s.prompt}` }));
  return { complete };
};

describe("runPipeline — top-to-bottom entry point", () => {
  it("runs a program against in-memory files + config + a single backend", async () => {
    const result = await runPipeline({
      files: {
        "config.scm": `(define config/name "world")`,
        "_lib.scm": `(define (greet who) (string-append "hi " who))`,
        "main.scm": `
          (require "config.scm")
          (require "_lib.scm")
          (greet config/name)
        `,
      },
      entry: "main.scm",
      router: singletonRouter(stubBackend()),
    });

    expect(result).toBe("hi world");
  });

  it("threads through the multi-model dispatch path via the router", async () => {
    const openai = stubBackend((s) => `openai/${s.model}::${s.prompt}`);
    const anthropic = stubBackend((s) => `anthropic/${s.model}::${s.prompt}`);

    const result = await runPipeline({
      files: {
        "main.scm": `
          (define a (car (infer "gpt-4o-mini" "p1")))
          (car (infer "claude-sonnet-4-6" (string-append a "/p2")))
        `,
      },
      entry: "main.scm",
      // Router maps model-id directly to backend — no tier indirection.
      router: new StaticRouter({
        "gpt-4o-mini": openai,
        "claude-sonnet-4-6": anthropic,
      }),
    });

    expect(openai.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete).toHaveBeenCalledTimes(1);
    expect(String(result)).toBe("anthropic/claude-sonnet-4-6::openai/gpt-4o-mini::p1/p2");
  });

  it("a typical pipeline: load JSON, infer with schema, return a list", async () => {
    const result = await runPipeline({
      files: {
        "personas.json": JSON.stringify([{ name: "Maya" }, { name: "Priya" }]),
        "main.scm": `
          (define personas (require "personas.json"))
          (map (lambda (p)
                 (car (infer "fast" (string-append "Greet " (:name p)))))
               personas)
        `,
      },
      entry: "main.scm",
      router: singletonRouter(stubBackend((s) => s.prompt.replace("Greet ", "hi "))),
    });

    expect(result).toEqual(["hi Maya", "hi Priya"]);
  });
});
