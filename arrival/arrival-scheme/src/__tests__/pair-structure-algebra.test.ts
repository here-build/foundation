// Algebras-in-entities cell (wave 2): Pair's structure-algebras — Functor,
// Filterable, Foldable, Traversable, Chain, Semigroup (list-append), Monoid
// (nil identity). Migrated from the fantasy-land-lips.ts monkey-patch INTO the
// Pair class body (plan-2026-06-10-algebras-in-entities.md).
//
// Pair has NO `fantasy-land/equals` BY DESIGN — `structuralEqual` IS its Setoid
// (a self-recursive Pair instance would loop ∞; see the matrix in the plan). So
// the law harness's internal `equals` (which calls `a["fantasy-land/equals"]`)
// can't be used for Pair directly; we feed `functorLaws` an explicit
// structuralEqual `eq`, and assert Semigroup/Monoid laws directly over
// structuralEqual.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Pair } from "../Pair.js";
import { nil, Nil } from "../types.js";
import { structuralEqual } from "../structural-equal.js";
import { functorLaws } from "./algebra-laws.js";

const MAP = "fantasy-land/map";
const FILTER = "fantasy-land/filter";
const REDUCE = "fantasy-land/reduce";
const TRAVERSE = "fantasy-land/traverse";
const CHAIN = "fantasy-land/chain";
const CONCAT = "fantasy-land/concat";
const EMPTY = "fantasy-land/empty";
const OF = "fantasy-land/of";

type FL = Record<string, any>;

// Pairs over small integer arrays (deep=false to keep raw JS numbers, so the
// element-level transforms below are plain arithmetic). Includes the empty
// list (nil) and length up to 4 so associativity has something to bite on.
const intList = fc
  .array(fc.integer({ min: -5, max: 5 }), { maxLength: 4 })
  .map((arr) => Pair.fromArray(arr, false) as Pair | Nil);

// Non-empty variant for tests that need a Pair head (Functor laws map over a
// Pair; nil has its own trivial behavior covered separately).
const nonEmptyIntList = fc
  .array(fc.integer({ min: -5, max: 5 }), { minLength: 1, maxLength: 4 })
  .map((arr) => Pair.fromArray(arr, false) as Pair);

const eq = (a: unknown, b: unknown) => structuralEqual(a, b);

// ----------------------------------------------------------------------
// Functor — identity + composition, equality via structuralEqual.
// ----------------------------------------------------------------------
functorLaws<Pair, number>("Pair", {
  arb: nonEmptyIntList,
  f: (x) => x + 1,
  g: (x) => x * 2,
  eq,
});

// ----------------------------------------------------------------------
// Semigroup (list append) — associativity over structuralEqual. (Cannot use
// the harness `semigroupLaws`: it needs `fantasy-land/equals`, which Pair
// deliberately lacks.)
// ----------------------------------------------------------------------
describe("Pair — Semigroup (list-append)", () => {
  const concat = (a: FL, b: FL) => a[CONCAT](b);
  it("associativity: (a⋄b)⋄c ≡ a⋄(b⋄c)", () => {
    fc.assert(
      fc.property(intList, intList, intList, (a, b, c) => {
        const lhs = concat(concat(a as FL, b as FL), c as FL);
        const rhs = concat(a as FL, concat(b as FL, c as FL));
        return eq(lhs, rhs);
      }),
    );
  });
  it("concat preserves element order and is pure (operands untouched)", () => {
    const a = Pair.fromArray([1, 2], false) as Pair;
    const b = Pair.fromArray([3, 4], false) as Pair;
    const r = (a as FL)[CONCAT](b);
    expect((r as Pair).to_array()).toEqual([1, 2, 3, 4]);
    // purity: a and b unchanged
    expect((a as Pair).to_array()).toEqual([1, 2]);
    expect((b as Pair).to_array()).toEqual([3, 4]);
  });
});

// ----------------------------------------------------------------------
// Monoid — nil is the identity. (Direct, same reason as Semigroup.)
// ----------------------------------------------------------------------
describe("Pair — Monoid (nil identity)", () => {
  const concat = (a: FL, b: FL) => a[CONCAT](b);
  const empty = () => (Pair as FL)[EMPTY]() as Nil;
  it("Pair['fantasy-land/empty']() is nil", () => {
    expect(empty()).toBe(nil);
  });
  it("right identity: a ⋄ empty ≡ a", () => {
    fc.assert(fc.property(intList, (a) => eq(concat(a as FL, empty() as FL), a)));
  });
  it("left identity: empty ⋄ a ≡ a (nil's own concat is the identity)", () => {
    // nil['fantasy-land/concat'](a) === a — Nil is the list-monoid identity
    // (declared in types.ts alongside Pair's list-append).
    fc.assert(fc.property(intList, (a) => eq(concat(empty() as FL, a as FL), a)));
  });
});

// ----------------------------------------------------------------------
// Foldable — behavioral. reduce sums a list; empty folds to the seed.
// ----------------------------------------------------------------------
describe("Pair — Foldable (reduce)", () => {
  it("reduce sums elements left-to-right", () => {
    const list = Pair.fromArray([1, 2, 3, 4], false) as Pair;
    const sum = (list as FL)[REDUCE]((acc: number, x: number) => acc + x, 0);
    expect(sum).toBe(10);
  });
  it("reduce collects in order", () => {
    const list = Pair.fromArray([1, 2, 3], false) as Pair;
    const collected = (list as FL)[REDUCE]((acc: number[], x: number) => [...acc, x], [] as number[]);
    expect(collected).toEqual([1, 2, 3]);
  });
  it("reduce on empty-pair sentinel returns the seed (no phantom element)", () => {
    let calls = 0;
    const r = (new Pair(undefined, nil) as FL)[REDUCE]((acc: string) => {
      calls++;
      return acc;
    }, "SEED");
    expect(calls).toBe(0);
    expect(r).toBe("SEED");
  });
});

