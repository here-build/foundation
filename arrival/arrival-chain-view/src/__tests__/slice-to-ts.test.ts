import { describe, expect, it } from "vitest";
import { sliceToTypeScript } from "../slice-to-ts.js";

describe("sliceToTypeScript — human-grade render of a reverse-chain slice", () => {
  it("lowers a sliced reverse chain to formatted read-view source containing the reads", async () => {
    // A slice as buildSlice would emit it: the derivation forms a value depends on.
    const sliceProgram = `(define hit (car (infer "fast" "name the malware")))
hit`;
    const ts = await sliceToTypeScript(sliceProgram);
    // The render preserves the derivation: the read call and its binding survive lowering.
    expect(ts).toContain("hit");
    expect(ts).toMatch(/infer/i);
    // It is formatted source, not the raw s-expression.
    expect(ts).not.toContain("(define");
  });
});
