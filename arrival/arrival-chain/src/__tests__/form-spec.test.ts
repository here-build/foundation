/**
 * The N3 form spec — `extractFormSpec` projects a source's top-level
 * `define/overridable` knobs into typed form fields (pure static parse + schema/default
 * eval; no handler, no inference). The form lens renders exactly this list, and each
 * field value feeds `kernel.setOverride(name, value)` at run.
 */
import { describe, expect, it } from "vitest";

import { extractFormSpec } from "../compile-expose-sig.js";
import { extractOverridables } from "../extract-expose.js";

const SRC = `
(define/overridable tagline "Build faster" "string")
(define/overridable model "gpt-4o" (s/enum "gpt-4o" "claude-3"))
(define/overridable retries 3 "integer")
(define/overridable verbose #t "boolean")
(define plain (+ 1 2))
(define/exposed optimize (improve tagline model))
`;

describe("extractFormSpec", () => {
  it("projects each top-level define/overridable as a typed field, in declaration order", async () => {
    const spec = await extractFormSpec(SRC);
    expect(spec.map((h) => h.name)).toEqual(["tagline", "model", "retries", "verbose"]);
    expect(spec.map((h) => h.field)).toEqual([
      { kind: "string" },
      { kind: "enum", options: ["gpt-4o", "claude-3"] },
      { kind: "integer" },
      { kind: "boolean" },
    ]);
    // Defaults seed the controls. Number repr (number vs bigint) is normalised away.
    expect(spec[0]!.default).toBe("Build faster");
    expect(spec[1]!.default).toBe("gpt-4o");
    expect(Number(spec[2]!.default)).toBe(3);
    expect(spec[3]!.default).toBe(true);
  });

  it("ignores plain define and define/exposed — only overridable knobs are fields", async () => {
    const holes = await extractOverridables(SRC);
    expect(holes.map((h) => h.name)).toEqual(["tagline", "model", "retries", "verbose"]);
  });

  it("returns [] on parse failure rather than throwing", async () => {
    expect(await extractFormSpec("(define/overridable oops")).toEqual([]);
  });

  it("marks an object/array schema unsupported — no guessed control", async () => {
    const spec = await extractFormSpec(`(define/overridable cfg (list) (s/array "string"))`);
    expect(spec[0]!.field.kind).toBe("unsupported");
  });

  it("follows requires — a (require …) cell renders the required file's knobs", async () => {
    const CONFIG = `(define/overridable config/product "Acme" "string")\n(define/overridable config/model "gpt-4o" (s/enum "gpt-4o" "claude-3"))`;
    const cell = `(require "config.scm")\n(string-append config/product " via " config/model)`;
    const resolveRequire = async (p: string): Promise<string | null> => (p === "config.scm" ? CONFIG : null);
    const spec = await extractFormSpec(cell, { resolveRequire });
    expect(spec.map((h) => h.name)).toEqual(["config/product", "config/model"]);
    expect(spec[0]!.default).toBe("Acme");
    expect(spec[1]!.field).toEqual({ kind: "enum", options: ["gpt-4o", "claude-3"] });
  });

  it("without a resolver, a (require …) cell has no knobs (single-source)", async () => {
    expect(await extractFormSpec(`(require "config.scm")`)).toEqual([]);
  });
});
