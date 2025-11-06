import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { ACCESS_ALL_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";
import { PlexusModel } from "../PlexusModel";
import { undoManagerNotifications } from "../Plexus";

export type MaterializedSetProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildSetProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField
}: MaterializedSetProxyInitTarget) => {
  let backingSet = new Set<T>();
  let needsRegeneration = false;
  const getBackgingSet = () => {
    if (needsRegeneration) {
      needsRegeneration = false;
      backingSet = new Set(
        getYjsSet()!
          .toArray()
          .map((item) => deref(owner._doc!, item) as T)
      );
    }
    return backingSet;
  };
  const getYjsSet = () => owner._yjsModel?.get(key) as Y.Array<AllowedYValue> | null;
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    if (event.target !== getYjsSet()) {
      return;
    }
    needsRegeneration = true;
    // todo narrowed observer event triggers
    trackModification(self, ACCESS_ALL_SYMBOL);
  };
  const yjsSet = getYjsSet();
  yjsSet?.observe(observer);

  // Register for undo notifications
  if (yjsSet) {
    undoManagerNotifications.set(yjsSet, observer);
  }

  const self = new Proxy(Object.seal(backingSet), {
    get(_, elementKey) {
      switch (elementKey) {
        case "size":
          return getYjsSet()?.length ?? getBackgingSet().size;
        case "add":
          return (value: T) => {
            if (getBackgingSet().add(value)) {
              maybeTransacting(owner._doc!, () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
                // Update parent tracking for child fields
                if (isChildField) {
                  value?.[requestAdoptionSymbol]?.(owner, key);
                }

                // Y.Array.push expects an array of items
                getYjsSet()?.push([maybeReference(value, owner._doc!)]);
              });
              return true;
            }

            return false;
          };
        case "clear":
          return () => {
            const outputLength = getBackgingSet().size;
            if (outputLength === 0) {
              return;
            }
            maybeTransacting(owner._doc!, () => {
              getBackgingSet().clear();
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for all items
              if (isChildField) {
                for (const item of backingSet) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }

              getYjsSet()?.delete(0, outputLength);
            });
            return;
          };
        case "assign":
          return (newValues: Iterable<T>) => {
            const yjsArray = getYjsSet();

            const newValuesSet = new Set(newValues);
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for old items
              if (isChildField) {
                for (const item of backingSet) {
                  if (!newValuesSet.has(item)) {
                    item?.[informOrphanizationSymbol]?.();
                  }
                }
              }

              // Clear existing contents
              yjsArray?.delete(0, yjsArray.length);
              // Add new values
              if (isChildField) {
                for (const value of newValues) {
                  if (!backingSet.has(value)) {
                    value?.[requestAdoptionSymbol]?.(owner, key);
                  }
                }
              }
              yjsArray?.push([...newValues].map((value) => maybeReference(value, owner._doc!)));
              backingSet = newValuesSet;
            });
          };
        case "delete":
          return (value: T) => {
            const backingSet = getBackgingSet();
            if (!backingSet.delete(value)) {
              return false;
            }
            const yjsArray = getYjsSet();
            if (isChildField) {
              value?.[informOrphanizationSymbol]?.();
            }

            if (yjsArray){
              maybeTransacting(owner._doc, () => {
                // Clear parent tracking for removed item
                const index = yjsArray
                  .toArray()
                  .map((item) => deref(owner._doc!, item))
                  .indexOf(value);

                yjsArray.delete(index, 1);
              });
            }
            trackModification(self, ACCESS_ALL_SYMBOL);
            return true;
          };
        case "entries":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().entries();
          };
        case "values":
        case "keys":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().values();
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet()[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Set";
        case "forEach":
          return (callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().forEach(callbackfn, thisArg);
          };
        case "has":
          return (value: T) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().has(value);
          };
        case "intersection":
          throw new Error("not implemented yet");
        case "isDisjointFrom":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isDisjointFrom(set);
          };
        case "isSubsetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSubsetOf(set);
          };
        case "isSupersetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSupersetOf(set);
          };
        case materializationSymbol:
          return () => {
            needsRegeneration = true;
            // todo duplicate observation tracking
            const yjsSet = getYjsSet()!;
            yjsSet.observe(observer);
            // Register for undo notifications during materialization
            undoManagerNotifications.set(yjsSet, observer);
          };
        default:
          return false;
      }
    }
  });
  return self as Set<T> & ReadonlyField<Set<T>>;
};
