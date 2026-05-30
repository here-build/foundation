/**
 * Unit tests for the three hash utilities (step 1 of lineage impl).
 * No interpreter, no I/O — just pure functions over inputs.
 */
import { describe, expect, it } from "vitest";

import { filesHashOf, programHashOf } from "../lineage.js";

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

describe("filesHashOf", () => {
  it("returns the same hash regardless of insertion order", () => {
    const a = new Map<string, string>([
      ["a.scm", "(define config/a 1)"],
      ["b.json", "[1,2]"],
    ]);
    const b = new Map<string, string>([
      ["b.json", "[1,2]"],
      ["a.scm", "(define config/a 1)"],
    ]);
    expect(filesHashOf(a)).toBe(filesHashOf(b));
  });

  it("returns different hashes when a file's source differs", () => {
    const a = new Map<string, string>([["config.scm", "(define config/x 1)"]]);
    const b = new Map<string, string>([["config.scm", "(define config/x 2)"]]);
    expect(filesHashOf(a)).not.toBe(filesHashOf(b));
  });

  it("returns different hashes when paths differ", () => {
    const a = new Map<string, string>([["x.scm", "(define config/v 1)"]]);
    const b = new Map<string, string>([["y.scm", "(define config/v 1)"]]);
    expect(filesHashOf(a)).not.toBe(filesHashOf(b));
  });

  it("excludes the named path (the entry, already covered by programHash)", () => {
    const withEntry = new Map<string, string>([
      ["main.scm", "(+ 1 1)"],
      ["config.scm", "(define config/x 1)"],
    ]);
    const configOnly = new Map<string, string>([["config.scm", "(define config/x 1)"]]);
    // Excluding main.scm leaves only config.scm — same hash as the config-only map.
    expect(filesHashOf(withEntry, { exclude: "main.scm" })).toBe(filesHashOf(configOnly));
    // Without the exclude, the entry source contributes — hashes differ.
    expect(filesHashOf(withEntry)).not.toBe(filesHashOf(configOnly));
  });

  it("returns 8 hex chars", () => {
    const e = new Map<string, string>([["config.scm", "(define config/a 1)"]]);
    expect(filesHashOf(e)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles an empty file set", () => {
    expect(filesHashOf(new Map())).toMatch(/^[0-9a-f]{8}$/);
  });
});

// fnHashOf is exercised in lineage.spec.ts once the eval-side scaffolding
// is in place — it needs a real Pair with __location__ to test
// meaningfully. Defer to step 3 (DNF path reconstruction).
