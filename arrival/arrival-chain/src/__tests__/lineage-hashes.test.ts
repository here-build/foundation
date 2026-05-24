/**
 * Unit tests for the three hash utilities (step 1 of lineage impl).
 * No interpreter, no I/O — just pure functions over inputs.
 */
import { describe, expect, it } from "vitest";

import { envHashOf, programHashOf } from "../lineage.js";

describe("programHashOf", () => {
  it("returns the same hash for identical source", () => {
    const a = "(define x 1)\n(+ x 2)";
    expect(programHashOf(a)).toBe(programHashOf(a));
  });

  it("returns different hashes for different source", () => {
    const a = "(define x 1)";
    const b = "(define x 2)";
    expect(programHashOf(a)).not.toBe(programHashOf(b));
  });

  it("is whitespace-sensitive (literal-text hash)", () => {
    expect(programHashOf("(+ 1 2)")).not.toBe(programHashOf("(+ 1  2)"));
  });

  it("returns 8 hex chars", () => {
    expect(programHashOf("anything")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles empty input", () => {
    expect(programHashOf("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles large inputs (50KB) without throwing", () => {
    const big = "x".repeat(50_000);
    expect(programHashOf(big)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("envHashOf", () => {
  it("returns the same hash regardless of insertion order", () => {
    const a = new Map<readonly string[], string | number | boolean>([
      [["a"], "1"],
      [["b"], 2],
    ]);
    const b = new Map<readonly string[], string | number | boolean>([
      [["b"], 2],
      [["a"], "1"],
    ]);
    expect(envHashOf(a)).toBe(envHashOf(b));
  });

  it("returns different hashes when values differ", () => {
    const a = new Map<readonly string[], string | number | boolean>([[["x"], 1]]);
    const b = new Map<readonly string[], string | number | boolean>([[["x"], 2]]);
    expect(envHashOf(a)).not.toBe(envHashOf(b));
  });

  it("returns different hashes when keys differ", () => {
    const a = new Map<readonly string[], string | number | boolean>([[["x"], 1]]);
    const b = new Map<readonly string[], string | number | boolean>([[["y"], 1]]);
    expect(envHashOf(a)).not.toBe(envHashOf(b));
  });

  it("distinguishes nested keys by their joined form", () => {
    const a = new Map<readonly string[], string | number | boolean>([[["a", "b"], 1]]);
    const b = new Map<readonly string[], string | number | boolean>([[["a"], 1]]);
    expect(envHashOf(a)).not.toBe(envHashOf(b));
  });

  it("distinguishes string from number values", () => {
    const a = new Map<readonly string[], string | number | boolean>([[["x"], "1"]]);
    const b = new Map<readonly string[], string | number | boolean>([[["x"], 1]]);
    expect(envHashOf(a)).not.toBe(envHashOf(b));
  });

  it("returns 8 hex chars", () => {
    const e = new Map<readonly string[], string | number | boolean>([[["a"], 1]]);
    expect(envHashOf(e)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles empty env", () => {
    expect(envHashOf(new Map())).toMatch(/^[0-9a-f]{8}$/);
  });
});

// fnHashOf is exercised in lineage.spec.ts once the eval-side scaffolding
// is in place — it needs a real Pair with __location__ to test
// meaningfully. Defer to step 3 (DNF path reconstruction).
