/**
 * Integration smoke test for scripts/arrival-chain/programs/best-tagline.scm.
 *
 * Loads the .scm + the four .hbs templates from disk, runs the full
 * optimize-tagline pipeline against a small synthetic persona pool, and
 * verifies the end-to-end shape: a non-empty result tree with parent-id
 * links and per-branch bouncer triage.
 *
 * The stub backend recognises three rendered-prompt shapes and responds
 * deterministically — algorithmic correctness lives in gepa-loop /
 * gepa-triage / gepa-worklist; this spec only proves the wire-up.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { parseChatPrompt } from "../backends/_shared.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRegistry } from "../registry.js";

const PROGRAMS_DIR = path.resolve(__dirname, "../../../../../../50testers/scripts/arrival-chain/programs");
const read = (name: string) => readFileSync(path.join(PROGRAMS_DIR, name), "utf-8");

const FILES = {
  "personas.json": "", // filled per-test
  "main.scm": read("best-tagline.scm"),
  "summary-of-persona.hbs": read("summary-of-persona.hbs"),
  "tagline-reaction.hbs": read("tagline-reaction.hbs"),
  "reflection-prompt.hbs": read("reflection-prompt.hbs"),
  "triage-prompt.hbs": read("triage-prompt.hbs"),
  "consolidation-prompt.hbs": read("consolidation-prompt.hbs"),
  "merge-prompt.hbs": read("merge-prompt.hbs"),
};

const profile = (id: string, name: string) => ({
  id,
  versions: [{ n: 1, state: { name, oneLine: `${name}'s one-liner` } }],
});

/** Tagline progression: t0 → t1 → t2 → … */
const nextTagline = (current: string): string => {
  const m = current.match(/^t(\d+)$/);
  if (!m) return "t1";
  return `t${Number(m[1]) + 1}`;
};

/**
 * Stub: matches on the rendered-prompt body shape.
 *   - "REASONS:"           → consolidation (per-bucket reason summary)
 *   - "CURRENT TAGLINE:"   → reflection
 *   - "TAGLINE THEY SAW:"  → triage
 *   - otherwise            → reaction
 *
 * `verdictFor(name, tagline)` controls the reaction trajectory; tests pass
 * a closure to drive specific scenarios.
 */
const stub = (
  verdictFor: (name: string, tagline: string) => "click" | "bounce" | "keep-reading",
  mismatchFor: (name: string) => boolean = () => false,
) => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    const msgs = parseChatPrompt(spec.prompt) ?? [];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("REASONS:")) {
      return { summary: "stub consolidation summary", "key-points": ["theme-a", "theme-b"] };
    }
    if (user.includes("TAGLINE A:") && user.includes("TAGLINE B:")) {
      return { next: "merged-tagline", rationale: "stub merge" };
    }
    if (user.includes("CURRENT TAGLINE:")) {
      const m = user.match(/CURRENT TAGLINE:\n"([^"]*)"/);
      const current = m?.[1] ?? "t0";
      return { next: nextTagline(current), rationale: "stub" };
    }
    if (user.includes("TAGLINE THEY SAW:")) {
      const nameMatch = user.match(/Name: (\w+)/);
      const name = nameMatch?.[1] ?? "?";
      return { mismatch: mismatchFor(name), reason: `stub triage for ${name}` };
    }
    // reaction
    const tag = user.match(/TAGLINE:\n"([^"]*)"/)?.[1] ?? "?";
    const name = user.match(/Name: (\w+)/)?.[1] ?? "?";
    return { verdict: verdictFor(name, tag), concern: `${name} on ${tag}` };
  });
  return { complete };
};

