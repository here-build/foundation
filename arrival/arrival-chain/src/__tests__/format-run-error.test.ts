import { SchemeError, type StackFrame } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { formatRunError } from "../run.js";

describe("formatRunError — studio run-error surface", () => {
  it("renders a SchemeError's scheme stack (file:line) and appends the require chain", () => {
    const frames: StackFrame[] = [{ code: "bad-form", location: { source: "util.scm", line: 3, col: 5, offset: 0 } }];
    const err = new SchemeError("Unbound variable `x'", frames);
    (err as { requireChain?: string[] }).requireChain = ["entry.scm", "util.scm"];

    const text = formatRunError(err);
    expect(text).toContain("util.scm:3:5"); // file:line from the threaded source
    expect(text).toContain("require chain: entry.scm → util.scm");
  });

  it("falls back to .message for a plain Error (no scheme stack, no chain)", () => {
    expect(formatRunError(new Error("plain boom"))).toBe("plain boom");
  });

  it("stringifies a non-Error throw", () => {
    expect(formatRunError("just a string")).toBe("just a string");
  });
});
