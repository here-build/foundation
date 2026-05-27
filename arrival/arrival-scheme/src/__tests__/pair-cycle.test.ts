/**
 * Regression guard for the Pair.toJs cycle-safety fix (commit 5f7f9e46a).
 *
 * The bug
 * -------
 * Before the fix, Pair.toJs walked the cdr chain in an unguarded
 * `while (true)` — feeding it a list with a cdr-cycle would loop forever
 * and hang the process (no stack overflow, no error, just dead CPU).
 *
 * The fix
 * -------
 * Pair.ts:583-606 now guards toJs with two complementary checks:
 *   1. Top-level `invariant(!this.have_cycles(), ...)` — fast O(metadata)
 *      reject when mark_cycles has already annotated the spine.
 *   2. A per-traversal `Set<Pair>` watchdog at line 588 — defence against
 *      a cycle introduced post-have_cycles via mutation during the walk
 *      itself (a malicious nested toJs override that mutates cdr).
 *
 * Pair.toString is DIFFERENT: it has always handled cycles via the
 * `__cycles__` / `__ref__` metadata machinery (Pair.ts:484-537), emitting
 * `#0=` / `#0#` ref markers. JSON has no equivalent notation — toJs must
 * loud-fail; toString can render.
 *
 * These tests guard both directions: toJs MUST throw, toString MUST NOT.
 */

import { describe, expect, it } from "vitest";
import { Pair } from "../Pair";
import { nil } from "../types";

describe("Pair.toJs cycle handling (regression guard for fix 5f7f9e46a)", () => {
  it("throws on a self-cycle (cdr points at the head)", () => {
    // Construct: (1 . #0#) where #0 is the cell itself.
    const p = new Pair(1, nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).cdr = p;
    // Note: `have_cycles` only returns true after `mark_cycles` has stamped
    // metadata. Without it, the top-level invariant doesn't trip — instead
    // the per-traversal Set-watchdog (Pair.ts:588) fires. Both produce the
    // same /cycle/i invariant message.
    expect(() => p.toJs()).toThrow(/cycle/i);
  });

  it("throws on a mutual cycle (two cells pointing at each other)", () => {
    // Construct: a → b → a (cdr cycle through both cells).
    const a = new Pair(1, nil);
    const b = new Pair(2, nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a as any).cdr = b;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).cdr = a;
    expect(() => a.toJs()).toThrow(/cycle/i);
  });

  it("throws on a mark_cycles-annotated cycle (fast-path invariant)", () => {
    // When mark_cycles has run, `have_cycles()` returns true — the
    // top-level invariant trips before the watchdog Set is even allocated.
    // This is the cheaper path and is the one most callers hit, since
    // parser-produced cyclic lists are pre-marked.
    const p = new Pair(1, nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).cdr = p;
    p.mark_cycles();
    expect(p.have_cycles()).toBe(true);
    expect(() => p.toJs()).toThrow(/cycle/i);
  });

  it("returns an array for a proper list", () => {
    // (1 2 3) → [1, 2, 3]; cdr-chain terminates at nil.
    const p = Pair.fromArray([1, 2, 3], false) as Pair;
    expect(p.toJs()).toEqual([1, 2, 3]);
  });

  it("returns { __dotted__, list, tail } for a dotted (improper) pair", () => {
    // (1 . 2) — cdr is a non-nil non-pair, the improper-list branch.
    const p = new Pair(1, 2);
    const result = p.toJs() as { __dotted__: boolean; list: unknown[]; tail: unknown };
    expect(result.__dotted__).toBe(true);
    expect(result.list).toEqual([1]);
    expect(result.tail).toBe(2);
  });

  it("returns [] for the empty list (cdr is nil from the start)", () => {
    // Edge case: a single Pair(undefined, nil) is not the empty list per
    // se, but the cdr-traversal terminates immediately on the first
    // `is_nil(node)` check. The toJs result includes the undefined car.
    // (We avoid asserting on the singleton `nil` itself because Nil.toJs
    // returns `null` — different codepath, tested separately.)
    const p = new Pair(1, nil);
    expect(p.toJs()).toEqual([1]);
  });
});

describe("Pair.toString cycle handling (uses ref-marker notation — fundamentally different)", () => {
  it("does NOT throw on a self-cycle (renders via #0= / #0# markers)", () => {
    // Construct (1 . #0#) — self-cycle on cdr — then mark_cycles to
    // populate the __cycles__ / __ref__ metadata that toString reads.
    const p = new Pair(1, nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).cdr = p;
    p.mark_cycles();
    // Should produce something like `#0=(1 . #0#)` — exact format depends
    // on the ref/cycle numbering, but it MUST NOT throw and MUST contain
    // a ref marker.
    expect(() => p.toString()).not.toThrow();
    const rendered = p.toString();
    expect(rendered).toMatch(/#0[=#]/);
  });

  it("does NOT throw on a mutual cycle", () => {
    const a = new Pair(1, nil);
    const b = new Pair(2, nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a as any).cdr = b;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).cdr = a;
    a.mark_cycles();
    expect(() => a.toString()).not.toThrow();
  });
});
