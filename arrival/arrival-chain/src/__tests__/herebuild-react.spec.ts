/**
 * Verifies the runnable herebuild-react.scm port — N × M parallel.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseChatPrompt } from "../backends/_shared.js";
import type { ModelSpec } from "../model.js";
import { runPipeline } from "../runner.js";

const PROGRAMS_DIR = path.resolve(__dirname, "../../../../../../50testers/scripts/arrival-chain/programs");
const readProgramFile = (name: string) => readFileSync(path.join(PROGRAMS_DIR, name), "utf-8");

const PROGRAM = readProgramFile("herebuild-react.scm");
const SUMMARY_HBS = readProgramFile("summary-of-persona.hbs");
const REACTION_HBS = readProgramFile("reaction-prompt-of-persona.hbs");

const profile = (id: string, name: string) => ({
  id,
  versions: [{ n: 1, state: { name, oneLine: `${name}'s one-liner` } }],
});

const PERSONAS = {
  p1: profile("p1", "Maya"),
  p2: profile("p2", "Priya"),
  p3: profile("p3", "Sam"),
};

const stub = () => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    const msgs = parseChatPrompt(spec.prompt) ?? [];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    const m = user.match(/Name: (\w+)/);
    const name = m ? m[1] : "?";
    return { interpretation: `i-${name}`, verdict: "click", concern: "none" };
  });
  return { complete };
};

describe("herebuild-react.scm — N × M parallel reactions", () => {
  it("fires one task per (persona, replay) cell — 3 × 4 = 12", async () => {
    const backend = stub();
    const result = await runPipeline({
      files: {
        "personas.json":                    JSON.stringify(PERSONAS),
        "main.scm":                         PROGRAM,
        "summary-of-persona.hbs":           SUMMARY_HBS,
        "reaction-prompt-of-persona.hbs":   REACTION_HBS,
      },
      entry: "main.scm",
      env: {
        "hero-id":       "V_TEST",
        "hero-lead":     "test hero",
        "replays":       4,
        "system-prompt": "test-sys",
      },
      backends: backend,
    });

    expect(backend.complete).toHaveBeenCalledTimes(12);

    // Result is 3 rows, each row is [id, [reaction × 4]].
    const rows = result as [string, unknown[]][];
    expect(rows.length).toBe(3);
    expect(rows[0][0]).toBe("p1");
    expect(rows[0][1].length).toBe(4);
  });

  it("12 tasks fan out concurrently — one wall-clock round", async () => {
    const slow = () => ({
      complete: vi.fn(async (_s: ModelSpec) => {
        await new Promise((r) => setTimeout(r, 50));
        return { interpretation: "x", verdict: "click", concern: "" };
      }),
    });

    const backend = slow();
    const t0 = Date.now();
    await runPipeline({
      files: {
        "personas.json":                    JSON.stringify(PERSONAS),
        "main.scm":                         PROGRAM,
        "summary-of-persona.hbs":           SUMMARY_HBS,
        "reaction-prompt-of-persona.hbs":   REACTION_HBS,
      },
      entry: "main.scm",
      env: {
        "hero-id":       "V_TEST",
        "hero-lead":     "t",
        "replays":       4,
        "system-prompt": "s",
      },
      backends: backend,
    });
    const elapsed = Date.now() - t0;

    expect(backend.complete).toHaveBeenCalledTimes(12);
    expect(elapsed).toBeLessThan(300); // 12 × 50 = 600 sequential
  });
});
