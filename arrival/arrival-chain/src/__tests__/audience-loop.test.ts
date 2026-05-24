/**
 * Verifies the runnable audience-loop.scm port against V's nested data
 * shape. Uses a small fake personas set + 1 variant + a system-routing
 * stub backend, and confirms:
 *
 *   - reaction stage produces M replays per (persona, variant)
 *   - classification stage produces 1 result per (persona, variant)
 *   - boundary stage produces 1 result per variant (when above threshold)
 *   - boundary returns #f when below threshold
 */
import { readFileSync } from "node:fs";
import { singletonRegistry } from "../registry.js";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseChatPrompt } from "../backends/_shared.js";
import type { ModelSpec } from "../model.js";
import { runPipeline } from "../runner.js";

const PROGRAM = readFileSync(
  path.resolve(__dirname, "../../../../../../50testers/scripts/arrival-chain/programs/audience-loop.scm"),
  "utf-8",
);

const profile = (id: string, name: string) => ({
  id,
  versions: [{ n: 1, state: { name, oneLine: `${name}'s line`, occupation: "x" } }],
});

const PERSONAS = {
  p1: profile("p1", "Maya"),
  p2: profile("p2", "Priya"),
  p3: profile("p3", "Sam"),
};

const VARIANTS = [{ id: "V0", lead: "lead-0", scenario: "scenario-0" }];

/**
 * Routes by user-prompt content. Reactions return free text;
 * classifications + boundary + gap return their respective JSON
 * shapes.
 */
const routedBackend = () => {
  const calls = { reaction: 0, classify: 0, boundary: 0, gap: 0 };
  const complete = vi.fn(async (spec: ModelSpec) => {
    const msgs = parseChatPrompt(spec.prompt) ?? [];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Map the audience boundary")) {
      calls.boundary++;
      return {
        axes: [{ name: "x", description: "y", polarity: "+" }],
        boundaryDescription: "boundary X",
        inScopeCount: 2,
        adjacentCount: 1,
        outOfScopeCount: 0,
      };
    }
    if (user.includes("Analyse gaps")) {
      calls.gap++;
      return { gaps: [{ region: "r", rationale: "r", targetPersonaCount: 3, priority: 0.5 }] };
    }
    if (user.includes("Classify how this persona")) {
      calls.classify++;
      return {
        acceptance: 0.5,
        confidence: 0.5,
        proximityToScope: 0.5,
        bucket: "B",
        reasoning: "stub",
      };
    }
    if (user.includes("You are a synthetic respondent")) {
      calls.reaction++;
      return "(a) trades clarity for brevity (b) keep reading (c) what about pricing?";
    }
    throw new Error(`unexpected user prompt:\n${user.slice(0, 200)}`);
  });
  return { complete, calls };
};

describe("audience-loop.scm — full 4-stage pipeline", () => {
  it("runs reaction × M, classification, boundary, gap for one variant", async () => {
    const backend = routedBackend();
    const result = await runPipeline({
      files: {
        "personas.json": JSON.stringify(PERSONAS),
        "variants.json": JSON.stringify(VARIANTS),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      env: {
        "product-context": "test",
        "min-replays": 2,
        "min-for-boundary": 3,
      },
      backends: singletonRegistry(backend),
    });

    // 3 personas × 2 replays × 1 variant = 6 reactions
    // 3 personas × 1 variant = 3 classifications
    // 1 boundary, 1 gap
    expect(backend.calls.reaction).toBe(6);
    expect(backend.calls.classify).toBe(3);
    expect(backend.calls.boundary).toBe(1);
    expect(backend.calls.gap).toBe(1);

    // Result is one row per variant: (variant-id boundary gap)
    const rows = result as [string, unknown, unknown][];
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("V0");
    expect(rows[0][1]).toBeTruthy();
    expect(rows[0][2]).toBeTruthy();
  });

  it("boundary returns #f when persona count is below threshold", async () => {
    const backend = routedBackend();
    const result = await runPipeline({
      files: {
        "personas.json": JSON.stringify({ p1: profile("p1", "Maya") }),
        "variants.json": JSON.stringify(VARIANTS),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      env: {
        "product-context": "test",
        "min-replays": 2,
        "min-for-boundary": 3,
      },
      backends: singletonRegistry(backend),
    });

    // 1 persona × 2 replays + 1 classification, but boundary is skipped.
    expect(backend.calls.reaction).toBe(2);
    expect(backend.calls.classify).toBe(1);
    expect(backend.calls.boundary).toBe(0);
    expect(backend.calls.gap).toBe(0);

    const rows = result as [string, unknown, unknown][];
    // boundary and gap are #f (false) — in scheme, #f comes back as false.
    expect(rows[0][1]).toBe(false);
    expect(rows[0][2]).toBe(false);
  });
});
