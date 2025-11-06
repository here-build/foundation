import * as Y from "yjs";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import {
  AllowedYJSValue,
  AllowedYValue,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol,
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { mutableArrayMethods } from "../globals";
import { PlexusModel } from "../PlexusModel";
import { undoManagerNotifications } from "../Plexus";

/**
 * Important implementation nuances
 *
 * Plexus is implementing dom-style parent-child ownership management.
 * Child-parent relationship is determined not only by entity, but also by field (and, for maps, subfield).
 * For obvious reasons of dynamic array nature and yjs backend presence, we do not store array keys in parent tuple,
 * but virtually we still follow that convention.
 *
 * Efficiently, this leads to organic implicit constraint of uniqueness-per-child-array.
 *
 * However, this emerges a problem of native array method intents: when array is being restructured with some
 * child being present twice, we're unable to understand the intent we should preserve, as there is no hook like
 * "before element is added".
 *
 * To mitigate it, we explicitly redefine all native mutating methods of Array.prototype to handle the actual intent.
 *
 * Important architectural decision (that may be potentially wrong):
 * if we have multiple entries of same model in addition intent for child-owning array,
 * we consider it an error as we're unable to clarify the intent. e.g.:
 * [a,b,c].push(a) - works fine
 * [a,b,c].push(a, b, a) - crashes, because we have no idea what should be the efficient order - c,b,a or c,a,b
 *
 * This works for all mutating methods that accept multiple elements as input - push, unshift, splice etc.
 *
 * To explain general strategy, specific details on parent-child tracking needs to be explained.
 * Model never controls its own _addition_ but may control its _removal_.
 * Just like in DOM, where you can do item.remove(), but you need to do parent.append(item)
 *
 * In Plexus, there is 4 internal ownership intent symbols for granular control:
 * inform adoption/orphanization intent:
 *  "you do not have parent/this is your parent now. I've done everything already, just adjust your metadata"
 * request adoption/orphanization intent is same as above PLUS remove self from old parent.
 * This is done instead of just emancipation intent symbol, because requestAdoptionSymbol intent needs
 * to conditionally execute informAdoptionSymbol internally.
 * This is general issue with complex ownership tracking systems - we need precision control of what is happening in
 * each phase of actions, and a lot of nuanced behaviors: e.g. requestOrphanizationSymbol when we're cleaning array from
 * old references will cause elements index shift, and we need to keep it in mind.
 *
 * General strategy for each of the methods in child-owning mode relies on a fact that each array mutation is some kind
 * of splice: remove 0.. elements at certain index, then add 0.. elements at same index.
 * General scenario is following (with per-method optimizations):
 * - check duplicates on input; if there are some, throw error
 * - for copyWithin and other index-pointing calls - convert index-pointing arguments to actual values
 *      to stop caring about index drift
 * - remove what is needed. that removals MAY affect insertion pointer if removed entities are before pointer.
 *      this phase should also call y.Array.delete on removals, but some profound optimization strategies are allowed
 *      - if method has removal intent, remove elements according to that intent
 *      - if there are some, remove input items from actual array state and _inform_ them they are orphaned
 *        they are not adopted yet but temporarily orphaned and in "limbo" now, so we will not accidentally remove them,
 *        when we will update the parent after the new addition
 * - put new elements at adjusted index and inform they are adopted now
 *
 * # YJS nuances
 * YJS do not provide "move" intent for array mutations. What it does provide:
 * - .delete(index, length)
 * - .insert(index, item[])
 * - .push(item[]) - push is optimized intent that is not changing searchMarker, so if possible we should use it
 *
 * There is multiple edge cases taken into account.
 * 1. push([a, a]): Throws - input contains duplicates
 * 2. arr = [a, b]; arr[2] = a: Removes 'a' from index 0, sets at index 1 (adjusted), final: [b, a]
 * 3. arr = [a, b, a]; pop(): Returns 'a' but doesn't orphanize (still exists at index 0) - impossible case but handled gracefully
 * 4. arr.copyWithin(0, 2, 4): Throws if would create duplicates like [c, d, c, d]
 * 5. splice(0, 0, a, b, a): Throws - inserting same item multiple times in input
 * 6. arr = [a, b]; splice(1, 0, a): Valid move operation - removes 'a' from index 0, adjusts index, inserts at adjusted position, final: [a, b]
 * 7. reverse/sort: No parent tracking needed - just reorders existing items
 */

// Node/JS engines prior to Set.prototype.difference support
function setDifference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const diff = (a as any).difference;
  if (typeof diff === "function") {
    return diff.call(a, b);
  }
  const res = new Set<T>();
  for (const v of a) if (!b.has(v)) res.add(v);
  return res;
}

