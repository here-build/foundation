/**
 * Awareness Entity Serialization — transparent PlexusModel ↔ JSON roundtrip.
 *
 * On write: deep-walks the value, replacing PlexusModel instances with
 * `{ "\0": [uuid] }` or `{ "\0": [uuid, depId] }` markers.
 *
 * On read: returns a lazy Proxy tree. Entity markers resolve to live
 * PlexusModel instances on property access via deref(). Plain values
 * pass through unwrapped.
 *
 * The "\0" (null byte) key is the entity reference marker. No legitimate
 * user data uses null-byte object keys. One byte on the wire.
 */

import type * as Y from "yjs";

import { deref } from "./deref.js";
import { PlexusModel } from "./PlexusModel.js";
import type { ReferenceTuple } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";

/** The marker key for entity references in serialized awareness state. */
const REF = "\0";

/** Check if a parsed JSON value is an entity reference marker. */
const isRef = (val: unknown): val is { "\0": ReferenceTuple } =>
  val !== null && typeof val === "object" && !Array.isArray(val) && REF in val;

// ── Serialize (write boundary) ───────────────────────────────────────

/**
 * Deep-serialize a value for awareness storage.
 * PlexusModel instances become `{ "\0": [uuid, depId?] }` markers.
 * Everything else passes through (must be JSON-compatible).
 */
export function serialize(value: unknown, doc?: Y.Doc): unknown {
  if (value instanceof PlexusModel) {
    const ref = doc ? value[referenceSymbol](doc) : [value.uuid];
    return { [REF]: ref };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((v) => {
      const s = serialize(v, doc);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? mapped : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value).map(([k, v]): [string, unknown] => {
      const s = serialize(v, doc);
      if (s !== v) changed = true;
      return [k, s];
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

// ── Deserialize (read boundary, lazy) ────────────────────────────────

/** Cache: source object → deserialized proxy. */
const proxyCache = new WeakMap<object, unknown>();

/**
 * Lazy-deserialize a value from awareness storage.
 * Returns a Proxy that resolves entity markers on property access.
 * Plain primitives pass through. Proxies are cached per source object.
 */
export function deserialize(value: unknown, doc: Y.Doc): unknown {
  // Primitives: pass through
  if (value === null || typeof value !== "object") return value;

  // Entity reference marker: resolve immediately
  if (isRef(value)) {
    return deref(doc, value[REF]);
  }

  // Check proxy cache (stable identity for same source)
  const cached = proxyCache.get(value as object);
  if (cached !== undefined) return cached;

  // Array: lazy proxy
  if (Array.isArray(value)) {
    const proxy = lazyArray(value, doc);
    proxyCache.set(value, proxy);
    return proxy;
  }

  // Object: lazy proxy
  const proxy = lazyObject(value as Record<string, unknown>, doc);
  proxyCache.set(value, proxy);
  return proxy;
}

/**
 * Lazy proxy for arrays. Resolves entity markers on index access.
 * Length, iteration, and array methods work transparently.
 */
function lazyArray(source: unknown[], doc: Y.Doc): readonly unknown[] {
  return new Proxy(source, {
    get(target, prop, receiver) {
      // Numeric index: deserialize the element
      if (typeof prop === "string") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
          return deserialize(target[idx], doc);
        }
      }

      // 'length' and Symbol properties: pass through
      const val = Reflect.get(target, prop, receiver);

      // Array iteration methods need to return deserialized values.
      // Bind the method to a deserialized view.
      if (typeof val === "function" && typeof prop === "string" && arrayIterMethods.has(prop)) {
        return (...args: any[]) => {
          const resolved = target.map((v) => deserialize(v, doc));
          return (resolved as any)[prop](...args);
        };
      }

      return val;
    },
  });
}

/** Array methods that iterate elements and should return deserialized values. */
const arrayIterMethods = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "forEach",
  "reduce",
  "reduceRight",
  "includes",
  "indexOf",
  "flatMap",
  "entries",
  "values",
  Symbol.iterator,
]);

/**
 * Lazy proxy for objects. Resolves entity markers on property access.
 */
function lazyObject(source: Record<string, unknown>, doc: Y.Doc): Record<string, unknown> {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in target) {
        return deserialize(target[prop], doc);
      }
      return Reflect.get(target, prop, receiver);
    },

    // ownKeys, getOwnPropertyDescriptor: pass through to source
    // so Object.keys(), spread, etc. work
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc && typeof prop === "string" && prop in target) {
        return { ...desc, value: deserialize(target[prop], doc) };
      }
      return desc;
    },
  });
}
