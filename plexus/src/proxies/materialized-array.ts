import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { deref } from "../deref.js";
import { PlexusDuplicateChildError } from "../errors.js";
import { mutableArrayMethods } from "../globals.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  requestAdoptionSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  trackAccess,
  trackModification,
  VALUES_SYMBOL,
} from "../tracking.js";
import { bucketCount, telemetry } from "../telemetry.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeArrayForField } from "../virtual-children-genesis.js";

// Track if we've shown the copyWithin warning for child arrays (one-time per session)
let copyWithinChildArrayWarningShown = false;

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
  isChildField,
}: MaterializedArrayProxyInitTarget) => {
  const backingArray: Array<T | null> = [];
  const getYjsArray = (): Y.Array<AllowedYValue> | null => {
    return (owner.__yjsFieldsMap__?.get(key) as Y.Array<AllowedYValue>) ?? null;
  };

  const attachObserver = (arr: Y.Array<AllowedYValue>) => {
    if (undoManagerNotifications.has(arr)) return;
    arr.observe(observer);
    undoManagerNotifications.set(arr, observer);
  };

  const ensureYjsArray = (): Y.Array<AllowedYValue> | null => {
    const existing = getYjsArray();
    if (existing) return existing;
    if (!owner.__doc__ || !owner.__yjsFieldsMap__) return null;
    const arr = materializeArrayForField(owner, key);
    attachObserver(arr);
    return arr;
  };
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    const yjsArray = getYjsArray();
    if (event.target !== yjsArray) {
      return;
    }
    invariant(
      yjsArray.doc,
      `Plexus<${owner.__type__}#${owner.uuid}.${key}>: observer triggered for Y.Array without doc`,
    );

    const oldLength = backingArray.length;
    const newItems = yjsArray.toArray().map((item) => deref<T>(yjsArray.doc!, item));
    const newLength = newItems.length;

    // Track which indices changed
    const changedIndices: number[] = [];
    const maxLen = Math.max(oldLength, newLength);
    for (let i = 0; i < maxLen; i++) {
      if (backingArray[i] !== newItems[i]) {
        changedIndices.push(i);
      }
    }

    if (telemetry.enabled) {
      // Diff cost surfaces "this proxy's remote-applied diff is the hot
      // spot" — a class of regression invisible from outside the
      // reactive layer. Bucketed so per-emit cardinality is bounded.
      telemetry.histogram("plexus.collection.observer_diff_size", changedIndices.length, {
        collection_kind: "array",
        is_child_field: isChildField ? "true" : "false",
        new_length_bucket: bucketCount(newLength),
      });
      if (changedIndices.length === 0 && oldLength === newLength) {
        // tldraw's "ops-with-no-effect" detector — observer fired but
        // produced zero observable state change. Catches runaway
        // reactive writes (the canonical useEffect-into-Y.Map class).
        telemetry.counter("plexus.collection.observer_no_effect", { collection_kind: "array" });
      }
    }

    // Update backing array
    backingArray.splice(0, backingArray.length, ...newItems);

    // Emit precise notifications
    for (const index of changedIndices) {
      trackModification(self, `${index}`);
    }

    // Emit VALUES_SYMBOL if any values changed
    if (changedIndices.length > 0) {
      trackModification(self, VALUES_SYMBOL);
    }

    // Only emit KEYS_SYMBOL if length actually changed
    if (oldLength !== newLength) {
      trackModification(self, KEYS_SYMBOL);
      trackModification(self, ENTRIES_LENGTH_SYMBOL);
    }
  };
  {
    const yjsArray = getYjsArray();
    if (yjsArray) {
      attachObserver(yjsArray);
    }
  }

  const self = new Proxy(backingArray, {
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

          return (...elements: Array<T>) => {
            ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              // Update parent tracking for child fields
              const reusedIndices: number[] = [];
              const reusedElements: T[] = [];
              const newElements: T[] = [];
              if (isChildField) {
                PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "push");

                for (const element of elements) {
                  if (element instanceof PlexusModel) {
                    const existingIndex = backingArray.indexOf(element);
                    if (existingIndex === -1) {
                      newElements.push(element);
                    } else {
                      reusedIndices.push(existingIndex);
                      reusedElements.push(element);
                    }
                  }
                }

                // VALIDATE FIRST: Check all new elements can be adopted before any state changes
                for (const element of newElements) {
                  element?.[validateAdoptionSymbol]?.(owner, key);
                }

                // Now safe to remove reused elements from their old positions (in reverse order)
                reusedIndices.sort((a, b) => b - a);
                for (const index of reusedIndices) {
                  backingArray.splice(index, 1);
                }

                for (const element of newElements) {
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.push(...elements);

              const yjsArray = getYjsArray();
              if (yjsArray) {
                for (const index of reusedIndices) {
                  yjsArray.delete(index, 1);
                }
                yjsArray.push(elements.map((element) => maybeReference(element, owner.__doc__!)));
              }

              if (isChildField) {
                for (const element of reusedElements) {
                  element?.[informAdoptionSymbol](owner, key);
                }
              }

              trackModification(self, ACCESS_ALL_SYMBOL);
              return backingArray.length;
            });
          };
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          return (...elements: Array<T>) => {
            ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              // Update parent tracking for child fields
              const reusedIndices: number[] = [];
              const reusedElements: T[] = [];
              const newElements: T[] = [];
              if (isChildField) {
                PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "unshift");

                for (const element of elements) {
                  if (element instanceof PlexusModel) {
                    const existingIndex = backingArray.indexOf(element);
                    if (existingIndex === -1) {
                      newElements.push(element);
                    } else {
                      reusedIndices.push(existingIndex);
                      reusedElements.push(element);
                    }
                  }
                }

                // VALIDATE FIRST: Check all new elements can be adopted before any state changes
                for (const element of newElements) {
                  element?.[validateAdoptionSymbol]?.(owner, key);
                }

                // Now safe to remove reused elements from their old positions
                reusedIndices.sort((a, b) => b - a);
                for (const index of reusedIndices) {
                  backingArray.splice(index, 1);
                }

                for (const element of newElements) {
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.unshift(...elements);

              if (isChildField) {
                for (const element of reusedElements) {
                  element?.[informAdoptionSymbol](owner, key);
                }
              }

              const yjsArray = getYjsArray();
              if (yjsArray) {
                for (const index of reusedIndices) {
                  yjsArray.delete(index, 1);
                }
              }
              yjsArray?.unshift(elements.map((element) => maybeReference(element, owner.__doc__!)));

              trackModification(self, ACCESS_ALL_SYMBOL);
              return backingArray.length;
            });
          };
        case "splice": // arr.splice(index, deleteCount, ...items)
          return (start: number, deleteCount?: number, ...itemsToInsert: Array<T>) => {
            if (itemsToInsert.length > 0) ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              const actualStart =
                start < 0 ? Math.max(backingArray.length + start, 0) : Math.min(start, backingArray.length);
              const actualDeleteCount =
                deleteCount === undefined
                  ? backingArray.length - actualStart
                  : Math.max(0, Math.min(deleteCount, backingArray.length - actualStart));

              // Track which items are being removed from the splice zone
              const removedItems = backingArray.slice(actualStart, actualStart + actualDeleteCount);

              // Detect items being moved within the same array
              // These items exist in the array outside the splice zone and need to be removed first

              // For child fields, validate that items to insert don't contain duplicates
              if (isChildField && itemsToInsert.length > 0) {
                PlexusDuplicateChildError.uniquenessInvariant(itemsToInsert, owner, key, "splice");
              }

              const itemsToRemoveFirst: Array<{ item: T; index: number }> = [];
              const trulyNewItems: T[] = [];

              for (const item of itemsToInsert) {
                const existingIndex = backingArray.indexOf(item);
                if (
                  existingIndex !== -1 &&
                  (existingIndex < actualStart || existingIndex >= actualStart + actualDeleteCount)
                ) {
                  // Item exists elsewhere in array - needs to be removed from old position first
                  itemsToRemoveFirst.push({ item, index: existingIndex });
                } else if (!removedItems.includes(item)) {
                  // Item is truly new (not in array at all)
                  trulyNewItems.push(item);
                }
              }

              // VALIDATION: Validate truly new items BEFORE any state modification
              // Note: itemsToRemoveFirst don't need validation since they're already in the array with correct parent
              if (isChildField) {
                for (const item of trulyNewItems) {
                  item?.[validateAdoptionSymbol]?.(owner, key);
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
                    itemsToInsert.map((element) => maybeReference(element, owner.__doc__!)),
                  );
                }
              }

              trackModification(self, ACCESS_ALL_SYMBOL);
              return result;
            });
          };
        case "pop": // arr.pop() → remove last element
          return () => {
            if (backingArray.length === 0) {
              return;
            }

            return maybeTransacting(owner.__doc__, () => {
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

              trackModification(self, ACCESS_ALL_SYMBOL);
              return removedItem;
            });
          };
        case "shift": // arr.shift() → remove first element
          return () => {
            if (backingArray.length === 0) {
              return;
            }

            return maybeTransacting(owner.__doc__, () => {
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

              trackModification(self, ACCESS_ALL_SYMBOL);
              return removedItem;
            });
          };
        case "reverse": // arr.reverse() → reverse in place
          return () => {
            ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              backingArray.reverse();

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
              }

              trackModification(self, ACCESS_ALL_SYMBOL);
              return self;
            });
          };
        case "sort": // arr.sort(compareFn) → sort in place
          return (compareFn?: (a: T, b: T) => number) => {
            ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              backingArray.sort(compareFn as ((a: T | null, b: T | null) => number) | undefined);

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
              }

              trackModification(self, ACCESS_ALL_SYMBOL);
              return self;
            });
          };
        case "copyWithin": // arr.copyWithin(target, start, end) → copy elements within array
          return (target: number, start: number, end?: number) => {
            ensureYjsArray();
            return maybeTransacting(owner.__doc__, () => {
              if (isChildField) {
                // One-time warning: copyWithin on child arrays has special semantics
                if (!copyWithinChildArrayWarningShown) {
                  copyWithinChildArrayWarningShown = true;
                  console.warn(
                    "copyWithin on child array",
                    "Using copyWithin() on a child array (fields decorated with @syncing.child.list) may throw errors if the operation would create duplicate child references. Unlike normal arrays where copyWithin always succeeds, child arrays enforce uniqueness constraints. Consider using index assignment or splice() for moving items within the array.",
                  );
                }

                // For child arrays, copyWithin respects copy semantics
                // If copying would create duplicates, throw an error
                // This is different from operations like push/splice which use move semantics

                // Simulate the copyWithin operation to check for duplicates
                const tempArray = [...backingArray];
                tempArray.copyWithin(target, start, end);

                // Check if any non-null element appears more than once
                PlexusDuplicateChildError.uniquenessInvariant(tempArray, owner, key, "copyWithin");
              }

              // If we get here, no duplicates would be created - proceed with operation
              backingArray.copyWithin(target, start, end);

              // Sync to Y.js - replace entire array
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.delete(0, yjsArray.length);
                yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
              }

              trackModification(self, ACCESS_ALL_SYMBOL);
              return self;
            });
          };
        case "clear": // arr.assign(newElements) → replace entire array contents
          return () => {
            const yjsArray = getYjsArray();
            // Clear parent tracking for all items
            if (yjsArray && isChildField) {
              for (const item of backingArray) {
                item?.[informOrphanizationSymbol]?.();
              }
            }

            backingArray.splice(0);
            yjsArray?.delete(0, yjsArray.length);
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          return (newElements: Array<T>) => {
            if (newElements.length === backingArray.length && newElements.every((val, i) => val === backingArray[i])) {
              return;
            }
            if (newElements.length > 0) ensureYjsArray();
            maybeTransacting(owner.__doc__, () => {
              if (isChildField) {
                // Validate that newElements doesn't contain duplicates
                PlexusDuplicateChildError.uniquenessInvariant(newElements, owner, key, "assign");

                // Calculate what needs to be added/removed
                const removedItems = setDifference(new Set(backingArray), new Set(newElements));
                const addedItems = setDifference(new Set(newElements), new Set(backingArray));

                // VALIDATE FIRST: Check all added items can be adopted before any state changes
                for (const item of addedItems) {
                  item?.[validateAdoptionSymbol]?.(owner, key);
                }

                // Now safe to orphan removed items and adopt added items
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
              yjsArray?.push(newElements.map((element) => maybeReference(element, owner.__doc__!)));
              trackModification(self, ACCESS_ALL_SYMBOL);
            });
          };
        case "length": // Report length access to this array
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return backingArray.length;
        case materializationSymbol:
          return () => {
            const yjsArray = getYjsArray();
            if (!yjsArray) {
              // Container absent or removed (e.g., by undo) — clear the proxy
              backingArray.splice(0);
              return;
            }
            invariant(
              yjsArray.doc,
              `Plexus<${owner.__type__}#${owner.uuid}.${key}>: materialization triggered for Y.Array without doc`,
            );
            const materializedItems = yjsArray.toArray().map((item) => deref(yjsArray.doc!, item) as T);

            // DUPLICATE VALIDATION: Verify YJS data doesn't contain duplicates
            // This should never happen, but corrupted data or bugs could create this state
            if (isChildField) {
              PlexusDuplicateChildError.uniquenessInvariant(materializedItems, owner, key, "materialization");
            }

            backingArray.splice(0, backingArray.length, ...materializedItems);
            attachObserver(yjsArray);
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
            ? (...args) => {
                const array = backingArray;
                const resultingArray = [...array];
                const result = resultingArray[elementKey](...args);
                if (resultingArray.length === array.length && resultingArray.every((val, i) => val === array[i])) {
                  return result;
                }

                ensureYjsArray();
                const yjsArray = getYjsArray();
                return maybeTransacting(yjsArray?.doc, () => {
                  // DUPLICATE VALIDATION: Check if the array method created duplicates
                  // This shouldn't happen with standard array methods, but validates against potential bugs
                  if (isChildField) {
                    PlexusDuplicateChildError.uniquenessInvariant(resultingArray, owner, key, String(elementKey));
                  }

                  // Calculate what needs to be added/removed
                  const removedItems = setDifference(new Set(backingArray), new Set(resultingArray));
                  const addedItems = setDifference(new Set(resultingArray), new Set(backingArray));

                  // VALIDATE FIRST: Check all added items can be adopted before any state changes
                  if (isChildField) {
                    for (const item of addedItems) {
                      item?.[validateAdoptionSymbol]?.(owner, key);
                    }
                  }

                  // Now safe to orphan removed items and adopt added items
                  for (const item of removedItems) {
                    item?.[informOrphanizationSymbol]?.();
                  }
                  for (const item of addedItems) {
                    item?.[requestAdoptionSymbol]?.(owner, key);
                  }
                  // backing array update should happen AFTER removed/added items calculation as it uses previous version of backing array
                  backingArray.splice(0, backingArray.length, ...resultingArray);

                  // todo optimized update strategy
                  yjsArray?.delete(0, yjsArray.length);
                  yjsArray?.push(resultingArray.map((element) => maybeReference(element, owner.__doc__!)));
                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return result;
                });
              }
            : (...args) => {
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

    set(_, elementKey, value) {
      // Ensure container exists before tracked transaction for index assignment
      if (
        typeof elementKey === "string" &&
        elementKey !== "length" &&
        Number.isSafeInteger(Number.parseInt(elementKey))
      ) {
        ensureYjsArray();
      }
      return maybeTransacting(owner.__doc__, () => {
        if (elementKey === "length") {
          // Handle array length truncation
          const newLength = Number(value);
          const yjsArray = getYjsArray();
          if (Number.isSafeInteger(newLength) && newLength >= 0) {
            if (newLength < backingArray.length) {
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
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
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

              return maybeTransacting(owner.__doc__, () => {
                // Track original length to detect extension
                const originalLength = backingArray.length;

                // Fill holes with null to match YJS behavior
                while (backingArray.length < parsedElementKey) {
                  trackModification(self, `${backingArray.length}`);
                  backingArray.push(null as any);
                }

                // Handle parent tracking for replaced item
                let isReuse = false;
                let reuseFromIndex = -1;
                let targetIndex = parsedElementKey;
                if (isChildField) {
                  // Check if this is a reuse (value exists elsewhere in array)
                  const existingIndex = backingArray.indexOf(value);
                  isReuse = existingIndex !== -1 && existingIndex !== parsedElementKey;

                  // VALIDATE FIRST: For non-reuse case, validate BEFORE any state changes
                  // This ensures we don't corrupt state if validation throws (e.g., cycle detection)
                  if (!isReuse) {
                    value?.[validateAdoptionSymbol]?.(owner, key);
                  }

                  // If reusing an item from elsewhere in array, remove it from old position first
                  // This prevents duplicates and maintains "child can only appear once" invariant
                  // Child arrays use splice semantics (compact/shift), not sparse array semantics
                  if (isReuse) {
                    reuseFromIndex = existingIndex; // Store for YJS sync
                    trackModification(self, ACCESS_ALL_SYMBOL);
                    backingArray.splice(existingIndex, 1);
                    // Adjust target index if we removed an item before it
                    if (existingIndex < parsedElementKey) {
                      targetIndex = parsedElementKey - 1;
                    }
                  }

                  // Save old item at target position (after potential splice adjustment)
                  const oldItem = backingArray[targetIndex];

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
                // Handle YJS sync
                if (yjsArray) {
                  if (isReuse && reuseFromIndex !== -1) {
                    // For reused items, we removed from reuseFromIndex and set at targetIndex
                    // Replicate the same operations in YJS:
                    // 1. Delete from original position
                    yjsArray.delete(reuseFromIndex, 1);

                    // 2. Delete the item being replaced (at adjusted position after first delete)
                    if (targetIndex >= yjsArray.length) {
                      // Extending: fill holes and append
                      const postfix: (typeof value | null)[] = [];
                      while (postfix.length + yjsArray.length < targetIndex) {
                        postfix.push(null);
                      }
                      postfix.push(maybeReference(value, owner.__doc__!));
                      // we're doing it that way to make operation atomic
                      yjsArray.push(postfix);
                    } else {
                      yjsArray.delete(targetIndex, 1);
                      // 3. Insert new value at target
                      yjsArray.insert(targetIndex, [maybeReference(value, owner.__doc__!)]);
                    }
                  } else if (parsedElementKey >= yjsArray.length) {
                    // Extending array
                    const postfix: null[] = [];
                    while (postfix.length + yjsArray.length < parsedElementKey) {
                      postfix.push(null);
                    }
                    // we're doing it that way to make operation atomic
                    yjsArray.push([...postfix, maybeReference(value, owner.__doc__!)]);
                  } else {
                    // Replacing existing element
                    yjsArray.delete(parsedElementKey, 1);
                    yjsArray.insert(parsedElementKey, [maybeReference(value, owner.__doc__!)]);
                  }
                }

                // For reused items, call informAdoptionSymbol after the move
                if (isChildField && isReuse) {
                  value?.[informAdoptionSymbol]?.(owner, key);
                }
                trackModification(self, `${targetIndex}`);

                // Emit KEYS_SYMBOL if array was extended (length changed)
                if (backingArray.length > originalLength) {
                  trackModification(self, KEYS_SYMBOL);
                  trackModification(self, ENTRIES_LENGTH_SYMBOL);
                }

                return true;
              });
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
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.ownKeys(target);
    },
  });
  return self as T[] & ReadonlyField<T[]>;
};
