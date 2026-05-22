/**
 * Verifies herebuild-multi.scm — K variants × N personas × M replays.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseChatPrompt } from "../backends/_shared.js";
import type { ModelSpec } from "../model.js";
import { runPipeline } from "../runner.js";

const PROGRAM = readFileSync(
  path.resolve(__dirname, "../../../../../../50testers/scripts/arrival-chain/programs/herebuild-multi.scm"),
  "utf-8",
);

const profile = (id: string, name: string) => ({
  id,
  versions: [{ n: 1, state: { name, oneLine: `${name}'s one-liner` } }],
});

describe("herebuild-multi.scm — K × N × M reactions", () => {
  it("fires one task per (variant, persona, replay) cell", async () => {
    const personas = { p1: profile("p1", "Maya"), p2: profile("p2", "Priya") };
    const variants = [
      { id: "V0", lead: "first hero" },
      { id: "V1", lead: "second hero" },
    ];
    const complete = vi.fn(async (spec: ModelSpec) => {
      const msgs = parseChatPrompt(spec.prompt) ?? [];
      const user = msgs.find((m) => m.role === "user")?.content ?? "";
      const m = user.match(/Name: (\w+)/);
      return { interpretation: `i-${m?.[1] ?? "?"}`, verdict: "click", concern: "" };
    });

    const result = await runPipeline({
      files: {
        "personas.json": JSON.stringify(personas),
        "variants.json": JSON.stringify(variants),
        "main.scm":      PROGRAM,
      },
      entry: "main.scm",
      env: { "replays": 3, "system-prompt": "test-sys" },
      backends: { complete },
    });

    // 2 variants × 2 personas × 3 replays = 12 cells
    expect(complete).toHaveBeenCalledTimes(12);

    // Result shape: [(variant-id [(persona-id [reaction × replays]) ...]) ...]
    const rows = result as [string, [string, unknown[]][]][];
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe("V0");
    expect(rows[0][1].length).toBe(2);
    expect(rows[0][1][0][1].length).toBe(3);
  });
});
