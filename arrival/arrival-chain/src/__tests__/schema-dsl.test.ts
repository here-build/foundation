import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";
import { startOrchestrator } from "../worker.js";
import { singletonRegistry, StaticRegistry } from "../registry.js";

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
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({ name: "Maya" }));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast"
        "Generate one persona"
        '("object" ("name" "string") ("occupation" "string")))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["name","string"],["occupation","string"]]',
    );
    ac.abort(); await draining;
  });

  it("identical structured schemas dedupe to one task", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    const program = `
      (infer "fast" "p" '("object" ("name" "string")))
    `;
    await project.run(program);
    await project.run(program);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(cache.tasks.size).toBe(1);
    ac.abort(); await draining;
  });

  it("different structured schemas produce different tasks", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast" "p" '("object" ("name" "string")))
      (infer "fast" "p" '("object" ("age"  "integer")))
    `);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(cache.tasks.size).toBe(2);
    ac.abort(); await draining;
  });

  it("nested array-of-objects schema", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => []);
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast"
        "Generate personas"
        '("array" ("object" ("name" "string") ("bucket" ("enum" "A" "B")))))
    `);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].schema).toContain('"enum","A","B"');
    ac.abort(); await draining;
  });

  it("string-form schema keeps working (backward-compat)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    cache.upsertTask("fast", "p", "ProfileLegacy", null).result = new InferenceResult({ valueJson: '"ok"' });

    const value = await project.run(`(car (infer "fast" "p" "ProfileLegacy"))`);
    expect(value).toBe("ok");
  });
});

describe("schema DSL shortcuts — s/field/<type> and descriptions", () => {
  it("s/field/string yields the same shape as s/field name string", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast" "a" (s/object (s/field/string "name")))
      (infer "fast" "a" (s/object (s/field "name" "string")))
    `);

    // Same canonical form ⇒ one task.
    expect(cache.tasks.size).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    ac.abort(); await draining;
  });

  it("primitive shortcut with description renders into JSON Schema", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

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
    ac.abort(); await draining;
  });

  it("composite (s/field/array name config) — without description", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast" "x"
        (s/object
          (s/field/array "pains" (s/array "string"))))
    `);

    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["pains",["array","string"]]]',
    );
    ac.abort(); await draining;
  });

  it("composite (s/field/enum name desc config) — with description", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const complete = vi.fn(async (_s: ModelSpec) => ({}));
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry({ complete }), signal: ac.signal }).done;

    await project.run(`
      (infer "fast" "x"
        (s/object
          (s/field/enum "bucket" "audience classification" (s/enum "A" "B" "C"))))
    `);

    expect(complete.mock.calls[0][0].schema).toBe(
      '["object",["bucket",["enum","A","B","C"],"audience classification"]]',
    );
    ac.abort(); await draining;
  });
});
