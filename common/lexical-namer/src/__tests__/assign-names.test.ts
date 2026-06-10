/**
 * assignNames — priority-based name assignment.
 *
 * These tests exercise the algorithm directly with synthetic entities (plain
 * objects with an `id`). No CSS or JS specifics. Use the same test pattern
 * to validate domain-specific wrappers (class-namer, var-namer, etc.).
 */

import { describe, expect, it } from "vitest";

import { assignNames, type PrioritizedCandidate } from "../index.js";

interface TestEntity {
  id: string;
  candidates: PrioritizedCandidate[];
}

function run(entities: TestEntity[], reserved?: string[]) {
  return assignNames<TestEntity>({
    entities,
    candidatesFor: (e) => e.candidates,
    postfixFor: (e) => e.id,
    ...(reserved && { reserved }),
  });
}

const e = (id: string, ...candidates: PrioritizedCandidate[]): TestEntity => ({ id, candidates });
const c = (name: string, importance: number): PrioritizedCandidate => ({ name, importance });

describe("assignNames — basic", () => {
  it("single entity, single candidate → claims it", () => {
    const a = e("a", c("alpha", 10));
    const { assignments } = run([a]);
    expect(assignments.get(a)).toBe("alpha");
  });

  it("two entities, non-overlapping candidates → both claim their primary", () => {
    const a = e("a", c("alpha", 10));
    const b = e("b", c("beta", 10));
    const { assignments } = run([a, b]);
    expect(assignments.get(a)).toBe("alpha");
    expect(assignments.get(b)).toBe("beta");
  });

  it("no ties, different importance levels → higher wins", () => {
    const a = e("a", c("shared", 20), c("a-fallback", 5));
    const b = e("b", c("shared", 10), c("b-fallback", 5));
    const { assignments } = run([a, b]);
    expect(assignments.get(a)).toBe("shared");
    expect(assignments.get(b)).toBe("b-fallback");
  });
});

describe("assignNames — ties", () => {
  it("two entities tied at same (importance, name) → both postfixed, bare burned", () => {
    const a = e("a", c("hero", 100), c("a-last", 5));
    const b = e("b", c("hero", 100), c("b-last", 5));
    const { assignments, burned, claimed } = run([a, b]);

    expect(assignments.get(a)).toBe("hero-a");
    expect(assignments.get(b)).toBe("hero-b");
    expect(burned.has("hero")).toBe(true);
    expect(claimed.has("hero")).toBe(false); // burned != claimed
  });

  it("three-way tie → all three postfixed", () => {
    const a = e("a", c("x", 50));
    const b = e("b", c("x", 50));
    const d = e("d", c("x", 50));
    const { assignments } = run([a, b, d]);
    expect(assignments.get(a)).toBe("x-a");
    expect(assignments.get(b)).toBe("x-b");
    expect(assignments.get(d)).toBe("x-d");
  });

  it("burned name cannot be claimed by lower-importance claimer", () => {
    // a and b tie on "shared" at 100 → both postfix, "shared" burned.
    // c wants "shared" at 50 → must walk to its next candidate.
    const a = e("a", c("shared", 100));
    const b = e("b", c("shared", 100));
    const d = e("d", c("shared", 50), c("d-fallback", 5));
    const { assignments, burned } = run([a, b, d]);
    expect(burned.has("shared")).toBe(true);
    expect(assignments.get(d)).toBe("d-fallback");
  });
});

describe("assignNames — priority layering", () => {
  it("higher-importance claim blocks lower-importance entity → lower walks to next", () => {
    // a claims "shared" at 100. b wants "shared" at 50 — blocked → b uses "b-fallback".
    const a = e("a", c("shared", 100));
    const b = e("b", c("shared", 50), c("b-fallback", 5));
    const { assignments } = run([a, b]);
    expect(assignments.get(a)).toBe("shared");
    expect(assignments.get(b)).toBe("b-fallback");
  });

  it("entity stops after first successful claim — doesn't re-enter at lower levels", () => {
    // a claims "hero" at 100. Its secondary "hero2" at 50 is never considered.
    // b wants "hero2" at 50 — free → claims it cleanly.
    const a = e("a", c("hero", 100), c("hero2", 50));
    const b = e("b", c("hero2", 50));
    const { assignments } = run([a, b]);
    expect(assignments.get(a)).toBe("hero");
    expect(assignments.get(b)).toBe("hero2");
  });
});