// ----------------------------------------------------------------------
// Filterable — behavioral. keeps evens; sentinel short-circuits.
// ----------------------------------------------------------------------
describe("Pair — Filterable (filter)", () => {
  it("filter keeps evens", () => {
    const list = Pair.fromArray([1, 2, 3, 4, 5, 6], false) as Pair;
    const evens = (list as FL)[FILTER]((x: number) => x % 2 === 0) as Pair;
    expect(evens.to_array()).toEqual([2, 4, 6]);
  });
  it("filter all-false yields nil", () => {
    const list = Pair.fromArray([1, 3, 5], false) as Pair;
    const r = (list as FL)[FILTER](() => false);
    expect(r).toBe(nil);
  });
  it("filter on empty-pair sentinel does not call the predicate", () => {
    let calls = 0;
    (new Pair(undefined, nil) as FL)[FILTER](() => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
  });
});

// ----------------------------------------------------------------------
// Traversable — behavioral. Over a leaf-mode `of` (no applicative ap), traverse
// wraps each element. We use an array-applicative-free `of = (x)=>x` so the
// structure is rebuilt as nested Pairs (matches the monkey-patch's of-leaf path).
// ----------------------------------------------------------------------
describe("Pair — Traversable (traverse)", () => {
  it("traverse with identity-of visits each element once, terminating at nil", () => {
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const list = Pair.fromArray([1, 2], false) as Pair;
    (list as FL)[TRAVERSE](of, (x: number) => x);
    // base case of(nil) + one of(new Pair(...)) per element (leaf path) = 1 + 2.
    expect(ofCalls.length).toBe(3);
    // last-built base case wrapped nil
    expect(ofCalls.some((v) => v instanceof Nil)).toBe(true);
  });
  it("traverse over an applicative (array) sequences effects", () => {
    // mappedCar carries fantasy-land/ap → traverse uses ap to combine.
    // Use a minimal Identity-like applicative: { value, 'fantasy-land/ap' }.
    const Id = (value: unknown) => ({
      value,
      ["fantasy-land/ap"](other: any) {
        // this holds a function-or-value; for traverse, `this` wraps the head
        // and `other` wraps the rest — combine into a Pair.
        return Id(new Pair((this as any).value, other.value));
      },
    });
    const list = Pair.fromArray([1, 2, 3], false) as Pair;
    const result = (list as FL)[TRAVERSE]((v: unknown) => Id(v), (x: number) => Id(x)) as any;
    expect((result.value as Pair).to_array()).toEqual([1, 2, 3]);
  });
});

// ----------------------------------------------------------------------
// Chain (Monad) — map-then-flatten via the PURE concat. NO global_env append.
// ----------------------------------------------------------------------
describe("Pair — Chain (flatten via pure concat)", () => {
  it("chain duplicates each element (x → (x x))", () => {
    const list = Pair.fromArray([1, 2, 3], false) as Pair;
    const r = (list as FL)[CHAIN]((x: number) => Pair.fromArray([x, x], false)) as Pair;
    expect(r.to_array()).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("chain with single-element results equals map", () => {
    const list = Pair.fromArray([1, 2, 3], false) as Pair;
    const r = (list as FL)[CHAIN]((x: number) => Pair.fromArray([x + 10], false)) as Pair;
    expect(r.to_array()).toEqual([11, 12, 13]);
  });
  it("chain flattening empties drops them (nil result)", () => {
    const list = Pair.fromArray([1, 2], false) as Pair;
    const r = (list as FL)[CHAIN](() => nil);
    expect(r).toBe(nil);
  });
});

// ----------------------------------------------------------------------
// Applicative `of` — single-element list.
// ----------------------------------------------------------------------
describe("Pair — Applicative (static of)", () => {
  it("of(x) is a one-element list (x)", () => {
    const p = (Pair as FL)[OF](42) as Pair;
    expect(p).toBeInstanceOf(Pair);
    expect(p.car).toBe(42);
    expect(p.cdr).toBe(nil);
  });
});

// ----------------------------------------------------------------------
// Provenance-clone termination — the recursors stop on `instanceof Nil`, not
// `=== nil`, so a provenance-bearing Nil clone in tail position terminates
// cleanly (no phantom element). Guards the wave-2 invariant.
// ----------------------------------------------------------------------
describe("Pair — recursors terminate on Nil clones (provenance)", () => {
  const cloneNil = () => nil.withProvenance(new Set<number>([42]));
  it("map(Pair(1, nil-clone)) → (1), fn called once", () => {
    const calls: unknown[] = [];
    const r = (new Pair(1, cloneNil()) as FL)[MAP]((x: unknown) => {
      calls.push(x);
      return x;
    }) as Pair;
    expect(calls).toEqual([1]);
    expect(r.car).toBe(1);
    expect(r.cdr).toBeInstanceOf(Nil);
  });
  it("reduce(Pair(1, nil-clone)) folds one element", () => {
    const r = (new Pair(1, cloneNil()) as FL)[REDUCE]((acc: number, x: number) => acc + x, 0);
    expect(r).toBe(1);
  });
});
