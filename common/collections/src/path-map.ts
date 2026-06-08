import { DefaultedMap } from "./defaulted-collections.js";

/**
 * A `Map` whose keys compare **structurally**, not by reference — including when
 * the key is itself a `Set` or `Array` of elements.
 *
 * Plain `Map` keys two different `Set` objects with the same members as two
 * different entries (reference identity). `PathMap` instead keys by *contents*:
 * `new Set([a, b])` and `new Set([b, a])` resolve to the same slot. Element
 * identity is still reference-based for objects (two distinct objects are
 * distinct elements) and value-based for primitives.
 *
 * Allowed keys:
 * - primitives (`string` / `number` / `boolean` / `bigint` / `null`)
 * - objects (identity by reference — distinct objects are distinct keys)
 * - `Set<above>` — unordered (member order doesn't matter)
 * - `Array<above>` — ordered (sequence matters)
 *
 * How it works: a trie indexed by the key's elements. Set keys are sorted by a
 * stable per-object ordinal (assigned once, never changes, process-local) so an
 * unordered set has one canonical path; arrays keep their order. Separate trie
 * roots for flat / set / array keys prevent cross-type collisions. Iteration
 * preserves insertion order.
 */

// ── Key types ────────────────────────────────────────────────────────────────

type Primitive = string | number | boolean | bigint | null;
/** A single key element: a primitive, or any object (keyed by reference identity). */
export type PathMapKeyElement = Primitive | object;
/** A whole key: one element, or an unordered Set / ordered Array of elements. */
export type PathMapKey = PathMapKeyElement | Set<PathMapKeyElement> | ReadonlyArray<PathMapKeyElement>;

/** Reject key elements that can't participate in structural keying. */
function validateKeyElement(item: unknown): void {
  const type = typeof item;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint" || item === null) {
    return; // primitive
  }
  if (type === "object") {
    return; // object — keyed by reference identity
  }
  if (type === "undefined") {
    throw new TypeError("undefined is not allowed as a PathMap key element");
  }
  if (type === "symbol") {
    throw new TypeError("Symbols are not allowed as PathMap key elements");
  }
  if (type === "function") {
    throw new TypeError("Functions are not allowed as PathMap key elements");
  }
  throw new TypeError(`Unsupported PathMap key element: ${Object.prototype.toString.call(item)}`);
}

// ── Ordinal sort: a stable order for set members ─────────────────────────────
//
// Set keys have no inherent order, but the trie needs ONE canonical path. We
// sort objects by a monotonic ordinal assigned the first time we see them (a
// WeakMap, so it never leaks). Primitives sort by type then value. This is
// process-local and never serialized — it only has to be *consistent*, not
// meaningful.

let nextOrdinal = 0;
const singletonOrdinals = new WeakMap<object, number>();
function ordinalOf(o: object): number {
  let id = singletonOrdinals.get(o);
  if (id === undefined) {
    id = nextOrdinal++;
    singletonOrdinals.set(o, id);
  }
  return id;
}

function localSort(a: PathMapKeyElement, b: PathMapKeyElement): number {
  const aIsObj = typeof a === "object" && a !== null;
  const bIsObj = typeof b === "object" && b !== null;

  if (aIsObj && !bIsObj) return -1;
  if (!aIsObj && bIsObj) return 1;

  if (aIsObj && bIsObj) {
    return ordinalOf(a) - ordinalOf(b);
  }

  const aType = a === null ? "null" : typeof a;
  const bType = b === null ? "null" : typeof b;
  if (aType !== bType) return aType.localeCompare(bType);

  return String(a).localeCompare(String(b));
}

// ── Trie ─────────────────────────────────────────────────────────────────────

type TrieNode<K, V> = {
  value: V | undefined;
  keyId: number | undefined;
  canonicalKey: K | WeakRef<K & object> | undefined;
  children: DefaultedMap<PathMapKeyElement, TrieNode<K, V>>;
};

const createNode = <K extends PathMapKey, V>(): TrieNode<K, V> => ({
  value: undefined,
  keyId: undefined,
  canonicalKey: undefined,
  children: new DefaultedMap<PathMapKeyElement, TrieNode<K, V>>(createNode),
});

export class PathMap<K extends PathMapKey, V> implements Map<K, V> {
  private flatRoot: TrieNode<K, V> = createNode();
  private setRoot: TrieNode<K, V> = createNode();
  private arrayRoot: TrieNode<K, V> = createNode();

  private readonly storedEntries = new Map<number, { key: Readonly<K>; node: TrieNode<K, V> }>();
  private nextKeyId = 0;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  get [Symbol.toStringTag](): string {
    return "PathMap";
  }

