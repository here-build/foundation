import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { inferKey, seededCache } from "./_seeded-cache.js";

const neverBackend = singletonRouter({
  complete: async () => {
    throw new Error("backend hit — expected a content-cache replay");
  },
});

/**
 * Schema is a nested tagged list of strings:
 *
 *   '("object"
 *      ("name"        "string")
 *      ("occupation"  "string")
 *      ("pains"       ("array" "string"))
 *      ("bucket"      ("enum" "A" "B" "C" "D")))
 *
 * Canonical form is JSON.stringify of the list — that's what lands in
 * the cache key's schema slot. String form (legacy marker) keeps working.
 */
describe("infer — schema as tagged-list DSL", () => {
  it("accepts a structured schema and canonicalises it to JSON in the cache key", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: { name: "Maya" } }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast"
        "Generate one persona"
        '("object" ("name" "string") ("occupation" "string")))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["name","string"],["occupation","string"]]',
    );
  });

  it("identical structured schemas dedupe to one task", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    const program = `
      (infer "fast" "p" '("object" ("name" "string")))
    `;
    await project.run(program);
    await project.run(program);

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("different structured schemas produce different tasks", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast" "p" '("object" ("name" "string")))
      (infer "fast" "p" '("object" ("age"  "integer")))
    `);

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("nested array-of-objects schema", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: [] }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast"
        "Generate personas"
        '("array" ("object" ("name" "string") ("bucket" ("enum" "A" "B")))))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].schema).toContain('"enum","A","B"');
  });

  it("string-form schema keeps working (backward-compat)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(neverBackend, seededCache({ [inferKey("fast", "p", "ProfileLegacy")]: "ok" })),
    );

    const value = await project.run(`(car (infer "fast" "p" "ProfileLegacy"))`);
    expect(value).toBe("ok");
  });
});

describe("schema DSL shortcuts — s/field/<type> and descriptions", () => {
  it("s/field/string yields the same shape as s/field name string", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast" "a" (s/object (s/field/string "name")))
      (infer "fast" "a" (s/object (s/field "name" "string")))
    `);

    // Same canonical form ⇒ one task.
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("primitive shortcut with description renders into JSON Schema", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast" "x"
        (s/object
          (s/field/string  "name"     "the persona's full name")
          (s/field/integer "age")
          (s/field/boolean "verified" "true if email-confirmed")))
    `);

    const slot = complete.mock.calls[0][0].schema!;
    expect(slot).toBe(JSON.stringify([
      "object",
      ["name", "string", "the persona's full name"],
      ["age", "integer"],
      ["verified", "boolean", "true if email-confirmed"],
    ]));
  });

  it("composite (s/field/array name config) — without description", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast" "x"
        (s/object
          (s/field/array "pains" (s/array "string"))))
    `);

    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["pains",["array","string"]]]',
    );
  });

  it("composite (s/field/enum name desc config) — with description", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = vi.fn(async (_s: ModelSpec) => ({ value: {} }));
    project.bindInfer(createInferStore(singletonRouter({ complete })));

    await project.run(`
      (infer "fast" "x"
        (s/object
          (s/field/enum "bucket" "audience classification" (s/enum "A" "B" "C"))))
    `);

    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["bucket",["enum","A","B","C"],"audience classification"]]',
    );
  });
});
