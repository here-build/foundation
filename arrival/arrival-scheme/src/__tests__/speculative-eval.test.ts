/**
 * Tier-2 speculative evaluation — the end-to-end oracle.
 *
 * The half-baked.test.ts suite pins the lazy CARRIER in isolation. This suite
 * pins the WIRED machine: `filter`/`map` emitting a `HalfBaked` over a still-
 * filling predicate fan, `length` reading its cardinality interval, and a
 * comparison op (`>=`) collapsing the enclosing `if` the instant the interval
 * is decisive — all driven through the real `exec` entry point.
 *
 * Two properties, two test groups:
 *
 *   1. EQUIVALENCE (the soundness floor): for any program, `speculate:true`
 *      yields a value `equal?` to `speculate:false`. Speculation is a pure
 *      latency optimization — never observable in the result.
 *
 *   2. EARLY COLLAPSE (the point): with a predicate fan whose trailing slots
 *      NEVER settle, the eager path hangs (its `promise_all` awaits every slot)
 *      while the speculative path completes — because `(>= (length …) 2)`
 *      decides the moment the second kept element lands. This is the
 *      discriminating test: same source, opposite termination, the difference
 *      is exactly the early-collapse behaviour.
 *
 * See docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initBridge } from "../bridge";
import { exec } from "../generator-exec";
import { env as globalEnv } from "../lips";

beforeAll(async () => {
  await initBridge();
});

/** A boolean to whatever `is_false` treats as truthy — a JS boolean is fine. */
const truthyFor = (x: unknown): boolean => Number((x as { valueOf(): unknown })?.valueOf?.() ?? x) > 0;

/** Unwrap a Scheme symbol/atom result to its JS name/value for comparison. */
const unwrap = (v: unknown): unknown => (v as { valueOf?: () => unknown })?.valueOf?.() ?? v;

const MOTIVATING = (n: number) =>
  `(if (>= (length (filter pred (list ${Array.from({ length: n }, (_, i) => i + 1).join(" ")}))) 2) 'enough 'not-enough)`;

describe("speculative eval — equivalence (speculate on/off agree)", () => {
  /** Predicate that resolves on a microtask — both paths terminate. */
  function autoEnv() {
    return globalEnv.inherit("spec-auto", {
      pred: (x: unknown) => Promise.resolve(truthyFor(x)),
    });
  }

  it("motivating program: same value with speculation on and off (enough case)", async () => {
    const src = MOTIVATING(4); // 1..4 all positive → 4 kept ≥ 2 → 'enough
    const [off] = await exec(src, { env: autoEnv(), speculate: false });
    const [on] = await exec(src, { env: autoEnv(), speculate: true });
    expect(unwrap(on)).toEqual(unwrap(off));
    expect(unwrap(on)).toEqual("enough");
  });

  it("not-enough case agrees too", async () => {
    // Only one positive → 1 kept < 2 → 'not-enough on both paths.
    const env1 = globalEnv.inherit("spec-one-a", { pred: (x: unknown) => Promise.resolve(truthyFor(x)) });
    const env2 = globalEnv.inherit("spec-one-b", { pred: (x: unknown) => Promise.resolve(truthyFor(x)) });
    const src = "(if (>= (length (filter pred (list 1 -1 -2 -3))) 2) 'enough 'not-enough)";
    const [off] = await exec(src, { env: env1, speculate: false });
    const [on] = await exec(src, { env: env2, speculate: true });
    expect(unwrap(on)).toEqual(unwrap(off));
    expect(unwrap(on)).toEqual("not-enough");
  });

  it("map carries the count through (length of a mapped fan is exact up front)", async () => {
    const env1 = globalEnv.inherit("spec-map-a", { f: (x: unknown) => Promise.resolve(x) });
    const env2 = globalEnv.inherit("spec-map-b", { f: (x: unknown) => Promise.resolve(x) });
    const src = "(if (>= (length (map f (list 1 2 3))) 2) 'enough 'not-enough)";
    const [off] = await exec(src, { env: env1, speculate: false });
    const [on] = await exec(src, { env: env2, speculate: true });
    expect(unwrap(on)).toEqual(unwrap(off));
    expect(unwrap(on)).toEqual("enough");
  });
});

describe("speculative eval — early collapse (the (>= … 2) win)", () => {
  /**
   * A predicate that hands back deferred promises and records their resolvers,
   * so the test can settle slots one at a time — and crucially, LEAVE the tail
   * pending forever. `pred` is called once per item, in item order.
   */
  function deferredEnv() {
    const resolvers: Array<(keep: boolean) => void> = [];
    const env = globalEnv.inherit("spec-deferred", {
      pred: () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    });
    return { env, resolvers };
  }

  /** Spin the event loop until the predicate fan has been built (`pred` called ×n). */
  const untilFanBuilt = async (resolvers: unknown[], n: number, tries = 200) => {
    for (let i = 0; i < tries && resolvers.length < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  /** Resolve `value` or `sentinel` after a beat — to detect a hung eager path. */
  const settledOrTimeout = async <T>(p: Promise<T>, ms = 80): Promise<T | "TIMEOUT"> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"TIMEOUT">((r) => (timer = setTimeout(() => r("TIMEOUT"), ms)));
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };

  it("speculative path completes with the tail STILL pending; eager path hangs", async () => {
    const src = MOTIVATING(4); // four predicate slots

    // --- speculative: resolve only the first two (kept), never the rest ---
    const spec = deferredEnv();
    const specRun = exec(src, { env: spec.env, speculate: true });
    // Let exec build the fan (filter calls pred ×4) before we settle slots.
    await untilFanBuilt(spec.resolvers, 4);
    spec.resolvers[0]?.(true);
    spec.resolvers[1]?.(true); // lo reaches 2 → decide fires → if collapses
    const specResult = await settledOrTimeout(specRun);
    expect(specResult).not.toBe("TIMEOUT");
    expect(unwrap((specResult as unknown[])[0])).toEqual("enough");
    // slots 2 and 3 were NEVER resolved — the win is real.

    // --- eager: settle the same two, leave the tail pending → must hang ---
    const eager = deferredEnv();
    const eagerRun = exec(src, { env: eager.env, speculate: false });
    await untilFanBuilt(eager.resolvers, 4);
    eager.resolvers[0]?.(true);
    eager.resolvers[1]?.(true);
    const eagerResult = await settledOrTimeout(eagerRun);
    expect(eagerResult).toBe("TIMEOUT"); // promise_all still awaits slots 2,3
    // drain the dangling run so it doesn't leak into the next test
    eager.resolvers[2]?.(false);
    eager.resolvers[3]?.(false);
    await eagerRun;
  });
});
