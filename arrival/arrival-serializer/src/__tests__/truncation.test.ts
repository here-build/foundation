import { describe, expect, it } from "vitest";

import { toSExprString } from "../serializer.js";

describe("streaming truncation (opt-in)", () => {
  it("no opts → uncapped, unchanged behaviour", () => {
    const out = toSExprString(Array.from({ length: 200 }, (_, i) => i));
    expect(out).not.toContain("more of");
    expect(out).toContain("199");
  });

  it("a bare indent number still means 'no caps'", () => {
    const out = toSExprString(Array.from({ length: 200 }, (_, i) => i), 2);
    expect(out).not.toContain("more of");
  });

  it("caps a long array to maxItems with a `+N more of TOTAL` marker", () => {
    const out = toSExprString(
      Array.from({ length: 1000 }, (_, i) => i),
      { maxItems: 10 },
    );
    expect(out).toContain("#| +990 more of 1000 |#");
    expect(out).toContain("9"); // first items shown
    expect(out).not.toContain("999"); // the tail is never serialized
  });

  it("caps a long string with an inline char-count marker", () => {
    const out = toSExprString("x".repeat(5000), { maxStringChars: 20 });
    expect(out).toContain("…(+4980 chars)");
    expect(out).not.toContain("x".repeat(100));
  });

  it("a single large string is shown fine — not squeezed by structure", () => {
    // one big string, generous per-string cap, total budget it fits under → no shrink
    const out = toSExprString("z".repeat(10000), { maxTotalChars: 5000, maxStringChars: 3000 });
    expect(out).toContain("…(+7000 chars)");
    expect(out).not.toContain("⚠");
  });

  it("shrink-to-fit keeps output under maxTotalChars, with a ⚠ note", () => {
    const heavy = Array.from({ length: 80 }, (_, i) => ({ id: i, payload: "y".repeat(400) }));
    const out = toSExprString(heavy, { maxTotalChars: 4000 });
    expect(out).toContain("⚠ output reduced to fit");
    expect(out.length).toBeLessThanOrEqual(4000 + 300); // content bounded + the note
  });

  it("shrink-to-fit is FAIR across siblings — both PSLIST and PSSCAN survive the diff", () => {
    const pslist = Array.from({ length: 500 }, (_, i) => ({ pid: i, name: `proc${i}` }));
    const psscan = Array.from({ length: 600 }, (_, i) => ({ pid: i, name: `scan${i}` }));
    const out = toSExprString(
      [
        ["PSLIST", pslist],
        ["PSSCAN", psscan],
      ],
      { maxTotalChars: 3000 },
    );
    // The second sibling is NOT tail-cut away — both labels and their `+N more` markers present.
    expect(out).toContain("PSLIST");
    expect(out).toContain("PSSCAN");
    expect(out).toMatch(/of 500/);
    expect(out).toMatch(/of 600/);
    expect(out.length).toBeLessThanOrEqual(3000 + 300);
  });

  it("the truncated form still PARSES — the marker is a #| block comment |#", () => {
    const out = toSExprString(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 5 },
    );
    expect(out).toMatch(/#\| \+95 more of 100 \|#/);
  });
});