describe("assignNames — reserved", () => {
  it("reserved names are not claimable; entity walks to next candidate", () => {
    const a = e("a", c("root", 100), c("a-fallback", 10));
    const { assignments } = run([a], ["root"]);
    expect(assignments.get(a)).toBe("a-fallback");
  });
});

describe("assignNames — fallback suffix", () => {
  it("entity whose candidates all collide falls back to its last + numeric suffix", () => {
    // a claims "x". b's candidate list is just ["x"] too → nothing left when
    // processed; fallback uses "x" → taken → numeric suffix "x2".
    const a = e("a", c("x", 50));
    const b = e("b", c("x", 30));
    const { assignments } = run([a, b]);
    expect(assignments.get(a)).toBe("x");
    expect(assignments.get(b)).toBe("x2");
  });

  it("entity with empty candidate list throws", () => {
    const a = e("a");
    expect(() => run([a])).toThrow(/no candidates/);
  });
});

describe("assignNames — same-importance candidates (record converter)", () => {
  it("two candidates at the same importance: name-ascending order is preserved", () => {
    // Mirrors class-namer's INNER=60 / CHILDREN=60 collision on one entity.
    // priority-namer's queue breaks the same-importance tie by name ascending,
    // so "children" is tried before "inner". The record converter must keep
    // that order via fractional demotion (60 vs 59.999).
    const a = e("a", c("inner", 60), c("children", 60), c("a-fallback", 10));
    const { assignments } = run([a]);
    // "children" < "inner" → claimed first, entity stops there.
    expect(assignments.get(a)).toBe("children");
  });

  it("same-importance demotion does not disturb a neighboring lower tier", () => {
    // Entity x has inner/children at 60; entity y wants the demoted name at 58.
    // The fraction (59.999) must stay strictly between 58 and 60 so y's 58
    // candidate is unaffected.
    const x = e("x", c("inner", 60), c("children", 60), c("x-f", 10));
    const y = e("y", c("inner", 58), c("y-f", 10));
    const { assignments } = run([x, y]);
    expect(assignments.get(x)).toBe("children");
    expect(assignments.get(y)).toBe("inner");
  });
});

describe("assignNames — onTie: free", () => {
  it("bare name stays claimable by lower-importance claimer", () => {
    // a, b tie on "hero" @ 100 → hero-a, hero-b. With onTie:"free", "hero" is
    // NOT burned. Then d wants "hero" @ 50 → claims it.
    const a = e("a", c("hero", 100));
    const b = e("b", c("hero", 100));
    const d = e("d", c("hero", 50), c("d-fallback", 5));
    const { assignments, burned, claimed } = assignNames<TestEntity>({
      entities: [a, b, d],
      candidatesFor: (x) => x.candidates,
      postfixFor: (x) => x.id,
      onTie: "free",
    });
    expect(assignments.get(a)).toBe("hero-a");
    expect(assignments.get(b)).toBe("hero-b");
    expect(assignments.get(d)).toBe("hero");
    expect(burned.has("hero")).toBe(false);
    expect(claimed.has("hero")).toBe(true);
  });

  it("default is 'burn' — bare name off-limits to lower-importance claimer", () => {
    // Same entities as above, default onTie: bare name burned.
    const a = e("a", c("hero", 100));
    const b = e("b", c("hero", 100));
    const d = e("d", c("hero", 50), c("d-fallback", 5));
    const { assignments, burned } = run([a, b, d]);
    expect(assignments.get(d)).toBe("d-fallback");
    expect(burned.has("hero")).toBe(true);
  });
});

describe("assignNames — determinism", () => {
  it("iteration order of entities doesn't affect outcome", () => {
    const a = e("a", c("hero", 100));
    const b = e("b", c("hero", 100));
    const d = e("d", c("hero", 100));

    const r1 = run([a, b, d]).assignments;
    const r2 = run([d, b, a]).assignments;
    const r3 = run([b, d, a]).assignments;

    expect(r1.get(a)).toBe(r2.get(a));
    expect(r1.get(b)).toBe(r2.get(b));
    expect(r1.get(d)).toBe(r2.get(d));
    expect(r1.get(a)).toBe(r3.get(a));
    expect(r1.get(b)).toBe(r3.get(b));
    expect(r1.get(d)).toBe(r3.get(d));
  });
});
