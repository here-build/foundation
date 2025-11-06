import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { PlexusModel } from "../PlexusModel";
import { deref } from "../deref";
import { undoManagerNotifications } from "../Plexus";

export type MaterializedRecordProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildRecordProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField
}: MaterializedRecordProxyInitTarget) => {
  const getYjsMap = () => owner._yjsModel?.get(key) as Y.Map<AllowedYValue> | null;
  let backingStorage: Record<string, T> = {};
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const map = getYjsMap();
    if (event.target !== map) {
      return;
    }
    for (const key of event.keysChanged) {
      if (!map.has(key)) {
        delete backingStorage[key];
      } else {
        backingStorage[key] = owner._deref(map.get(key)!) as T;
      }
      trackModification(self, key);
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  };
  const map = getYjsMap();

  map?.observe(observer);

  // Register for undo notifications
  if (map) {
    undoManagerNotifications.set(map, observer);
  }

  if (map) {
    const {
      [YJS_GLOBALS.modelMetadataType]: _type,
      [YJS_GLOBALS.modelMetadataParent]: _parent,
      ...model
    } = map.toJSON();
    Object.assign(backingStorage, model);
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
          return (newEntries: Record<string, PlexusModel> | Iterable<[string, PlexusModel]>) => {
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for all old values
              if (isChildField) {
                for (const value of Object.values(proxyTarget)) {
                  value?.[informOrphanizationSymbol]?.();
                }
              }

              for (const key of Object.keys(proxyTarget)) {
                delete proxyTarget[key];
              }
              Object.assign(proxyTarget, newEntries);

              const map = getYjsMap();
              map?.clear();

              if (!isChildField && !map) {
                return;
              }
              // Record object
              for (const [k, v] of Symbol.iterator in Object(newEntries)
                ? (newEntries as Iterable<[string, T]>)
                : Object.entries(newEntries as Record<string, T>)) {
                if (isChildField) {
                  v?.[requestAdoptionSymbol]?.(owner, key, k);
                }
                map?.set(k, maybeReference(v, owner._doc!));
              }
            });
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap()!;
            Object.assign(
              backingStorage,
              Object.fromEntries(Object.entries(map.toJSON()).map(([key, value]) => [key, deref(map.doc!, value)]))
            );
            map.observe(observer);
            // Register for undo notifications during materialization
            undoManagerNotifications.set(map, observer);
          };
      }

      // Well-known Symbol support for record/map
      if (typeof elementKey === "symbol") {
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
        maybeTransacting(owner._doc, () => {
          trackModification(self, elementKey);
          if ((elementKey in proxyTarget && value == null) || (!(elementKey in proxyTarget) && value != null)) {
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          }
          if (isChildField) {
            // Handle parent tracking for child fields. Clear parent tracking for old value if it exists
            proxyTarget[elementKey]?.[requestOrphanizationSymbol]?.();
          }
          if (value != null) {
            proxyTarget[elementKey] = value;
          } else {
            delete proxyTarget[elementKey];
          }
          if (isChildField) {
            // Update parent tracking for new value
            value?.[requestAdoptionSymbol]?.(owner, key, elementKey);
          }
          if (value != null) {
            getYjsMap()?.set(elementKey, maybeReference(value, owner._doc!));
          } else {
            getYjsMap()?.delete(elementKey);
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

      return maybeTransacting(owner._doc, () => {
        // Handle parent tracking for child fields
        if (isChildField) {
          proxyTarget[elementKey]?.[informOrphanizationSymbol]?.();
        }
        getYjsMap()?.delete(elementKey);
        if (Reflect.deleteProperty(proxyTarget, elementKey)) {
          trackModification(self, elementKey);
          trackModification(self, ACCESS_INDICES_SET_SYMBOL);
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
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return Reflect.ownKeys(proxyTarget);
    }
  });
  return self as Record<string, T> & ReadonlyField<Record<string, T>>;
};
