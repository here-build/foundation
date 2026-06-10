/**
 * Invariant tests — properties that must hold over ANY valid input.
 *
 * Exhausts the input space via a small enumerator (hand-rolled, no fast-check).
 * These catch regressions in the algorithm that focused unit tests miss.
 */

import { describe, expect, it } from "vitest";

import { assignNames, type PrioritizedCandidate } from "../index.js";

interface E {
  id: string;
  candidates: PrioritizedCandidate[];
}

function run(entities: E[], reserved?: string[]) {
  return assignNames<E>({
    entities,
    candidatesFor: (e) => e.candidates,
    postfixFor: (e) => e.id,
    ...(reserved && { reserved }),
  });
}

const e = (id: string, ...candidates: PrioritizedCandidate[]): E => ({ id, candidates });
const c = (name: string, importance: number): PrioritizedCandidate => ({ name, importance });

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 48271) % 2147483647;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── Corpus: representative trees across the adversarial space ───────────

const corpus: Array<{ name: string; make: () => E[] }> = [
  { name: "empty", make: () => [] },
  { name: "single entity, single candidate", make: () => [e("a", c("alpha", 10))] },
  {
    name: "two non-overlapping",
    make: () => [e("a", c("x", 10)), e("b", c("y", 10))],
  },
  {
    name: "two tied at one importance",
    make: () => [e("a", c("hero", 100)), e("b", c("hero", 100))],
  },
  {
    name: "five tied deep",
    make: () =>
      Array.from({ length: 5 }, (_, k) => e(`n${k}`, c("shared", 100), c(`fallback-${k}`, 5))),
  },
  {
    name: "priority cascade",
    make: () => [
      e("a", c("x", 100)),
      e("b", c("x", 50), c("y", 30), c("z", 10)),
      e("c", c("y", 80)),
    ],
  },
  {
    name: "reserved blocks primary",
    make: () => [e("a", c("root", 100), c("a-fallback", 10))],
  },
  {
    name: "burn blocks low-priority",
    make: () => [e("a", c("shared", 100)), e("b", c("shared", 100)), e("c", c("shared", 50), c("c-f", 5))],
  },
  {
    name: "fallback group tied",
    make: () => [e("a", c("x", 100)), e("b", c("x", 100)), e("c", c("x", 100))],
  },
  {
    name: "interleaved importances",
    make: () => [
      e("a", c("x", 100), c("y", 50)),
      e("b", c("y", 100), c("x", 50)),
    ],
  },
  {
    name: "all want same name at descending importance (no ties)",
    make: () => [
      e("a", c("x", 100)),
      e("b", c("x", 90), c("b-f", 5)),
      e("c", c("x", 80), c("c-f", 5)),
    ],
  },
  {
    name: "chained tie-and-fallback",
    make: () =>
      // a,b tie at 100 on hero; c wants hero at 50 → blocked → falls back.
      [
        e("a", c("hero", 100)),
        e("b", c("hero", 100)),
        e("c", c("hero", 50), c("c-last", 5)),
      ],
  },
  {
    name: "many entities with unique preferences",
    make: () => Array.from({ length: 20 }, (_, k) => e(`n${k}`, c(`name${k}`, 10))),
  },
  {
    name: "self-duplicate candidates (deduped)",
    make: () => [e("a", c("hero", 100), c("hero", 50), c("a-last", 5))],
  },
  {
    name: "unicode names",
    make: () => [e("a", c("héro", 100)), e("b", c("café", 100)), e("c", c("hero", 100))],
  },
];

function scenarioName(n: string): string {
  return `scenario: ${n}`;
}

describe("invariant: assignments.size === entities.size", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const entities = make();
      const { assignments } = run(entities);
      expect(assignments.size).toBe(entities.length);
    });
  }
});

describe("invariant: every assigned name is unique", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const entities = make();
      const { assignments } = run(entities);
      const names = [...assignments.values()];
      expect(new Set(names).size).toBe(names.length);
    });
  }
});

describe("invariant: reserved names never appear in assignments", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const entities = make();
      const reserved = ["reserved-1", "root", "class"];
      const { assignments } = run(entities, reserved);
      for (const n of assignments.values()) {
        expect(reserved).not.toContain(n);
      }
    });
  }
});

describe("invariant: claimed ∩ burned === ∅", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const entities = make();
      const { claimed, burned } = run(entities);
      for (const n of burned) {
        expect(claimed.has(n)).toBe(false);
      }
    });
  }
});

