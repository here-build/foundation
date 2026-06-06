/**
 * HalfBaked — the lazy carrier core, in isolation (no evaluator wiring yet).
 *
 * Pins the three load-bearing behaviours the speculative-evaluation design
 * (docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md)
 * rests on:
 *   1. the cardinality interval NARROWS from both ends as slots settle;
 *   2. `decide` resolves EARLY — the instant the interval is decisive, with
 *      slots still pending (this is the `(>= (length (filter …)) 2)` collapse);
 *   3. `force`/`refine` fold to the data-true Pair, memoized (idempotent at
 *      multiple boundaries).
 */
import { describe, expect, it } from "vitest";

import { HalfBaked, is_half_baked, type Interval } from "../HalfBaked.js";
import { is_promise } from "../guards.js";

/** A promise plus its resolver, so a test can settle slots one at a time. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** filter slot bounds: 0..1 per slot until settled. */
const filterBounds = (): [number, number] => [0, 1];
/** map/list slot bounds: exactly 1 per slot. */
const mapBounds = (): [number, number] => [1, 1];

describe("HalfBaked — cardinality interval", () => {
  it("filter: interval is [0, N] up front, narrows from both ends as slots settle", async () => {
    const d = [deferred<number[]>(), deferred<number[]>(), deferred<number[]>()];
    const hb = HalfBaked.collection(
      d.map((x) => x.promise),
      filterBounds,
    );

    expect(hb.interval()).toEqual<Interval>({ lo: 0, hi: 3 });

    d[0].resolve([7]); // kept → raises lo and keeps hi
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 1, hi: 3 });

    d[1].resolve([]); // dropped → lowers hi only
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 1, hi: 2 });

    d[2].resolve([9]); // kept → collapses to a point
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 2, hi: 2 });
    expect(hb.isFullySettled).toBe(true);
  });

  it("map/list: length is known exactly up front (interval is a point)", () => {
    const d = [deferred<number[]>(), deferred<number[]>()];
    const hb = HalfBaked.collection(
      d.map((x) => x.promise),
      mapBounds,
    );
    // Values unknown, COUNT is not: [2,2] before a single slot settles.
    expect(hb.interval()).toEqual<Interval>({ lo: 2, hi: 2 });
  });
});

describe("HalfBaked — early decision (the (>= … 2) collapse)", () => {
  it("decide resolves the instant lo >= k, with slots still pending", async () => {
    const d = [deferred<number[]>(), deferred<number[]>(), deferred<number[]>(), deferred<number[]>()];
    const list = HalfBaked.collection(
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();

    let decidedAt = -1;
    const decision = len.decide<boolean>((iv) => (iv.lo >= 2 ? true : iv.hi < 2 ? false : undefined));
    void decision.then(() => (decidedAt = settledCount));

    let settledCount = 0;
    d[0].resolve([1]);
    settledCount = 1;
    await tick();
    d[1].resolve([1]);
    settledCount = 2; // <- the second kept element: lo reaches 2, decision fires
    await tick();

    await expect(decision).resolves.toBe(true);
    // Decided at the 2nd settle — slots 2 and 3 are STILL pending.
    expect(decidedAt).toBe(2);
    expect(list.isFullySettled).toBe(false);
  });

  it("decide resolves false early when hi drops below k (all-dropped)", async () => {
    const d = [deferred<number[]>(), deferred<number[]>(), deferred<number[]>()];
    const list = HalfBaked.collection(
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();
    const decision = len.decide<boolean>((iv) => (iv.lo >= 2 ? true : iv.hi < 2 ? false : undefined));

    d[0].resolve([]); // hi 3→2
    d[1].resolve([]); // hi 2→1  → 1 < 2 → false, slot 2 still pending
    await tick();
    await expect(decision).resolves.toBe(false);
    expect(list.isFullySettled).toBe(false);
  });

  it("a correct verdict always resolves once the fan fully settles (no early signal)", async () => {
    const d = [deferred<number[]>(), deferred<number[]>()];
    const list = HalfBaked.collection(
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();
    const decision = len.decide<boolean>((iv) => (iv.lo === iv.hi ? iv.lo >= 1 : undefined));
    d[0].resolve([]);
    d[1].resolve([5]);
    await expect(decision).resolves.toBe(true);
  });
});

describe("HalfBaked — force / refine fold", () => {
  it("collection force folds slot payloads (flattened) into a Pair", async () => {
    const list = HalfBaked.collection(
      [Promise.resolve([10]), Promise.resolve([]), Promise.resolve([30])],
      filterBounds,
    );
    const pair = await list.force();
    // Pair → array round-trip: dropped slot contributes nothing. `Pair.fromArray`
    // boxes raw payloads into Scheme values, so compare the unwrapped numbers.
    const nums = [...pair].map((v) => Number((v as { valueOf(): unknown }).valueOf?.() ?? v));
    expect(nums).toEqual([10, 30]);
  });

  it("number force folds to the settled count", async () => {
    const list = HalfBaked.collection([Promise.resolve([1]), Promise.resolve([]), Promise.resolve([3])], filterBounds);
    const len = list.toCardinalityNumber();
    expect(await len.force()).toBe(2);
  });

  it("force is memoized — same promise instance at repeated boundaries", () => {
    const list = HalfBaked.collection([Promise.resolve([1])], filterBounds);
    expect(list.force()).toBe(list.force());
    expect(list.refine()).toBe(list.force());
  });
});

describe("HalfBaked — invisibility contract", () => {
  it("is_half_baked recognizes it; is_promise does NOT (so evaluateArgs passes it through)", () => {
    const hb = HalfBaked.collection([Promise.resolve([1])], filterBounds);
    expect(is_half_baked(hb)).toBe(true);
    // The whole point: a HalfBaked is not a thenable, so the arg-await in
    // evaluateArgs (`if (is_promise(arg)) arg = yield arg`) skips it.
    expect(is_promise(hb)).toBe(false);
    expect("then" in (hb as object)).toBe(false);
  });
});
