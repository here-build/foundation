import { DefaultedMap } from "@here.build/collections";

import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue } from "../proxy-runtime-types.js";

/**
 * Validate that a value is an allowed type for map keys.
 * Throws TypeError for disallowed types.
 */
function validateKeyElement(item: unknown): void {
  const type = typeof item;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint" || item === null) {
    return; // Valid primitive
  }
  if (item instanceof PlexusModel) {
    return; // Valid model reference
  }
  if (type === "undefined") {
    throw new TypeError("undefined is not allowed as a map key element in Plexus");
  }
  if (type === "symbol") {
    throw new TypeError("Symbols are not allowed as map key elements in Plexus");
  }
  if (type === "function") {
    throw new TypeError("Functions are not allowed as map key elements in Plexus");
  }
  throw new TypeError(
    `Plain objects are not allowed as map key elements in Plexus. ` +
      `Use PlexusModel or primitives instead. Got: ${Object.prototype.toString.call(item)}`,
  );
}

// ── Two sorts for two concerns ──────────────────────────────────────────────
//
// Local sort:  process-local trie paths. Uses singleton construction ordinal.
//              Works from birth, never changes, never serialized.
//
// Shared sort: cross-peer Y.Map key serialization. Uses UUID.
//              Only called during [referenceSymbol] when all models are materialized.

/** Monotonic singleton ordinal — assigned once per object, never changes. */
let nextOrdinal = 0;
const singletonOrdinals = new WeakMap<PlexusModel, number>();
function ordinalOf(m: PlexusModel): number {
  let id = singletonOrdinals.get(m);
  if (id === undefined) {
    id = nextOrdinal++;
    singletonOrdinals.set(m, id);
  }
  return id;
}

/** Local sort for PathMap trie paths. Stable from construction — no UUID needed. */
function localSort(a: AllowedYJSValue, b: AllowedYJSValue): number {
  const aIsModel = a instanceof PlexusModel;
  const bIsModel = b instanceof PlexusModel;

  if (aIsModel && !bIsModel) return -1;
  if (!aIsModel && bIsModel) return 1;

  if (aIsModel && bIsModel) {
    return ordinalOf(a) - ordinalOf(b);
  }

  const aType = a === null ? "null" : typeof a;
  const bType = b === null ? "null" : typeof b;
  if (aType !== bType) return aType.localeCompare(bType);

  return String(a).localeCompare(String(b));
}

/**
 * Shared sort for Y.Map key serialization. Uses UUID — always available at
 * serialization time since serialization only happens after materialization.
 */
export function canonicalSort(a: AllowedYJSValue, b: AllowedYJSValue): number {
  const aIsModel = a instanceof PlexusModel;
  const bIsModel = b instanceof PlexusModel;

  if (aIsModel && !bIsModel) return -1;
  if (!aIsModel && bIsModel) return 1;

  if (aIsModel && bIsModel) {
    return a.uuid.localeCompare(b.uuid);
  }

  const aType = a === null ? "null" : typeof a;
  const bType = b === null ? "null" : typeof b;
  if (aType !== bType) return aType.localeCompare(bType);

  return String(a).localeCompare(String(b));
}

// ── Trie ────────────────────────────────────────────────────────────────────

type TrieNode<K, V> = {
  value: V | undefined;
  keyId: number | undefined;
  canonicalKey: K | WeakRef<K & object> | undefined;
  children: DefaultedMap<AllowedYJSValue, TrieNode<K, V>>;
};

const createNode = <K extends AllowedYJSMapKey, V>(): TrieNode<K, V> => ({
  value: undefined,
  keyId: undefined,
  canonicalKey: undefined,
  children: new DefaultedMap<AllowedYJSValue, TrieNode<K, V>>(createNode),
});

/**
 * PathMap - A Map implementation with structural key equality.
 *
 * Supports keys that are:
 * - PlexusModel instances (identity by object reference, singleton guarantee)
 * - Primitives (string, number, boolean, null)
 * - Set<above> (unordered - local ordinal sort for trie, UUID sort for serialization)
 * - Array<above> (ordered - sequence matters)
 *
 * Uses separate trie roots for flat/set/array keys to prevent type collisions.
 * Uses DefaultedMap (reference equality for models, value equality for primitives).
 * Maintains insertion order for iteration via stored entry list.
 */
export class PathMap<K extends AllowedYJSMapKey, V extends AllowedYJSValue> implements Map<K, V> {
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
      // this declaration has nothing to do with code logic.
      // ESLint formatter somewhy trying to turn it into yield [(key, node.value!)], breaking the code
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
   * Convert key to trie path. Sets use localSort (singleton ordinal),
   * arrays preserve order, flat keys are single-element.
   */
  private keyToPath(key: K): AllowedYJSValue[] {
    if (key instanceof Set) {
      const elements = [...key].sort(localSort);
      for (const el of elements) validateKeyElement(el);
      return elements;
    }
    if (Array.isArray(key)) {
      for (const el of key) validateKeyElement(el);
      return key;
    }
    validateKeyElement(key);
    return [key];
  }

  private resolveCanonicalKey(canonicalKey: K | WeakRef<K & object> | undefined): K | undefined {
    if (canonicalKey instanceof WeakRef) {
      return canonicalKey.deref();
    }
    return canonicalKey;
  }
}
