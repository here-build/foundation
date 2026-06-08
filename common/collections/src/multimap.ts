import { DefaultedMap } from "./defaulted-collections.js";

/**
 * ArrayMultimap — a Map where every key holds a LIST of values, and the list
 * is created for you the first time you touch the key.
 *
 * This is the "group things into buckets" pattern. Instead of:
 *
 *     const buckets = new Map<K, V[]>();
 *     if (!buckets.has(k)) buckets.set(k, []);   // the easy-to-forget prelude
 *     buckets.get(k)!.push(v);                   // and the non-null "!" footgun
 *
 * you write `buckets.append(k, v)`. The empty array springs into existence on
 * first append, so there's no `if (!has)` prelude to forget and no `!` to lie
 * to the type-checker with.
 *
 * It's a thin subclass of {@link DefaultedMap} (factory = `() => []`), so it IS
 * a normal Map for every other purpose: `.get(k)` always returns an array
 * (empty if untouched), and `.entries()`/`for…of`/`.size`/`.delete(k)` behave
 * as usual. The only addition is the `append` verb.
 */
export class ArrayMultimap<K, V> extends DefaultedMap<K, V[]> {
  constructor() {
    super(() => []);
  }

  /** Append `value` to this key's list (creating the list if needed). Returns
   *  `this` so calls can be chained. */
  append(key: K, value: V): this {
    this.get(key).push(value);
    return this;
  }
}

/**
 * SetMultimap — like {@link ArrayMultimap}, but each key holds a SET of values
 * (so duplicates collapse). The set is created on first touch.
 *
 * Replaces the hand-rolled:
 *
 *     const m = new Map<K, Set<V>>();
 *     if (!m.has(k)) m.set(k, new Set());
 *     m.get(k)!.add(v);
 *
 * with `m.add(k, v)`. Beyond deleting the `if (!has)` prelude and the `!`, the
 * typed value (`Set<V>` for a single `V`) also dissolves a specific footgun:
 * when buckets hold a *union* of types, hand-rolls often typed the value as a
 * union-of-sets (`Set<A> | Set<B>`), whose `.add` parameter narrows to `never`
 * and forces a `@ts-expect-error`/cast. `SetMultimap<K, A | B>` holds a single
 * `Set<A | B>`, so `add(k, value)` type-checks for any member with no cast.
 *
 * Thin subclass of {@link DefaultedMap} (factory = `() => new Set()`): `.get(k)`
 * always returns a Set (empty if untouched); all other Map operations are
 * unchanged.
 */
export class SetMultimap<K, V> extends DefaultedMap<K, Set<V>> {
  constructor() {
    super(() => new Set());
  }

  /** Add `value` to this key's set (creating the set if needed). Returns `this`
   *  so calls can be chained. */
  add(key: K, value: V): this {
    this.get(key).add(value);
    return this;
  }

  /**
   * Remove a single `value` from this key's set. Returns `true` if the value
   * was present. Leaves an empty set behind (use `.delete(key)` to drop the
   * whole bucket) — this is the per-value counterpart to Map's per-key delete.
   */
  deleteValue(key: K, value: V): boolean {
    return this.get(key).delete(value);
  }
}
