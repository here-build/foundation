/**
 * Cross-fertilization demo: each persona critiques every other.
 *
 * Asserts:
 *   - N personas → N×(N-1) backend calls
 *   - K² calls fan out concurrently (the substrate parallelises both
 *     the outer and inner map under one wall-clock round)
 *   - Adding one persona only invalidates 2N cells (the new row + the
 *     new column), not all (N+1)² — content-addressing buys incremental
 *     recomputation for free
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";

const stub = (delayMs = 0) => {
  const complete = vi.fn(async (_s: ModelSpec) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { value: { strength: "x", weakness: "y", challenge: "z" } };
  });
  return { complete };
};

const PROGRAM = `
(define (persona-summary p) (field p "name"))

(define CritiqueSchema
  (s/object
    (s/field/string "strength")
    (s/field/string "weakness")
    (s/field/string "challenge")))

(define (critique-of-by target critic)
  (car (infer/chat "fast"
         (list (infer/chat/system (string-append "you are " (persona-summary critic)))
               (infer/chat/user   (persona-summary target)))
         CritiqueSchema
         (string-append (field critic "name") "→" (field target "name")))))

(define (others-of p personas)
  (filter (lambda (q) (not (equal? (field q "name") (field p "name"))))
          personas))

(define (cross-critique personas)
  (map (lambda (target)
         (list (field target "name")
               (map (lambda (critic) (critique-of-by target critic))
                    (others-of target personas))))
       personas))

(require "personas.json")
(cross-critique personas)
`;

describe("cross-fertilization — N×(N-1) critique matrix", () => {
  it("fires one call per (critic, target) pair, skipping the diagonal", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("personas.json", JSON.stringify([
      { name: "Maya" }, { name: "Priya" }, { name: "Sam" },
    ]));

    const backend = stub();
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    await project.run(PROGRAM);

    // 3 personas, no self-critique: 3 × 2 = 6 calls.
    expect(backend.complete).toHaveBeenCalledTimes(6);
    expect(cache.tasks.size).toBe(6);
    ac.abort(); await draining;
  });

  it("the K² matrix fans out concurrently — one delay, not K²", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("personas.json", JSON.stringify([
      { name: "A" }, { name: "B" }, { name: "C" }, { name: "D" },
    ]));

    const backend = stub(60); // 4 × 3 = 12 calls; sequential would be 720ms
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const t0 = Date.now();
    await project.run(PROGRAM);
    const elapsed = Date.now() - t0;

    expect(backend.complete).toHaveBeenCalledTimes(12);
    expect(elapsed).toBeLessThan(300); // not 12 × 60 = 720
    ac.abort(); await draining;
  });

  it("adding a persona only invalidates 2N new cells, not (N+1)²", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("personas.json", JSON.stringify([
      { name: "Maya" }, { name: "Priya" }, { name: "Sam" },
    ]));

    // First pass: 3 personas → 6 cells.
    const b1 = stub();
    const ac1 = new AbortController();
    const d1 = startOrchestrator({ cache, router: singletonRouter(b1), signal: ac1.signal }).done;
    await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(6);
    ac1.abort(); await d1;

    // Add one persona — replace personas.json with the bigger list.
    project.files.get("personas.json")!.publish(JSON.stringify([
      { name: "Maya" }, { name: "Priya" }, { name: "Sam" }, { name: "Lex" },
    ]));

    // Second pass: only the new (Lex, *) row and (*, Lex) column are
    // uncached — that's 2*3 = 6 new cells. The original 6 still hit.
    const b2 = stub();
    const ac2 = new AbortController();
    const d2 = startOrchestrator({ cache, router: singletonRouter(b2), signal: ac2.signal }).done;
    await project.run(PROGRAM);
    expect(b2.complete).toHaveBeenCalledTimes(6);
    expect(cache.tasks.size).toBe(12); // 4 × 3 total
    ac2.abort(); await d2;
  });
});