export type MaterializedArrayProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildArrayProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField
}: MaterializedArrayProxyInitTarget) => {
  let backingArray: Array<T | null> = [];
  const getYjsArray = () => owner._yjsModel?.get(key) as Y.Array<AllowedYValue> | null;
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    const yjsArray = getYjsArray();
    if (event.target !== yjsArray) {
      return;
    }
    // todo narrowed observer event triggers
    // Update target array to maintain target-proxy parity for property descriptors
    if (yjsArray) {
      // we specifically need splice to keep pointer and thus make proxy working
      backingArray.splice(0, backingArray.length, ...yjsArray.toArray().map((item) => owner._deref(item) as T));
    }
    trackModification(self, ACCESS_ALL_SYMBOL);
  };
  const yjsArray = getYjsArray();
  yjsArray?.observe(observer);

  // Register for undo notifications
  if (yjsArray) {
    undoManagerNotifications.set(yjsArray, observer);
  }

  const self = new Proxy(backingArray, {
    // eslint-disable-next-line sonarjs/cognitive-complexity
    get(_, elementKey) {
      // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
      switch (elementKey) {
        case "push":
          // arr.push(entity) → yArray.push(entity.reference())
          //
          // EDGE CASE HANDLING:
          // 1. Duplicate Prevention: For child fields, the same child cannot appear multiple times
          //    in the same parent array. This maintains parent tracking invariant: one child, one parent position.
          //    Example: push(a, a) throws error to prevent [existing..., a, a]
          //
          // 2. Reuse Detection: If pushing an item that already exists elsewhere in the array,
          //    we call informAdoptionSymbol instead of requestAdoptionSymbol after the operation.
          //    This handles moving items within the same array (though this creates duplicates - see note).
          //    Example: arr = [a, b], push(a) → triggers reuse path but STILL creates duplicate [a, b, a]
          //    NOTE: This is legacy behavior - consider throwing on reuse to be consistent with splice/assign
          //
          // 3. Parent Tracking Sequence:
          //    - requestAdoptionSymbol: Called BEFORE push for new items
          //    - informAdoptionSymbol: Called AFTER push for reused items
          //    This ordering ensures parent refs are updated correctly for CRDT synchronization
          //
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<T>) =>
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              let reusedElements = new Set<T>();
              if (isChildField) {
                // DUPLICATE VALIDATION: Prevent same child appearing multiple times in input
                const seen = new Set<T>();
                for (const element of elements) {
                  if (element !== null && seen.has(element)) {
                    throw new Error(
                      "push cannot insert the same child multiple times, which would violate parent tracking semantics. " +
                      "A child can only appear once in a parent's child array."
                    );
                  }
                  if (element !== null) {
                    seen.add(element);
                  }

                  // REUSE DETECTION: Check if element already exists in array
                  if (backingArray.includes(element)) {
                    reusedElements.add(element);
                  }
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.push(...elements);
              for (const element of reusedElements) {
                element?.[informAdoptionSymbol](owner, key);
              }
              const yjsArray = getYjsArray();
              yjsArray?.push(elements.map((element) => maybeReference(element, owner._doc!)));
              return backingArray.length;
            });
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<T>) =>
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              let reusedElements = new Set<T>();
              if (isChildField) {
                // Validate that elements to unshift don't contain duplicates
                const seen = new Set<T>();
                for (const element of elements) {
                  if (element !== null && seen.has(element)) {
                    throw new Error(
                      "unshift cannot insert the same child multiple times, which would violate parent tracking semantics. " +
                      "A child can only appear once in a parent's child array."
                    );
                  }
                  if (element !== null) {
                    seen.add(element);
                  }

                  if (backingArray.includes(element)) {
                    reusedElements.add(element);
                  }
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.unshift(...elements);
              for (const element of reusedElements) {
                element?.[informAdoptionSymbol](owner, key);
              }
              const yjsArray = getYjsArray();
              yjsArray?.unshift(elements.map((element) => maybeReference(element, owner._doc!)));
              return backingArray.length;
            });
        case "splice": // arr.splice(index, deleteCount, ...items)
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (start: number, deleteCount?: number, ...items: Array<T>) => {
            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);

              const actualStart = start < 0 ? Math.max(backingArray.length + start, 0) : Math.min(start, backingArray.length);
              const actualDeleteCount = deleteCount === undefined ? backingArray.length - actualStart : Math.max(0, Math.min(deleteCount, backingArray.length - actualStart));

              // Track which items are being removed from the splice zone
              const removedItems = backingArray.slice(actualStart, actualStart + actualDeleteCount);

              // Detect items being moved within the same array
              // These items exist in the array outside the splice zone and need to be removed first
              const itemsToInsert = items || [];

              // For child fields, validate that items to insert don't contain duplicates
              if (isChildField && itemsToInsert.length > 0) {
                const seen = new Set<T>();
                for (const item of itemsToInsert) {
                  if (item !== null && seen.has(item)) {
                    throw new Error(
                      "splice cannot insert the same child multiple times, which would violate parent tracking semantics. " +
                      "A child can only appear once in a parent's child array."
                    );
                  }
                  if (item !== null) {
                    seen.add(item);
                  }
                }
              }

              const itemsToRemoveFirst: Array<{ item: T; index: number }> = [];
              const trulyNewItems: T[] = [];

              for (const item of itemsToInsert) {
                const existingIndex = backingArray.indexOf(item);
                if (existingIndex !== -1 && (existingIndex < actualStart || existingIndex >= actualStart + actualDeleteCount)) {
                  // Item exists elsewhere in array - needs to be removed from old position first
                  itemsToRemoveFirst.push({ item, index: existingIndex });
                } else if (!removedItems.includes(item)) {
                  // Item is truly new (not in array at all)
                  trulyNewItems.push(item);
                }
              }

              // Remove reused items from their old positions first (in reverse order to maintain indices)
              itemsToRemoveFirst.sort((a, b) => b.index - a.index);
              for (const { index } of itemsToRemoveFirst) {
                backingArray.splice(index, 1);
              }

              // Adjust splice position if we removed items before it
              let adjustedStart = actualStart;
              for (const { index } of itemsToRemoveFirst) {
                if (index < actualStart) {
                  adjustedStart--;
                }
              }

              // Now perform the splice
              const result = backingArray.splice(adjustedStart, actualDeleteCount, ...itemsToInsert);

              // Update parent tracking for child fields
              if (isChildField) {
                // Items being truly removed (not reused elsewhere) need orphanization
                const reusedItemSet = new Set(itemsToRemoveFirst.map(({ item }) => item));
                for (const item of removedItems) {
                  if (item && !reusedItemSet.has(item as T) && !itemsToInsert.includes(item as T)) {
                    item[informOrphanizationSymbol]?.();
                  }
                }

                // Truly new items need adoption
                for (const item of trulyNewItems) {
                  item?.[requestAdoptionSymbol]?.(owner, key);
                }

                // Reused items just need inform adoption (parent tracking already exists)
                for (const { item } of itemsToRemoveFirst) {
                  item?.[informAdoptionSymbol]?.(owner, key);
                }
              }

              // Sync to Y.js with optimized operations
              const yjsArray = getYjsArray();
              if (yjsArray) {
                // For reused items, we need to remove them from old positions first
                // itemsToRemoveFirst is already sorted in reverse order (line 141)
                for (const { index } of itemsToRemoveFirst) {
                  yjsArray.delete(index, 1);
                }

                // Adjust delete position if we removed items before it
                let adjustedYjsStart = actualStart;
                for (const { index } of itemsToRemoveFirst) {
                  if (index < actualStart) {
                    adjustedYjsStart--;
                  }
                }

                // Delete items from splice zone
                if (actualDeleteCount > 0) {
                  yjsArray.delete(adjustedYjsStart, actualDeleteCount);
                }

                // Insert all items
                if (itemsToInsert.length > 0) {
                  yjsArray.insert(
                    adjustedYjsStart,
                    itemsToInsert.map((element) => maybeReference(element, owner._doc!))
                  );
                }
              }

              return result;
            });
          };
        case "pop": // arr.pop() → remove last element
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            if (backingArray.length === 0) {
              return undefined;
            }

            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              const lastIndex = backingArray.length - 1;
              const removedItem = backingArray[lastIndex];

              backingArray.pop();

              // Update parent tracking - only orphanize if item doesn't exist elsewhere
              if (isChildField && removedItem) {
                const stillExists = backingArray.includes(removedItem);
                if (!stillExists) {
                  removedItem[informOrphanizationSymbol]?.();
                }
              }

              // Sync to Y.js
              const yjsArray = getYjsArray();
              if (yjsArray && yjsArray.length > 0) {
                yjsArray.delete(yjsArray.length - 1, 1);
              }

              return removedItem;
            });
          };
        case "shift": // arr.shift() → remove first element
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            if (backingArray.length === 0) {
              return undefined;
            }

            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              const removedItem = backingArray[0];

              backingArray.shift();

              // Update parent tracking - only orphanize if item doesn't exist elsewhere
              if (isChildField && removedItem) {
                const stillExists = backingArray.includes(removedItem);
                if (!stillExists) {
                  removedItem[informOrphanizationSymbol]?.();
                }
              }

              // Sync to Y.js
              const yjsArray = getYjsArray();
              if (yjsArray && yjsArray.length > 0) {
                yjsArray.delete(0, 1);
              }

              return removedItem;
            });
          };
        case "reverse": // arr.reverse() → reverse in place
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              backingArray.reverse();

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner._doc!)));
              }

              return self;
            });
          };
        case "sort": // arr.sort(compareFn) → sort in place
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (compareFn?: (a: T, b: T) => number) => {
            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              backingArray.sort(compareFn as ((a: T | null, b: T | null) => number) | undefined);

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner._doc!)));
              }

              return self;
            });
          };
        case "copyWithin": // arr.copyWithin(target, start, end) → copy elements within array
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (target: number, start: number, end?: number) => {
            return maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);

              // For child fields, check if copyWithin would create duplicates
              if (isChildField) {
                // Simulate the copyWithin operation to check for duplicates
                const tempArray = [...backingArray];
                tempArray.copyWithin(target, start, end);

                // Check if any non-null element appears more than once
                const seen = new Set<T>();
                for (const element of tempArray) {
                  if (element !== null && seen.has(element)) {
                    throw new Error(
                      "copyWithin would create duplicate child references, which violates parent tracking semantics. " +
                      "A child can only appear once in a parent's child array."
                    );
                  }
                  if (element !== null) {
                    seen.add(element);
                  }
                }
              }

              backingArray.copyWithin(target, start, end);

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner._doc!)));
              }

              return self;
            });
          };
        case "clear": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            const yjsArray = getYjsArray();
            // Clear parent tracking for all items
            if (yjsArray && isChildField) {
              for (const item of backingArray) {
                item?.[informOrphanizationSymbol]?.();
              }
            }

            backingArray.splice(0, backingArray.length);
            yjsArray?.delete(0, yjsArray.length);
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (newElements: Array<T>) => {
            if (newElements.length === backingArray.length && newElements.every((val, i) => val === backingArray[i])) {
              return;
            }
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              if (isChildField) {
                // Validate that newElements doesn't contain duplicates
                const seen = new Set<T>();
                for (const element of newElements) {
                  if (element !== null && seen.has(element)) {
                    throw new Error(
                      "assign cannot accept an array with duplicate child references, which would violate parent tracking semantics. " +
                      "A child can only appear once in a parent's child array."
                    );
                  }
                  if (element !== null) {
                    seen.add(element);
                  }
                }

                // Clear parent tracking for old items
                const removedItems = setDifference(new Set(backingArray), new Set(newElements));
                const addedItems = setDifference(new Set(newElements), new Set(backingArray));
                for (const item of removedItems) {
                  item?.[informOrphanizationSymbol]?.();
                }
                for (const item of addedItems) {
                  item?.[requestAdoptionSymbol]?.(owner, key);
                }
              }
              const yjsArray = getYjsArray();

              backingArray.splice(0, backingArray.length, ...newElements);
              yjsArray?.delete(0, yjsArray.length);
              yjsArray?.push(newElements.map((element) => maybeReference(element, owner._doc!)));
            });
          };
        case "length": // Report length access to this array
          trackAccess(owner, key);
          trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
          return backingArray.length;
        case materializationSymbol:
          return () => {
            const yjsArray = getYjsArray()!;
            const materializedItems = yjsArray.toArray().map((item) => owner._deref(item) as T);

            // DUPLICATE VALIDATION: Verify YJS data doesn't contain duplicates
            // This should never happen, but corrupted data or bugs could create this state
            if (isChildField) {
              const seen = new Set<T>();
              for (const item of materializedItems) {
                if (item !== null && seen.has(item)) {
                  throw new Error(
                    `Materialization failed: YJS array contains duplicate child references for ${owner.constructor.name}.${key}. ` +
                    `This violates parent tracking semantics. A child can only appear once in a parent's child array. ` +
                    `This indicates corrupted data or a bug in array mutation handling.`
                  );
                }
                if (item !== null) {
                  seen.add(item);
                }
              }
            }

            backingArray.splice(0, backingArray.length, ...materializedItems);
            yjsArray.observe(observer);
            // Register for undo notifications during materialization
            undoManagerNotifications.set(yjsArray, observer);
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingArray[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Array";
        case Symbol.isConcatSpreadable:
          return true;
      }

      // eslint-disable-next-line sonarjs/no-in-misuse
      if (elementKey in Array.prototype) {
        if (typeof Array.prototype[elementKey] === "function") {
          return mutableArrayMethods.has(elementKey)
            ? // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                const array = backingArray;
                const resultingArray = [...array];
                const result = resultingArray[elementKey](...args);
                if (resultingArray.length === array.length && resultingArray.every((val, i) => val === array[i])) {
                  return result;
                }

                const yjsArray = getYjsArray();
                return maybeTransacting(yjsArray?.doc, () => {
                  // DUPLICATE VALIDATION: Check if the array method created duplicates
                  // This shouldn't happen with standard array methods, but validates against potential bugs
                  if (isChildField) {
                    const seen = new Set<T>();
                    for (const item of resultingArray) {
                      if (item !== null && seen.has(item)) {
                        throw new Error(
                          `Array method '${String(elementKey)}' would create duplicate child references in ${owner.constructor.name}.${key}. ` +
                          `This violates parent tracking semantics. A child can only appear once in a parent's child array.`
                        );
                      }
                      if (item !== null) {
                        seen.add(item);
                      }
                    }
                  }

                  // Clear parent tracking for old items
                  const removedItems = setDifference(new Set(backingArray), new Set(resultingArray));
                  const addedItems = setDifference(new Set(resultingArray), new Set(backingArray));
                  for (const item of removedItems) {
                    item?.[informOrphanizationSymbol]?.();
                  }
                  for (const item of addedItems) {
                    item?.[requestAdoptionSymbol]?.(owner, key);
                  }
                  // backing array update should happen AFTER removed/added items calculation as it uses previous version of backing array
                  backingArray.splice(0, backingArray.length, ...resultingArray);
                  trackModification(self, ACCESS_ALL_SYMBOL);

                  // todo optimized update strategy
                  yjsArray?.delete(0, yjsArray.length);
                  yjsArray?.push(resultingArray.map((element) => maybeReference(element, owner._doc!)));
                  return result;
                });
              }
            : // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                // Non-mutating array methods that iterate over all elements
                trackAccess(owner, key);
                trackAccess(self, ACCESS_ALL_SYMBOL);
                return backingArray[elementKey](...args);
              };
        } else {
          // Report keyset access to this array for Array.prototype property access
          trackAccess(owner, key);
          trackAccess(self, elementKey);
          return Array.prototype[elementKey];
        }
      }
      // ARRAY ELEMENT ACCESS: arr[0] → deref(yArray.get(0))
      // Converts YJS References back to live entity objects
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          // Report specific index access
          trackAccess(owner, key);
          trackAccess(self, elementKey);
          return backingArray[parsedElementKey];
        }
      }
    },
    // eslint-disable-next-line sonarjs/cognitive-complexity
    set(_, elementKey, value) {
      return maybeTransacting(owner._doc, () => {
        trackModification(self, elementKey);
        if (elementKey === "length") {
          // Handle array length truncation
          const newLength = Number(value);
          const yjsArray = getYjsArray();
          if (Number.isSafeInteger(newLength) && newLength >= 0) {
            if (newLength < backingArray.length) {
              // eslint-disable-next-line sonarjs/no-nested-functions
              // Clear parent tracking for truncated items
              if (isChildField) {
                for (const item of backingArray.slice(newLength)) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }
              backingArray.length = newLength;

              yjsArray?.delete(newLength, yjsArray.length - newLength);
            } else if (newLength > backingArray.length) {
              const gap = [] as null[];
              while (backingArray.length + gap.length < newLength) {
                gap.push(null);
              }
              backingArray.push(...gap);
              yjsArray?.push(gap);
            }
            return true;
          }
          return false;
        }
        if (typeof elementKey === "string") {
          const parsedElementKey = Number.parseInt(elementKey);
          if (Number.isSafeInteger(parsedElementKey)) {
            if (parsedElementKey < 0) {
              console.warn(`cannot set [${parsedElementKey}] as it's below zero`);
              return false;
            } else {
              if (backingArray[parsedElementKey] === value) {
                return true;
              }
              // Fill holes with null to match YJS behavior
              while (backingArray.length < parsedElementKey) {
                backingArray.push(null as any);
              }

              // Handle parent tracking for replaced item
              let isReuse = false;
              let targetIndex = parsedElementKey;
              let reuseFromIndex = -1;
              if (isChildField) {
                // Save old item before overwriting
                const oldItem = backingArray[parsedElementKey];

                // Check if this is a reuse (value exists elsewhere in array)
                const existingIndex = backingArray.indexOf(value);
                isReuse = existingIndex !== -1 && existingIndex !== parsedElementKey;

                // If reusing an item from elsewhere in array, remove it from old position first
                // This prevents duplicates and maintains "child can only appear once" invariant
                if (isReuse) {
                  reuseFromIndex = existingIndex; // Store for YJS sync
                  backingArray.splice(existingIndex, 1);
                  // Adjust target index if we removed an item before it
                  if (existingIndex < parsedElementKey) {
                    targetIndex = parsedElementKey - 1;
                  }
                }

                // Orphanize old item if it exists and it's different from new value
                if (oldItem && oldItem !== value) {
                  oldItem?.[informOrphanizationSymbol]?.();
                }

                // For new items (not reuse), call requestAdoptionSymbol
                if (!isReuse) {
                  value?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray[targetIndex] = value;

              const yjsArray = getYjsArray();
              if (!yjsArray) {
                return true;
              }

              // Handle YJS sync
              if (isReuse && reuseFromIndex !== -1) {
                // For reused items, we removed from reuseFromIndex and set at targetIndex
                // Replicate the same operations in YJS:
                // 1. Delete from original position
                yjsArray.delete(reuseFromIndex, 1);
                // 2. Delete the item being replaced (at adjusted position after first delete)
                let adjustedTargetForDelete = targetIndex;
                if (reuseFromIndex < parsedElementKey) {
                  adjustedTargetForDelete = parsedElementKey - 1;
                }
                yjsArray.delete(adjustedTargetForDelete, 1);
                // 3. Insert new value at target
                yjsArray.insert(adjustedTargetForDelete, [maybeReference(value, owner._doc!)]);
              } else if (parsedElementKey >= yjsArray.length) {
                // Extending array
                const postfix: null[] = [];
                while (postfix.length + yjsArray.length < parsedElementKey - 1) {
                  postfix.push(null);
                }
                yjsArray.push([...postfix, maybeReference(value, owner._doc!)]);
              } else {
                // Replacing existing element
                yjsArray.delete(targetIndex, 1);
                yjsArray.insert(targetIndex, [maybeReference(value, owner._doc!)]);
              }

              // For reused items, call informAdoptionSymbol after the move
              if (isChildField && isReuse) {
                value?.[informAdoptionSymbol]?.(owner, key);
              }
            }
            return true;
          }
        }
        console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
        return false;
      });
    },
    deleteProperty() {
      return false;
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(_, elementKey) {
      if (elementKey === "length") {
        return true;
      }
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          return parsedElementKey >= 0 && parsedElementKey < backingArray.length;
        }
      }
      // eslint-disable-next-line sonarjs/no-in-misuse
      return elementKey in Array.prototype;
    },
    ownKeys(target) {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      return Reflect.ownKeys(target);
    }
  });
  return self as T[] & ReadonlyField<T[]>;
};
