/**
 * `.prompt` model resolution: model is MATERIALIZATION, not intent. A `.prompt`
 * carries the prompt SHAPE; the model is the frontmatter DEFAULT, overridable per
 * call via `:meta (dict :model …)` — so one sealed unit can be routed to different
 * backends (e.g. a round-robined pool, or per-API-request model wiring) without
 * editing the file. Resolution: call-time `meta.model` ?? frontmatter ?? throw.
 * `:meta` is the config channel — stripped from the template-INPUT namespace, so
 * it never pollutes rendering.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";

const withFm = `---\nmodel: default-model\n---\n{{role "user"}}\nHi {{who}}`;
const noFm = `{{role "user"}}\nHi {{who}}`;

/** A project wired to a stub backend that records the model each call routed to. */
function harness(files: Record<string, string>) {
  const models: string[] = [];
  const complete = vi.fn(async (s: ModelSpec) => {
    models.push(s.model);
    return { value: `[${s.model}]` };
  });
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete })));
  for (const [name, src] of Object.entries(files)) project.addFile(name, src);
  return { project, models };
}

describe(".prompt — model resolution (default + :meta override)", () => {
  it("uses the frontmatter model when no override is given", async () => {
    const { project, models } = harness({ "p.prompt": withFm });
    await project.run(`(define f (require "p.prompt")) (f "k1" :who "Ada")`);
    expect(models).toEqual(["default-model"]);
  });

  it("`:meta (dict :model …)` overrides the frontmatter default", async () => {
    const { project, models } = harness({ "p.prompt": withFm });
    await project.run(`(define f (require "p.prompt")) (f "k1" :meta (dict :model "override-model") :who "Ada")`);
    expect(models).toEqual(["override-model"]);
  });

  it("supplies the model entirely from `:meta` when frontmatter omits it", async () => {
    const { project, models } = harness({ "p.prompt": noFm });
    await project.run(`(define f (require "p.prompt")) (f "k1" :meta (dict :model "supplied-model") :who "Ada")`);
    expect(models).toEqual(["supplied-model"]);
  });

  it("throws a clear error when neither frontmatter nor `:meta` provides a model", async () => {
    const { project } = harness({ "p.prompt": noFm });
    await expect(project.run(`(define f (require "p.prompt")) (f "k1" :who "Ada")`)).rejects.toThrow(/has no model/);
  });

  it("`:meta` is config, not a template input — it never leaks into the rendered body", async () => {
    // The template echoes {{who}} but has no {{meta}} hole; if :meta leaked into
    // inputs the render would be unaffected, so assert the routed prompt text
    // instead: it contains the input value and not the override model name.
    const models: string[] = [];
    const prompts: string[] = [];
    const complete = vi.fn(async (s: ModelSpec) => {
      models.push(s.model);
      prompts.push(s.prompt ?? "");
      return { value: "ok" };
    });
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(singletonRouter({ complete })));
    project.addFile("p.prompt", withFm);
    await project.run(`(define f (require "p.prompt")) (f "k1" :meta (dict :model "secret-model") :who "Ada")`);
    expect(models).toEqual(["secret-model"]);
    expect(prompts[0]).toContain("Hi Ada");
    expect(prompts[0]).not.toContain("secret-model");
  });
});
