import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { deref } from "../deref.js";
import type { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informOrphanizationSymbol,
  materializationSymbol,
  requestAdoptionSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ENTRIES_LENGTH_SYMBOL, KEYS_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeMapForField } from "../virtual-children-genesis.js";

export type MaterializedRecordProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildRecordProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedRecordProxyInitTarget) => {
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
  const backingStorage: Record<string, T> = {};
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap) {
      return;
    }
    let structureChanged = false;
    for (const key of event.keysChanged) {
      const hadKeyBefore = key in backingStorage;
      const hasKeyNow = yjsMap.has(key);

      if (hasKeyNow) {
        invariant(
          yjsMap.doc,
          `Plexus<${owner.__type__}#${owner.uuid}.${key}>: observer triggered for Y.Map without doc`,
        );
        backingStorage[key] = deref(yjsMap.doc!, yjsMap.get(key)!) as T;
        if (!hadKeyBefore) structureChanged = true;
      } else {
        delete backingStorage[key];
        if (hadKeyBefore) structureChanged = true;
      }
      trackModification(self, key);
    }
    if (structureChanged) {
      trackModification(self, KEYS_SYMBOL);
      trackModification(self, ENTRIES_LENGTH_SYMBOL);
    }
  };
  {
    const map = getYjsMap();
    if (map) {
      attachObserver(map);
      Object.assign(backingStorage, map.toJSON());
    }
  }
  // We still need to track proxy target state even when we're materialized as it's important for property descriptors.
  // We cannot do dynamic proxy for them so we have to control it directly. Some decisions will look weird without that fact.
  const self = new Proxy(backingStorage, {
    get(proxyTarget, elementKey) {
      switch (elementKey) {
        case "clear":
          return () => {
            if (Object.keys(proxyTarget).length === 0) {
              return;
            }
            // Clear parent tracking for all child values
            if (isChildField) {
              for (const value of Object.values(proxyTarget)) {
                value?.[informOrphanizationSymbol]?.();
              }
            }

            for (const key of Object.keys(proxyTarget)) {
              delete proxyTarget[key];
            }
            getYjsMap()?.clear();
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign":
          return (newEntries: Record<string, AllowedYJSValue> | Iterable<[string, AllowedYJSValue]>) => {
            ensureYjsMap(); // create container outside tracked transaction
            maybeTransacting(owner.__doc__, () => {
              // Convert to array for multiple iterations
              const entriesArray: [string, AllowedYJSValue][] = [
                ...(Symbol.iterator in newEntries ? newEntries : Object.entries(newEntries)),
              ];

              // For child fields, calculate what needs to be adopted/orphaned
              // and VALIDATE all adoptions BEFORE any state changes
              const oldValueSet = new Set(Object.values(proxyTarget));
              const newValueSet = new Set(entriesArray.map(([_, v]) => v));

              if (isChildField) {
                // VALIDATE FIRST: Check all truly new values can be adopted
                for (const [k, v] of entriesArray) {
                  if (v && !oldValueSet.has(v as any)) {
                    v[validateAdoptionSymbol]?.(owner, key, k);
                  }
                }

                // Now safe to orphan values that aren't in the new set
                for (const value of oldValueSet) {
                  if (value && !newValueSet.has(value)) {
                    value[informOrphanizationSymbol]?.();
                  }
                }
              }

              for (const k of Object.keys(proxyTarget)) {
                delete proxyTarget[k];
              }
              Object.assign(proxyTarget, Object.fromEntries(entriesArray));

              const map = getYjsMap();
              map?.clear();

              trackModification(self, ACCESS_ALL_SYMBOL);
              for (const [k, v] of entriesArray) {
                // Adopt truly new values
                if (isChildField && v && !oldValueSet.has(v as any)) {
                  v[requestAdoptionSymbol]?.(owner, key, k);
                }
                map?.set(k, maybeReference(v, owner.__doc__!));
              }
            });
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap();
            if (!map) {
              // Container absent or removed (e.g., by undo) — clear the proxy
              for (const k of Object.keys(backingStorage)) {
                delete backingStorage[k];
              }
              return;
            }
            Object.assign(
              backingStorage,
              Object.fromEntries(Object.entries(map.toJSON()).map(([key, value]) => [key, deref(map.doc!, value)])),
            );
            attachObserver(map);
          };
      }

      // Well-known Symbol support for record/map - intentionally preserved as switch to represent flat routing
      if (typeof elementKey === "symbol") {
        // eslint-disable-next-line sonarjs/no-small-switch
        switch (elementKey) {
          case Symbol.toStringTag:
            return "Object";
        }
      }

      if (elementKey in Object.prototype) {
        // Accessing Object prototype methods. Todo make more precise
        if (typeof Object.prototype[elementKey] === "function") {
          return function (this: any, ...args) {
            if (this === self) {
              trackAccess(owner, key);
              trackAccess(self, ACCESS_ALL_SYMBOL);
            }
            return Object.prototype[elementKey].apply(self, args);
          };
        } else {
          trackAccess(owner, key);
          trackAccess(self, ACCESS_ALL_SYMBOL);
          return Object.prototype[elementKey];
        }
      } else if (typeof elementKey === "string") {
        // Specific field access
        trackAccess(owner, key);
        trackAccess(self, elementKey);
        // we intentionally treat undefined as null for smaller yjs doc size and consistency
        // (as we do not differentiate missing field and empty field anywhere but in `has`)
        return proxyTarget[elementKey];
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        if (value !== undefined) ensureYjsMap();
        maybeTransacting(owner.__doc__, () => {
          trackModification(self, elementKey);
          // Track key changes: key added (wasn't present, now has value) or removed (was present, now undefined)
          if (
            (elementKey in proxyTarget && value === undefined) ||
            (!(elementKey in proxyTarget) && value !== undefined)
          ) {
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
          }
          if (isChildField) {
            // VALIDATE FIRST before any state changes (throws on cycle)
            value?.[validateAdoptionSymbol]?.(owner, key, elementKey);
            // Now safe to orphan old value and adopt new one
            proxyTarget[elementKey]?.[requestOrphanizationSymbol]?.();
            value?.[requestAdoptionSymbol]?.(owner, key, elementKey);
          }
          // undefined = delete key, null = explicit "nothing" value
          if (value === undefined) {
            delete proxyTarget[elementKey];
          } else {
            proxyTarget[elementKey] = value;
          }
          if (value === undefined) {
            getYjsMap()?.delete(elementKey);
          } else {
            getYjsMap()?.set(elementKey, maybeReference(value, owner.__doc__!));
          }
        });
        return true;
      }
      console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
      return false;
    },
    deleteProperty(proxyTarget, elementKey) {
      // noinspection SuspiciousTypeOfGuard
      if (typeof elementKey === "symbol") {
        return true;
      }
      if (!Object.hasOwn(proxyTarget, elementKey)) {
        return true;
      }

      return maybeTransacting(owner.__doc__, () => {
        // Handle parent tracking for child fields
        if (isChildField) {
          proxyTarget[elementKey]?.[informOrphanizationSymbol]?.();
        }
        getYjsMap()?.delete(elementKey);
        if (Reflect.deleteProperty(proxyTarget, elementKey)) {
          trackModification(self, elementKey);
          trackModification(self, KEYS_SYMBOL);
          trackModification(self, ENTRIES_LENGTH_SYMBOL);
        }
        return true;
      });
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(proxyTarget, elementKey) {
      if (typeof elementKey === "symbol") {
        return false;
      }
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.ownKeys(proxyTarget);
    },
  });
  return self as Record<string, T> & ReadonlyField<Record<string, T>>;
};
