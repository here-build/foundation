import type * as Y from "yjs";

import { deref } from "../deref.js";
import type { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informOrphanizationSymbol,
  materializationSymbol,
  requestAdoptionSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ENTRIES_LENGTH_SYMBOL, KEYS_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeMapForField } from "../virtual-children-genesis.js";
import { serializeKey, deserializeKey } from "./key-serialization.js";

export type MaterializedSetProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildSetProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedSetProxyInitTarget) => {
  const backingSet = new Set<T>();
  // Serialized key → deserialized element (for observer sync)
  const serializedToElement = new Map<string, T>();

  const getYjsMap = (): Y.Map<AllowedYValue> | null => {
    return (owner.__yjsFieldsMap__?.get(key) as Y.Map<AllowedYValue>) ?? null;
  };

  const attachObserver = (map: Y.Map<AllowedYValue>) => {
    if (undoManagerNotifications.has(map)) return;
    map.observe(observer);
    undoManagerNotifications.set(map, observer);
  };

  const ensureYjsMap = (): Y.Map<AllowedYValue> | null => {
    const existing = getYjsMap();
    if (existing) return existing;
    if (!owner.__doc__ || !owner.__yjsFieldsMap__) return null;
    const map = materializeMapForField(owner, key);
    attachObserver(map);
    return map;
  };

  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap || !yjsMap?.doc) return;

    for (const serializedKey of event.keysChanged) {
      const hasKeyNow = yjsMap.has(serializedKey);
      if (hasKeyNow) {
        // Added
        const element = deserializeKey(serializedKey, yjsMap.doc) as T;
        backingSet.add(element);
        serializedToElement.set(serializedKey, element);
      } else {
        // Deleted
        const element = serializedToElement.get(serializedKey);
        if (element !== undefined) {
          backingSet.delete(element);
          serializedToElement.delete(serializedKey);
        }
      }
    }
    trackModification(self, KEYS_SYMBOL);
    trackModification(self, ENTRIES_LENGTH_SYMBOL);
  };

  // Initialize from existing Y.Map
  {
    const map = getYjsMap();
    if (map?.doc) {
      attachObserver(map);
      for (const [serializedKey, v] of map.entries()) {
        const element = deserializeKey(serializedKey, map.doc!) as T;
        backingSet.add(element);
        serializedToElement.set(serializedKey, element);
      }
    }
  }

  const self = new Proxy(Object.seal(backingSet), {
    get(_, elementKey) {
      switch (elementKey) {
        case "size":
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return backingSet.size;
        case "add":
          return (value: T) => {
            if (backingSet.has(value)) return false;

            if (isChildField) {
              value?.[requestAdoptionSymbol]?.(owner, key);
            }

            backingSet.add(value);
            ensureYjsMap();
            maybeTransacting(owner.__doc__!, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              const yjsMap = getYjsMap();
              if (yjsMap && owner.__doc__) {
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.set(sk, value);
                yjsMap.set(sk, maybeReference(value, owner.__doc__!));
              }
            });
            return true;
          };
        case "clear":
          return () => {
            if (backingSet.size === 0) return;
            maybeTransacting(owner.__doc__!, () => {
              if (isChildField) {
                for (const item of backingSet) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }
              backingSet.clear();
              serializedToElement.clear();
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              getYjsMap()?.clear();
            });
          };
        case "assign":
          return (newValues: Iterable<T>) => {
            const newValuesSet = new Set(newValues);
            if (newValuesSet.size > 0) ensureYjsMap();
            const yjsMap = getYjsMap();
            maybeTransacting(owner.__doc__, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);

              if (isChildField) {
                // Validate all new adoptions first
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[validateAdoptionSymbol]?.(owner, key);
                  }
                }
                // Orphan removed values
                for (const item of backingSet) {
                  if (item && !newValuesSet.has(item)) {
                    item[informOrphanizationSymbol]?.();
                  }
                }
              }

              // Clear Y.Map
              yjsMap?.clear();
              backingSet.clear();
              serializedToElement.clear();

              // Adopt new values
              if (isChildField) {
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[requestAdoptionSymbol]?.(owner, key);
                  }
                }
              }

              // Populate
              for (const value of newValuesSet) {
                backingSet.add(value);
                if (yjsMap && owner.__doc__) {
                  const sk = serializeKey(value, owner.__doc__);
                  serializedToElement.set(sk, value);
                  yjsMap.set(sk, maybeReference(value, owner.__doc__!));
                }
              }
            });
          };
        case "delete":
          return (value: T) => {
            if (!backingSet.delete(value)) return false;

            if (isChildField) {
              value?.[informOrphanizationSymbol]?.();
            }

            maybeTransacting(owner.__doc__, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              if (owner.__doc__) {
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.delete(sk);
                getYjsMap()?.delete(sk);
              }
            });
            return true;
          };
        case "entries":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingSet.entries();
          };
        case "values":
        case "keys":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingSet.values();
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingSet[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Set";
        case "forEach":
          return (callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            // eslint-disable-next-line unicorn/no-array-method-this-argument,unicorn/no-array-for-each
            return backingSet.forEach(callbackfn, thisArg);
          };
        case "has":
          return (value: T) => {
            trackAccess(owner, key);
            trackAccess(self, KEYS_SYMBOL);
            return backingSet.has(value);
          };
        case "union":
        case "intersection":
        case "difference":
        case "symmetricDifference":
          return (other: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingSet[elementKey](other);
          };
        case "isDisjointFrom":
        case "isSubsetOf":
        case "isSupersetOf":
          return (other: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingSet[elementKey](other);
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap();
            if (!map?.doc) {
              backingSet.clear();
              serializedToElement.clear();
              return;
            }
            // Re-sync from Y.Map
            backingSet.clear();
            serializedToElement.clear();
            for (const [serializedKey] of map.entries()) {
              const element = deserializeKey(serializedKey, map.doc!) as T;
              backingSet.add(element);
              serializedToElement.set(serializedKey, element);
            }
            attachObserver(map);
          };
        default:
          return false;
      }
    },
  });
  return self as Set<T> & ReadonlyField<Set<T>>;
};