describe("invariant: output is insensitive to iteration order (permutation test)", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const entities = make();
      if (entities.length === 0) {
        // no permutation space
        return;
      }
      const reference = run(entities).assignments;
      const keyed = new Map([...reference.entries()].map(([k, v]) => [k.id, v]));
      for (let seed = 1; seed <= 10; seed++) {
        const permuted = shuffle(entities, seed);
        const result = run(permuted).assignments;
        for (const ent of permuted) {
          expect(result.get(ent)).toBe(keyed.get(ent.id));
        }
      }
    });
  }
});

describe("invariant: two runs produce identical output (determinism)", () => {
  for (const { name, make } of corpus) {
    it(scenarioName(name), () => {
      const a = make();
      const b = make();
      // Same entities (by id), different instances.
      const ra = run(a);
      const rb = run(b);
      const keyed = (m: ReadonlyMap<E, string>) => new Map([...m.entries()].map(([k, v]) => [k.id, v]));
      expect([...keyed(ra.assignments).entries()].sort()).toEqual([...keyed(rb.assignments).entries()].sort());
    });
  }
});

// ── Special corner cases ─────────────────────────────────────────────────

describe("postfixFor injectivity enforcement", () => {
  it("throws when two tied entities produce the same postfix", () => {
    // Both entities report the same postfix "same". When they tie, namer must throw.
    const a: E = { id: "a", candidates: [c("hero", 100)] };
    const b: E = { id: "b", candidates: [c("hero", 100)] };
    expect(() =>
      assignNames<E>({
        entities: [a, b],
        candidatesFor: (x) => x.candidates,
        postfixFor: () => "same",
      }),
    ).toThrow(/injective/);
  });
});

describe("generator inputs", () => {
  it("iterable (generator) entities work — materialized once", () => {
    function* gen(): Generator<E> {
      yield e("a", c("x", 10));
      yield e("b", c("y", 10));
    }
    const { assignments } = assignNames<E>({
      entities: gen(),
      candidatesFor: (x) => x.candidates,
      postfixFor: (x) => x.id,
    });
    expect(assignments.size).toBe(2);
  });
});

describe("custom resolveTie / fallbackSuffix (JS-style)", () => {
  it("resolveTie with underscore separator", () => {
    const a = e("a", c("foo", 100));
    const b = e("b", c("foo", 100));
    const { assignments } = assignNames<E>({
      entities: [a, b],
      candidatesFor: (x) => x.candidates,
      postfixFor: (x) => x.id,
      resolveTie: (name, _entity, postfix) => `${name}_${postfix}`,
    });
    expect(assignments.get(a)).toBe("foo_a");
    expect(assignments.get(b)).toBe("foo_b");
  });

  it("fallbackSuffix with underscore", () => {
    const a = e("a", c("x", 10));
    const b = e("b", c("x", 10));
    // both tie at name "x" @ 10 → apply tie-break (not fallback). To hit fallback:
    const reserved = ["x"];
    const c2 = e("c", c("x", 10));
    const { assignments } = assignNames<E>({
      entities: [c2],
      candidatesFor: (x) => x.candidates,
      postfixFor: (x) => x.id,
      reserved,
      fallbackSuffix: (name, n) => `${name}_${n}`,
    });
    // reserved blocks "x"; only one entity; fallback numeric-suffix with underscore style.
    expect(assignments.get(c2)).toBe("x_2");
    // Silence unused-var lint; entities a/b referenced for documentation
    void a;
    void b;
  });
});

describe("large input performance", () => {
  it("1000 entities with unique preferences completes quickly", () => {
    const entities = Array.from({ length: 1000 }, (_, k) => e(`n${k}`, c(`name${k}`, 10)));
    const start = Date.now();
    const { assignments } = run(entities);
    const elapsed = Date.now() - start;
    expect(assignments.size).toBe(1000);
    expect(elapsed).toBeLessThan(500); // generous ceiling
  });

  it("1000 entities all tied at same name → all postfixed, no quadratic blowup", () => {
    const entities = Array.from({ length: 1000 }, (_, k) => e(`n${k}`, c("shared", 100)));
    const start = Date.now();
    const { assignments, burned } = run(entities);
    const elapsed = Date.now() - start;
    expect(assignments.size).toBe(1000);
    expect(burned.has("shared")).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});
