/**
 * Counter — a Map that tallies how many times you've seen each key.
 *
 * This is the "count occurrences of things" pattern, written once. You hand it
 * keys; it keeps a running integer total per key. It's the same idea as
 * Python's `collections.Counter` or a histogram.
 *
 * Why it exists: across the codebase the *exact same three lines* kept getting
 * re-typed —
 *
 *     const counts = new Map<K, number>();
 *     counts.set(key, (counts.get(key) ?? 0) + 1);   // the "+1 with a default" dance
 *     ...later: [...counts.values()] / for (… if (count > 1) …)
 *
 * — and each hand-roll re-derived the same follow-up reductions (sum the
 * values, find the keys that repeated). Worse, because the read and the write
 * were two separate `.get`/`.set` calls, it was easy to read one key and write
 * a *different* one by accident (a real bug we found and this class makes
 * impossible). `Counter` collapses the whole idiom into `increment(key)`.
 *
 * Two deliberate departures from a plain `Map`, both matching how a tally
 * "should" feel:
 *   - `get(missingKey)` returns `0`, never `undefined` — an unseen thing has
 *     been counted zero times. So you never write `?? 0` at a read site again.
 *   - reading a missing key does NOT create an entry (unlike `DefaultedMap`).
 *     Only `increment` writes. Reads stay side-effect-free.
 *
 * Everything else is a normal `Map`: `.values()`, `.entries()`, `for…of`,
 * `.size`, `.delete(key)`, `.clear()` all work as usual.
 */
export class Counter<K> extends Map<K, number> {
  /**
   * The current count for `key`. Returns `0` for a key that's never been
   * incremented (instead of `undefined`), because "not seen yet" means "seen
   * zero times". Reading does not insert anything.
   */
  get(key: K): number {
    return super.get(key) ?? 0;
  }

  /**
   * Add `by` (default `1`) to this key's tally and return the NEW total.
   *
   * Replaces the `m.set(k, (m.get(k) ?? 0) + 1)` one-liner. Because the read
   * and the write are a single call against a single key, you cannot
   * accidentally count under one key and store under another.
   */
  increment(key: K, by = 1): number {
    const next = this.get(key) + by;
    super.set(key, next);
    return next;
  }

  /**
   * Every key whose tally is at least `min`, in insertion order.
   *
   * This is the "which things showed up more than once?" query — pass `2` to
   * get the keys that collided/repeated. Replaces the hand-rolled
   * `for (const [k, n] of counts) if (n >= min) out.push(k)` loop.
   */
  keysAtLeast(min: number): K[] {
    const out: K[] = [];
    for (const [key, n] of this) {
      if (n >= min) out.push(key);
    }
    return out;
  }
}
