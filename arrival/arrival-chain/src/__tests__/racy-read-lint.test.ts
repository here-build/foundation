/**
 * Racy-read lint — flags `(infer/spent)` reads inside a parallel HOF arm, where
 * the fold over the run's own inference history is meaningless ("spent relative to
 * which sibling?"). Allowed at a sequence point (top level, a fold/loop arm).
 */
import { parseGenerator } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { lintRacyReads } from "../racy-read-lint.js";

const lint = async (src: string) => lintRacyReads(await parseGenerator(src));

describe("lintRacyReads — reflective reads in parallel arms", () => {
  it("flags (infer/spent) inside a (map …) arm", async () => {
    const findings = await lint(`
      (map (lambda (x)
             (if (> (infer/spent) 1.0) 'stop (infer "m" x #f #f)))
           (list 1 2 3))
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].read).toBe("infer/spent");
    expect(findings[0].enclosingHof).toBe("map");
    expect(findings[0].message).toMatch(/racy|meaningless/i);
    expect(findings[0].message).toMatch(/reduce|fold|loop/i); // routes to the fix
  });

  it("flags reads inside (filter …) and (for-each …) too", async () => {
    expect(await lint(`(filter (lambda (x) (< (infer/spent) 5)) xs)`)).toHaveLength(1);
    expect(await lint(`(for-each (lambda (x) (infer/spent)) xs)`)).toHaveLength(1);
  });

  it("does NOT flag (infer/spent) at the top level", async () => {
    expect(await lint(`(infer/spent)`)).toHaveLength(0);
    expect(await lint(`(begin (infer "m" "p" #f #f) (infer/spent))`)).toHaveLength(0);
  });

  it("does NOT flag a read inside a (reduce …) arm — folds are sequence points", async () => {
    const findings = await lint(`
      (reduce (lambda (acc x)
                (if (> (infer/spent) 1.0) acc (cons (infer "m" x #f #f) acc)))
              '()
              (list 1 2 3))
    `);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag a read inside a named-let loop", async () => {
    const findings = await lint(`
      (let loop ((i 0))
        (if (or (= i 3) (> (infer/spent) 1.0))
            'done
            (begin (infer "m" (number->string i) #f #f) (loop (+ i 1)))))
    `);
    expect(findings).toHaveLength(0);
  });

  it("flags a read in a fold nested INSIDE a map — the outer parallel context dominates", async () => {
    // The inner reduce is itself a sequence point, but per-arm `spent` is undefined
    // w.r.t. the OUTER map's concurrent arms, so the read is still racy.
    const findings = await lint(`
      (map (lambda (group)
             (reduce (lambda (acc x) (+ acc (infer/spent))) 0 group))
           groups)
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].enclosingHof).toBe("map");
  });

  it("flags a bare (infer/spent) passed as a callback to map", async () => {
    // `(map infer/spent xs)` — the symbol is read as a value inside the parallel HOF.
    const findings = await lint(`(map infer/spent (list 1 2 3))`);
    expect(findings).toHaveLength(1);
    expect(findings[0].read).toBe("infer/spent");
  });

  it("flags multiple reads in one arm", async () => {
    const findings = await lint(`
      (map (lambda (x) (list (infer/spent) (infer/calls))) xs)
    `);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.read).sort()).toEqual(["infer/calls", "infer/spent"]);
  });

  it("does not flag ordinary code with no reflective reads", async () => {
    expect(await lint(`(map (lambda (x) (* x 2)) (list 1 2 3))`)).toHaveLength(0);
  });
});
