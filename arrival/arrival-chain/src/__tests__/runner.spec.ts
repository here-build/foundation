import { describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "../model.js";
import { runPipeline } from "../runner.js";

const stubBackend = (impl?: (s: ModelSpec) => unknown) => {
  const complete = vi.fn(async (s: ModelSpec) => (impl ? impl(s) : `echo:${s.prompt}`));
  return { complete };
};

describe("runPipeline — top-to-bottom entry point", () => {
  it("runs a program against in-memory files + env + a single backend", async () => {
    const result = await runPipeline({
      files: {
        "_lib.scm": `(define (greet who) (string-append "hi " who))`,
        "main.scm": `
          (require "_lib.scm")
          (greet (project/get "name"))
        `,
      },
      entry: "main.scm",
      env: { name: "world" },
      backends: stubBackend(),
    });

    expect(result).toBe("hi world");
  });

  it("threads through the multi-provider dispatch path when configured", async () => {
    const openai = stubBackend((s) => `openai/${s.model}::${s.prompt}`);
    const anthropic = stubBackend((s) => `anthropic/${s.model}::${s.prompt}`);

    const result = await runPipeline({
      files: {
        "main.scm": `
          (define a (car (infer "fast" "p1")))
          (car (infer "high" (string-append a "/p2")))
        `,
      },
      entry: "main.scm",
      models: {
        fast: "openai:gpt-4o-mini",
        high: "anthropic:claude-sonnet-4-6",
      },
      backends: { openai, anthropic },
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
          (require "personas.json")
          (map (lambda (p)
                 (car (infer "fast" (string-append "Greet " (field p "name")))))
               personas)
        `,
      },
      entry: "main.scm",
      backends: stubBackend((s) => s.prompt.replace("Greet ", "hi ")),
    });

    expect(result).toEqual(["hi Maya", "hi Priya"]);
  });
});
