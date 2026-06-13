/**
 * Verifies the runnable generate-personas.scm port — accumulating
 * batches where each new batch's prompt embeds prior personas.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseChatPrompt } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { configScm } from "./fixtures/config-scm.js";

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "fixtures/programs", name), "utf-8");

const PROGRAM = fixture("generate-personas.scm");

// generate-personas.scm is the latest spec: the batch stage is a .prompt (model +
// Picoschema output + the inlined generation system prompt) and string-concat
// comes from the _util.scm stdlib. Ship both alongside main.scm.
const DEPS = {
  "_util.scm": fixture("_util.scm"),
  "generate-personas.prompt": fixture("generate-personas.prompt"),
};

/**
 * Stub that returns `count` synthetic personas per batch, named so we
 * can verify which batch produced them and that prior batches reach
 * later prompts.
 */
const batchStub = () => {
  const calls: { user: string; cacheKey: string | null }[] = [];
  const complete = vi.fn(async (spec: ModelSpec) => {
    const msgs = parseChatPrompt(spec.prompt) ?? [];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    calls.push({ user, cacheKey: spec.schema /* unused; just to satisfy types */ ? null : null });
    // Parse "ids p<S>..p<E>" out of the prompt.
    const m = user.match(/ids p(\d+)\.\.p(\d+)/);
    if (!m) throw new Error(`stub: could not find id range in: ${user.slice(0, 120)}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const personas: Record<string, unknown>[] = [];
    for (let i = start; i <= end; i++) {
      personas.push({
        id: `p${i}`,
        name: `N${i}`,
        oneLine: `synthetic persona ${i}`,
        occupation: "x",
        pains: [], goals: [], jobsToBeDone: [], currentToolStack: [], dealbreakers: [],
      });
    }
    return { value: { personas } };
  });
  return { complete, calls };
};

describe("generate-personas.scm — accumulating batch generation", () => {
  it("each subsequent batch sees the prior batch's personas in its prompt", async () => {
    const backend = batchStub();
    const result = await runPipeline({
      files: {
        ...DEPS,
        "config.scm": configScm({
          "total-count": 6,
          "batch-size":  2,
          "product-context": "test product",
        }),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      router: singletonRouter(backend),
    });

    // 6 / 2 = 3 batches.
    expect(backend.complete).toHaveBeenCalledTimes(3);

    // Result is 6 personas total, in order p1..p6.
    const personas = result as { id: string }[];
    expect(personas.length).toBe(6);
    expect(personas.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);

    // Batch 0 prompt: no priors block (initial-batch shape).
    expect(backend.calls[0].user).toContain("Produce 2 personas with ids p1..p2");
    expect(backend.calls[0].user).not.toContain("Already generated");

    // Batch 1 prompt: priors block contains p1 + p2.
    expect(backend.calls[1].user).toContain("Already generated (2 personas");
    expect(backend.calls[1].user).toContain("- N1 (p1):");
    expect(backend.calls[1].user).toContain("- N2 (p2):");

    // Batch 2 prompt: priors block contains all 4 prior personas.
    expect(backend.calls[2].user).toContain("Already generated (4 personas");
    expect(backend.calls[2].user).toContain("- N3 (p3):");
    expect(backend.calls[2].user).toContain("- N4 (p4):");
  });

  it("replays the whole accumulating chain with zero new backend calls", async () => {
    // First pass populates cache.
    const b1 = batchStub();
    await runPipeline({
      files: {
        ...DEPS,
        "config.scm": configScm({ "total-count": 4, "batch-size": 2, "product-context": "test product" }),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      router: singletonRouter(b1),
    });
    expect(b1.complete).toHaveBeenCalledTimes(2);

    // Second pass — same project state (config + files) would yield same
    // cache keys at every step. (We bootstrap a fresh project each run
    // here for isolation; the deeper test is in enrich-distant.spec.ts
    // which uses one Project across two runs.)
    const b2 = batchStub();
    await runPipeline({
      files: {
        ...DEPS,
        "config.scm": configScm({ "total-count": 4, "batch-size": 2, "product-context": "test product" }),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      router: singletonRouter(b2),
    });
    // Different Project ⇒ different doc ⇒ fresh cache. So this fires
    // again. The persistence-across-runs property is tested elsewhere.
    expect(b2.complete).toHaveBeenCalledTimes(2);
  });
});
