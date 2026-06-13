import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import { defineImport, makeProjectLoader } from "../loader.js";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";

const newProject = () => {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(singletonRouter({ complete: async () => ({ value: "" }) })));
  return project;
};

describe("import — host capability registry", () => {
  it("returns a registered bare value", async () => {
    const project = newProject();
    const value = await project.run(`(import "greeting")`, {
      imports: new Map([["greeting", "hello from host"]]),
    });
    expect(value).toBe("hello from host");
  });

  it("exposes a membrane namespace accessed via @", async () => {
    const project = newProject();
    const value = await project.run(`(@ (import "config") "answer")`, {
      imports: new Map([["config", defineImport({ answer: 42, name: "maya" })]]),
    });
    expect(value).toBe(42);
  });

  it("a namespace's callable export is invocable from scheme", async () => {
    const project = newProject();
    // The real backend shape: `(import "x")` → namespace; `(@ ns "fn")` → a proc.
    const value = await project.run(`((@ (import "mathlib") "double") 21)`, {
      imports: new Map([["mathlib", defineImport({ double: (n: number) => Number(n) * 2 })]]),
    });
    expect(value).toBe(42);
  });

  it("evaluate-once: the same import is eq? to itself", async () => {
    const project = newProject();
    const value = await project.run(`(eq? (import "config") (import "config"))`, {
      imports: new Map([["config", defineImport({ answer: 42 })]]),
    });
    expect(value).toBe(true);
  });

  it("per-run imports shadow the loader's defaults", async () => {
    const project = newProject();
    const loader = makeProjectLoader(project);
    loader.imports.set("flavour", "default");
    const value = await project.run(`(import "flavour")`, {
      loader,
      imports: new Map([["flavour", "per-run-override"]]),
    });
    expect(value).toBe("per-run-override");
  });

  it("an unregistered import errors, listing what IS registered", async () => {
    const project = newProject();
    await expect(
      project.run(`(import "nope")`, { imports: new Map([["yes", "ok"]]) }),
    ).rejects.toThrow(/unknown module "nope".*registered: yes/);
  });

  it("a granted namespace cannot be unwrapped to host internals (@ constructor blocked)", async () => {
    const project = newProject();
    // Composition with the accessor-isolation hardening: even though the host
    // handed the sandbox a real object, `@` routes through the membrane, so
    // "constructor" collapses to nil — identical to a missing key, never the
    // Function constructor. Asserted in-scheme (eq? both → nil) so the result
    // doesn't depend on how nil projects across the JS boundary.
    const value = await project.run(
      `(eq? (@ (import "config") "constructor") (@ (import "config") "no-such-key"))`,
      { imports: new Map([["config", defineImport({ answer: 42 })]]) },
    );
    expect(value).toBe(true);
  });
});