  getCanonicalKey(key: K): K {
    const node = this.getCanonicalNode(key);
    const resolved = this.resolveCanonicalKey(node.canonicalKey);
    if (resolved === undefined) {
      let canonicalKey: K;
      if (key instanceof Set) {
        canonicalKey = new Set([...key].sort(localSort)) as K;
      } else if (Array.isArray(key)) {
        canonicalKey = Object.freeze([...key]) as K & ReadonlyArray<K[keyof K]>;
      } else {
        canonicalKey = key;
      }
      node.canonicalKey = canonicalKey;
      return canonicalKey;
    }
    return resolved;
  }

  get(key: K): V | undefined {
    return this.maybeGetCanonicalNode(key)?.value;
  }

  set(key: K, value: V): this {
    const node = this.getCanonicalNode(key);

    if (node.value === undefined) {
      node.keyId = this.nextKeyId++;
      this._size++;
      let canonicalKey: K;
      if (key instanceof Set) {
        canonicalKey = new Set([...key].sort(localSort)) as K;
      } else if (Array.isArray(key)) {
        canonicalKey = Object.freeze([...key]) as K & ReadonlyArray<K[keyof K]>;
      } else {
        canonicalKey = key;
      }
      this.storedEntries.set(node.keyId, { key: canonicalKey, node });
      node.canonicalKey = canonicalKey;
    }

    node.value = value;
    return this;
  }

  getOrInsert(key: K, defaultValue: V): V {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    this.set(key, defaultValue);
    return defaultValue;
  }

  getOrInsertComputed(key: K, callbackfn: (key: K) => V): V {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = callbackfn(key);
    this.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.maybeGetCanonicalNode(key)?.value !== undefined;
  }

  delete(key: K): boolean {
    const node = this.maybeGetCanonicalNode(key);
    if (node?.value === undefined) {
      return false;
    }

    if (node.keyId !== undefined) {
      this.storedEntries.delete(node.keyId);
    }

    node.value = undefined;
    node.keyId = undefined;

    const canonicalKey = node.canonicalKey;
    if (canonicalKey instanceof Set || Array.isArray(canonicalKey)) {
      node.canonicalKey = new WeakRef(canonicalKey as K & object);
    }

    this._size--;
    return true;
  }

  clear(): void {
    this.flatRoot = createNode();
    this.setRoot = createNode();
    this.arrayRoot = createNode();
    this.storedEntries.clear();
    this._size = 0;
  }

  *keys(): MapIterator<K> {
    for (const { key } of this.storedEntries.values()) {
      yield key;
    }
  }

  *values(): MapIterator<V> {
    for (const { node } of this.storedEntries.values()) {
      yield node.value!;
    }
  }

  *entries(): MapIterator<[K, V]> {
    for (const { key, node } of this.storedEntries.values()) {
      const output = [key, node.value!];
      yield output as [K, V];
    }
  }

  forEach<T extends Map<K, V>>(this: T, callback: (value: V, key: K, map: T) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) {
      if (thisArg) {
        callback.call(thisArg, value, key, this);
      } else {
        callback(value, key, this);
      }
    }
  }

  [Symbol.iterator]<T extends Map<K, V>>(this: T): MapIterator<[K, V]> {
    return this.entries();
  }

  private maybeGetCanonicalNode(key: K): TrieNode<K, V> | undefined {
    let current: TrieNode<K, V> = this.getRootForKey(key);
    for (const element of this.keyToPath(key)) {
      if (!current.children.has(element)) {
        return;
      }
      current = current.children.get(element);
    }
    return current;
  }

  private getCanonicalNode(key: K) {
    let current = this.getRootForKey(key);
    for (const element of this.keyToPath(key)) {
      current = current.children.get(element);
    }
    return current;
  }

  private getRootForKey(key: K): TrieNode<K, V> {
    if (key instanceof Set) return this.setRoot;
    if (Array.isArray(key)) return this.arrayRoot;
    return this.flatRoot;
  }

  /**
   * Convert a key to its trie path. Sets are sorted by ordinal (so an unordered
   * set has one canonical path), arrays preserve order, flat keys are a single
   * element.
   */
  private keyToPath(key: K): PathMapKeyElement[] {
    if (key instanceof Set) {
      const elements = [...key].sort(localSort);
      for (const el of elements) validateKeyElement(el);
      return elements;
    }
    if (Array.isArray(key)) {
      for (const el of key) validateKeyElement(el);
      return key as PathMapKeyElement[];
    }
    validateKeyElement(key);
    return [key as PathMapKeyElement];
  }

  private resolveCanonicalKey(canonicalKey: K | WeakRef<K & object> | undefined): K | undefined {
    if (canonicalKey instanceof WeakRef) {
      return canonicalKey.deref();
    }
    return canonicalKey;
  }
}