describe("best-tagline.scm — integration smoke", () => {
  it("converges in one branch when everyone clicks the initial tagline", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const PERSONAS = {
      p1: profile("p1", "Maya"),
      p2: profile("p2", "Sam"),
      p3: profile("p3", "Ada"),
    };
    project.addFile("personas.json", JSON.stringify(PERSONAS));
    for (const [path, content] of Object.entries(FILES)) {
      if (path !== "personas.json") project.addFile(path, content);
    }

    // System prompts live in the .scm as constants — no setEnv needed.
    project.setEnv("initial-tagline", "t0");
    project.setEnv("pov-count", 1);
    project.setEnv("max-iter", 0);
    project.setEnv("plateau-delta", -1);
    project.setEnv("total-iter-cap", 5);
    project.setEnv("bounce-threshold", 0.5);

    const backend = stub(() => "click");
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry(backend), signal: ac.signal }).done;

    const program = project.addProgram("main.scm", FILES["main.scm"]);
    const out = (await program.run()) as {
      tree: Array<Record<string, unknown>>;
      compound: unknown;
      buckets: Array<Record<string, unknown>>;
      summaries: Record<string, unknown>;
    };

    expect(out.tree.length).toBe(1);
    expect(out.tree[0]!.tagline).toBe("t0");
    expect(out.tree[0]!["bounce-rate"]).toBe(0);

    // Single branch → no compound needed.
    expect(out.compound).toBe(false);

    // All 3 clicked → all in "clicking" bucket; audience-miss + unreachable empty.
    expect(out.buckets.length).toBe(3);
    expect(out.buckets.every((b) => b.bucket === "clicking")).toBe(true);
    expect((out.summaries["audience-miss"] as { summary: string }).summary).toBe("");
    expect((out.summaries.unreachable as { summary: string }).summary).toBe("");

    ac.abort();
    await draining;
  });

  it("splits on plateau: triage divides bouncers, child branch runs on latent-fit subset", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const PERSONAS = {
      p1: profile("p1", "Maya"), // always clicks
      p2: profile("p2", "Sam"), // bounces, mismatch
      p3: profile("p3", "Ada"), // bounces, latent fit; clicks on t2
    };
    project.addFile("personas.json", JSON.stringify(PERSONAS));
    for (const [path, content] of Object.entries(FILES)) {
      if (path !== "personas.json") project.addFile(path, content);
    }

    // System prompts live in the .scm as constants — no setEnv needed.
    project.setEnv("initial-tagline", "t0");
    project.setEnv("pov-count", 1);
    project.setEnv("max-iter", 1);
    project.setEnv("plateau-delta", -1);
    project.setEnv("total-iter-cap", 5);
    project.setEnv("bounce-threshold", 0.5);

    const verdictFor = (name: string, tag: string): "click" | "bounce" => {
      if (name === "Maya") return "click";
      if (name === "Sam") return "bounce"; // mismatch — stays bouncing
      if (name === "Ada") return tag === "t0" || tag === "t1" ? "bounce" : "click";
      return "bounce";
    };
    const mismatchFor = (name: string): boolean => name === "Sam";

    const backend = stub(verdictFor, mismatchFor);
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry(backend), signal: ac.signal }).done;

    const program = project.addProgram("main.scm", FILES["main.scm"]);
    const out = (await program.run()) as {
      tree: Array<Record<string, unknown>>;
      compound: { format: string; tagline: string; sources: string[] } | false;
      buckets: Array<Record<string, unknown>>;
      summaries: Record<string, { summary: string }>;
    };

    expect(out.tree.length).toBe(2);
    expect(out.tree[0]!["parent-id"]).toBe(-1);
    expect(out.tree[1]!["parent-id"]).toBe(0);
    expect(out.tree[1]!.personas as string[]).toEqual(["p3"]);

    // Sam was triaged as mismatch → audience-miss bucket.
    // Maya clicked from t0 → clicking. Ada clicked in child branch → clicking.
    const byPid = Object.fromEntries(out.buckets.map((b) => [b.id as string, b]));
    expect(byPid.p1!.bucket).toBe("clicking");
    expect(byPid.p2!.bucket).toBe("audience-miss");
    expect(byPid.p3!.bucket).toBe("clicking");

    // 2 branches → format-variants compound fires, picks best of concat / two-screen / merge.
    expect(out.compound).toBeTruthy();
    expect(typeof (out.compound as { format: string }).format).toBe("string");
    expect((out.compound as { sources: string[] }).sources.length).toBe(2);

    // audience-miss has Sam → consolidation fires. unreachable empty → no LM call.
    expect(out.summaries["audience-miss"]!.summary).toBe("stub consolidation summary");
    expect(out.summaries.unreachable!.summary).toBe("");

    ac.abort();
    await draining;
  });
});
