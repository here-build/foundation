/**
 * End-to-end port of scripts/enrich-distant-personas.ts onto the
 * arrival-chain substrate. The test seeds a small baseline and three
 * abstract sketches into Project.files, stubs the "high" backend with
 * a model that echoes back a recognisable JSON object for each input,
 * and runs the .scm program twice — once in each shape (parallel-vs-
 * baseline, and the accumulating fold that visual DAGs can't express).
 *
 * Asserts:
 *   - the parallel shape produces one call per seed
 *   - the accumulating shape ALSO produces one call per seed but each
 *     subsequent call's user prompt contains the previous enrichment's
 *     name (proving the prior threaded into the next prompt)
 *   - replay over the same Project produces zero new backend calls
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { parseChatPrompt } from "../backends/_shared.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";

const SEEDS = [
  { id: "seed_alpha", description: "A regulatory compliance officer at a mid-sized fintech." },
  { id: "seed_beta",  description: "A part-time consultant who builds tooling for nonprofits." },
  { id: "seed_gamma", description: "A senior researcher with a side-project monetisation itch." },
];

const BASELINE = [
  { name: "Maya",  oneLine: "design lead wanting tokens that survive a redesign" },
  { name: "Priya", oneLine: "frontend engineer shipping React weekly" },
];

const SYSTEM_PROMPT = "Enrich the abstract sketch into a vivid concrete persona that stands APART.";

const PROGRAM = `
(require "baseline.json")
(require "owl-seeds.json")
(require "enrich-system.txt")

(define EnrichedSchema
  (s/object
    (s/field/string "id")
    (s/field/string "name")
    (s/field/string "oneLine")))

(define (render-avoid personas)
  (apply string-append
    (map (lambda (p)
           (string-append "- " (field p "name") ": " (field p "oneLine") "\n"))
         personas)))

(define (enrich-against avoid seed)
  (car (infer/chat "high"
         (list (infer/chat/system enrich-system)
               (infer/chat/user
                 (string-append
                   "Avoid:\n" (render-avoid avoid) "\n"
                   "Sketch: " (field seed "description"))))
         EnrichedSchema
         (field seed "id"))))

(define (enrich-all/accumulating seeds baseline)
  (define (loop remaining acc)
    (if (null? remaining)
      (reverse acc)
      (let ((next (enrich-against (append baseline (reverse acc)) (car remaining))))
        (loop (cdr remaining) (cons next acc)))))
  (loop seeds '()))

(enrich-all/accumulating owl-seeds baseline)
`;

/**
 * Stub backend that returns a stable enrichment shape derived from the
 * seed id embedded in the prompt. Returns a chat-message-aware
 * complete() so the inputs the model sees match what production would.
 */
const recordingBackend = () => {
  const calls: { messages: { role: string; content: string }[]; schema: string | null }[] = [];
  const complete = vi.fn(async (spec: ModelSpec) => {
    const messages = parseChatPrompt(spec.prompt) ?? [{ role: "user", content: spec.prompt }];
    calls.push({ messages, schema: spec.schema });
    // Pull the seed id back out of the prompt to produce a unique reply.
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const seedMatch = user.match(/Sketch: A ([^\n]+)/);
    const tag = seedMatch ? seedMatch[1].slice(0, 12) : "unk";
    return { value: { id: `enriched_${tag}`, name: `E-${tag}`, oneLine: `enriched: ${tag}` } };
  });
  return { complete, calls };
};

describe("enrich-distant-personas — accumulating fold port", () => {
  it("threads each prior enrichment into the next call's prompt", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("baseline.json",     JSON.stringify(BASELINE));
    project.addFile("owl-seeds.json",    JSON.stringify(SEEDS));
    project.addFile("enrich-system.txt", SYSTEM_PROMPT);

    const backend = recordingBackend();
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = await project.run(PROGRAM);

    // Three seeds → three backend calls, in seed order.
    expect(backend.complete).toHaveBeenCalledTimes(3);
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(3);

    // Per-iteration: the user prompt's avoid block must contain the
    // names of the personas seen BEFORE this iteration.
    const userText = (i: number): string =>
      backend.calls[i].messages.find((m) => m.role === "user")!.content;

    // Call 0 — avoid block has only baseline (Maya, Priya), no E-* yet.
    expect(userText(0)).toContain("Maya");
    expect(userText(0)).toContain("Priya");
    expect(userText(0)).not.toContain("E-");

    // Call 1 — avoid block has baseline + the previous enrichment.
    expect(userText(1)).toContain("Maya");
    expect(userText(1)).toContain("E-regulatory ");  // first enrichment's name tag

    // Call 2 — avoid block has baseline + both previous enrichments.
    expect(userText(2)).toContain("E-regulatory ");
    expect(userText(2)).toContain("E-part-time co");  // second enrichment's name tag

    ac.abort(); await draining;
  });

  it("replays the whole fold with zero new backend calls", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("baseline.json",     JSON.stringify(BASELINE));
    project.addFile("owl-seeds.json",    JSON.stringify(SEEDS));
    project.addFile("enrich-system.txt", SYSTEM_PROMPT);

    // First run: populate cache.
    const b1 = recordingBackend();
    const ac1 = new AbortController();
    const d1 = startOrchestrator({ cache, router: singletonRouter(b1), signal: ac1.signal }).done;
    const first = await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(3);
    ac1.abort(); await d1;

    // Second run: every step should hit the cache because each prompt
    // deterministically embeds the priors that yielded the cached results
    // at the prior steps — content-addressing makes the whole accumulating
    // chain replay-stable.
    const b2 = recordingBackend();
    const ac2 = new AbortController();
    const d2 = startOrchestrator({ cache, router: singletonRouter(b2), signal: ac2.signal }).done;
    const second = await project.run(PROGRAM);

    expect(b2.complete).toHaveBeenCalledTimes(0);
    expect(second).toEqual(first);
    ac2.abort(); await d2;
  });
});
