/**
 * Verifies access patterns over V's nested data shape now that
 * (require "x.json") produces SchemeJSObjects (json/parse path) and
 * the runtime preamble ships `field`, `values-of`, and `@` natively.
 *
 *   data:           { profileId: { id, versions: [ { n, state: {...} } ] } }
 *   values-of data: list of profile records
 *   (last (:versions rec)): latest version
 *   (:name state): the field
 *
 * `field` works on both alist and JS-object shapes; `@`/`:key` work on
 * objects only. Use whichever reads best at the call site.
 */
import { describe, expect, it, vi } from "vitest";
import { singletonRouter } from "@here.build/arrival-inference";

import type { ModelSpec } from "@here.build/arrival-inference";
import { runPipeline } from "../runner.js";

const NESTED = {
  p1: { id: "p1", versions: [{ n: 1, state: { name: "Maya",  oneLine: "ten" } }] },
  p2: { id: "p2", versions: [{ n: 1, state: { name: "Priya", oneLine: "twenty" } }] },
};

const noopBackend = () => ({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "ok" })) });

describe("nested-shape data access from scheme", () => {
  it("values-of: object-map → list of records", async () => {
    const result = await runPipeline({
      files: {
        "data.json": JSON.stringify(NESTED),
        "main.scm": `
          (define data (require "data.json"))
          (length (values-of data))
        `,
      },
      entry: "main.scm",
      router: singletonRouter(noopBackend()),
    });
    expect(result).toBe(2);
  });

  it("state-of pattern: walks record → versions → last → state", async () => {
    const result = await runPipeline({
      files: {
        "data.json": JSON.stringify(NESTED),
        "main.scm": `
          (define data (require "data.json"))
          (define (state-of r) (:state (last (:versions r))))
          (:name (state-of (car (values-of data))))
        `,
      },
      entry: "main.scm",
      router: singletonRouter(noopBackend()),
    });
    expect(result).toBe("Maya");
  });

  it("maps state-of across all records", async () => {
    const result = await runPipeline({
      files: {
        "data.json": JSON.stringify(NESTED),
        "main.scm": `
          (define data (require "data.json"))
          (define (state-of r) (:state (last (:versions r))))
          (map (lambda (r) (:name (state-of r))) (values-of data))
        `,
      },
      entry: "main.scm",
      router: singletonRouter(noopBackend()),
    });
    expect(result).toEqual(["Maya", "Priya"]);
  });

  it("(:keyword obj) also works on the records", async () => {
    const result = await runPipeline({
      files: {
        "data.json": JSON.stringify(NESTED),
        "main.scm": `
          (define data (require "data.json"))
          (:id (car (values-of data)))
        `,
      },
      entry: "main.scm",
      router: singletonRouter(noopBackend()),
    });
    expect(result).toBe("p1");
  });
});
