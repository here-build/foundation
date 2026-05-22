/**
 * Probes the arrival-scheme dict story. After the json/parse rosetta
 * landed in require, .json files containing objects come through the
 * membrane as SchemeJSObject — `@` is the accessor (no alist walking).
 */
import { describe, expect, it } from "vitest";

import { runPipeline } from "../runner.js";

const noop = { complete: async () => "" };

describe("arrival-scheme dict shapes", () => {
  it("(require x.json) where x is an object → SchemeJSObject, @ accesses fields", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify({ name: "Maya", age: 30 }),
        "main.scm": `(require "p.json") (@ p "name")`,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect(out).toBe("Maya");
  });

  it("(require x.json) where x is an array → scheme list, map/car/cdr work", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify(["a", "b", "c"]),
        "main.scm": `(require "p.json") (length p)`,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect(out).toBe(3);
  });

  it("(require x.json) where x is an object map → map cdr to get records", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify({
          k1: { name: "Maya" },
          k2: { name: "Priya" },
        }),
        "main.scm": `
          (require "p.json")
          (@ p "k1")
        `,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect((out as Record<string, unknown>).name).toBe("Maya");
  });

  it("nested objects pass through fromJS uniformly", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify({ inner: { deep: "value" } }),
        "main.scm": `(require "p.json") (@ (@ p "inner") "deep")`,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect(out).toBe("value");
  });

  it("(:keyword obj) also accesses fields — keyword-as-function form", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify({ name: "Maya", age: 30 }),
        "main.scm": `(require "p.json") (:name p)`,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect(out).toBe("Maya");
  });

  it("@keys returns the property names", async () => {
    const out = await runPipeline({
      files: {
        "p.json": JSON.stringify({ k1: 1, k2: 2 }),
        "main.scm": `(require "p.json") (vector->list (@keys p))`,
      },
      entry: "main.scm",
      backends: noop,
    });
    expect(out).toEqual(["k1", "k2"]);
  });
});
