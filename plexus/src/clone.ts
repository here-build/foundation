import invariant from "tiny-invariant";

import type { ConcretePlexusConstructor } from "./PlexusModel.js";
import { getInternals, PlexusModel, safeUuid } from "./PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue } from "./proxy-runtime-types.js";
import { __untracked__, ACCESS_ALL_SYMBOL, trackAccess } from "./tracking.js";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

export function isInCloneTransaction(): boolean {
  return cloneTransactionMapping !== null;
}

const postMappingFill = new Set<() => void>();

// Temporary storage for child-map entries during clone transaction
// Keyed by object identity (WeakMap<model, Map<fieldKey, entries>>) instead of UUID strings
let childMapTempEntries: WeakMap<PlexusModel, Map<string, [AllowedYJSMapKey, AllowedYJSValue][]>> | null = null;

/**
 * Cloning is following the behavior from many other libraries.
 * Most of the things are pretty simple and based on "if it's child it should be cloned too",
 * except one edge case that caused this logic bloat:
 * class Model {
 *     @syncing accessor nonChild: ChildModel;
 *     @syncing.child accessor child: ChildModel;
 * }
 *
 * Plexus allows same entity to be used in both places for sane reasons (e.g. primaryVariant: Variant, variants: Variant[])
 * and it was causing weird things happening initially, because primaryVariant was preserved from old entity during clone.
 * Only correct solution (that is executed by e.g. Immer) here is this:
 * - we gather everything we're going to clone
 * - we assign them into cloneTransactionMapping (by doing empty constructor spawn - before we start fields traversal)
 * - we run recursive clone on child-fields (fields that produce new entities), prefilling cloneTransactionMapping
 * - then we execute normal fields
 *
 * current implementation may be buggy (needs research) on specific edge case:
 * class Model { @syncing accessor state = new SomeState(); } - it will be uselessly spawning fields via constructor.
 * Potential variance of what may happen is quite big so hard to predict how it can affect. Probably
 * nothing bad - yet the inverted field configuration flow in constructor is making things weird.
 */

export function clone<Model extends PlexusModel>(source: Model, newProps: Partial<Model> = {}) {
  const isTopLevel = cloneTransactionMapping === null;
  if (isTopLevel) {
    postMappingFill.clear();
    childMapTempEntries = new WeakMap();
  }
  cloneTransactionMapping ??= new WeakMap();
  if (cloneTransactionMapping.has(source)) {
    return cloneTransactionMapping.get(source);
  }
  try {
    trackAccess(source, ACCESS_ALL_SYMBOL);
    // this is vital to not pass anything at all during that phase. we need to first register cloned entity
    // in cloneTransactionMapping, then assign values to solve circular dependencies
    const clonedModel = PlexusModel.__materializeRaw__(source.constructor as ConcretePlexusConstructor<Model>);
    invariant(
      !cloneTransactionMapping.has(source),
      `Plexus<${source.__type__}#${safeUuid(source)}.clone>: source already in clone mapping`,
    );
    cloneTransactionMapping.set(source, clonedModel);
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const fieldKey of Object.keys(source.__schema__)) {
      const fieldValue = fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      // this is a shortcut - "hey, entity, we're going to clone you in full".
      // this is needed as we will be doing __untracked__ access next
      if (fieldValue && fieldValue instanceof PlexusModel) {
        trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
      }
    }
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const [fieldKey, type] of Object.entries(source.__schema__)) {
      const fieldValue = fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      __untracked__(() => {
        // we need to spawn children first to fill the tracking cache
        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- non-child types handled in postMappingFill
        switch (type) {
          case "child-val":
            clonedModel[fieldKey] = fieldValue instanceof PlexusModel ? fieldValue.clone() : fieldValue;
            break;
          case "child-list":
            clonedModel[fieldKey] = (fieldValue as any as any[]).map((item) =>
              item instanceof PlexusModel ? item.clone() : item,
            );
            break;
          case "child-set":
            clonedModel[fieldKey] = new Set(
              [...(fieldValue as any as Set<any>)].map((item) => (item instanceof PlexusModel ? item.clone() : item)),
            );
            break;
          case "child-record":
            clonedModel[fieldKey] = Object.fromEntries(
              Object.entries(fieldValue as Record<string, any>).map(([key, item]) => [
                key,
                item instanceof PlexusModel ? item.clone() : item,
              ]),
            );
            break;
          case "child-map": {
            // Phase 1: Clone VALUES only (they're owned children).
            // Keep ORIGINAL keys - they'll be remapped in postMappingFill
            // after all child entities are cloned and in cloneTransactionMapping.
            const sourceMap = fieldValue as Map<AllowedYJSMapKey, AllowedYJSValue>;
            const tempEntries: [AllowedYJSMapKey, AllowedYJSValue][] = [];
            for (const [key, value] of sourceMap.entries()) {
              const clonedValue = value instanceof PlexusModel ? value.clone() : value;
              tempEntries.push([key, clonedValue]); // Original key, cloned value
            }
            // Store for phase 2 processing, keyed by object identity + field name
            let modelEntries = childMapTempEntries!.get(clonedModel);
            if (!modelEntries) {
              modelEntries = new Map();
              childMapTempEntries!.set(clonedModel, modelEntries);
            }
            modelEntries.set(fieldKey, tempEntries);
            // Set empty map for now - will be filled in postMappingFill
            // Virtual maps: backing proxy exists already, skip assignment (set() is blocked)
            const vfPhase1 = (source.constructor as any)[Symbol.metadata]?.virtualFactories?.[fieldKey];
            if (!vfPhase1) {
              clonedModel[fieldKey] = new Map();
            }
            break;
          }
        }
      });
    }
    postMappingFill.add(() => {
      // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
      for (const [fieldKey, type] of Object.entries(source.__schema__)) {
        const fieldValue = fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
        __untracked__(() => {
          // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- child-* types (except child-map) handled in first switch
          switch (type) {
            case "val":
              clonedModel[fieldKey] = cloneTransactionMapping!.get(fieldValue) ?? fieldValue;
              break;
            case "list":
              clonedModel[fieldKey] = (fieldValue as any[]).map((item) => cloneTransactionMapping!.get(item) ?? item);
              break;
            case "record":
              clonedModel[fieldKey] = Object.fromEntries(
                Object.entries(fieldValue as Record<string, AllowedYJSValue>).map(([key, item]) => [
                  key,
                  cloneTransactionMapping!.get(item) ?? item,
                ]),
              );
              break;
            case "set":
              clonedModel[fieldKey] = new Set(
                [...(fieldValue as any as Set<AllowedYJSValue>)].map(
                  (item) => cloneTransactionMapping!.get(item) ?? item,
                ),
              );
              break;
            case "map":
              clonedModel[fieldKey] = new Map(
                (fieldValue as any as Map<AllowedYJSMapKey, AllowedYJSValue>).entries().map(([key, value]) => {
                  if (key instanceof Set) {
                    return [
                      new Set([...key].map((item) => cloneTransactionMapping!.get(item) ?? item)),
                      cloneTransactionMapping!.get(value) ?? value,
                    ];
                  } else if (Array.isArray(key)) {
                    return [
                      key.map((item) => cloneTransactionMapping!.get(item) ?? item),
                      cloneTransactionMapping!.get(value) ?? value,
                    ];
                  } else {
                    return [cloneTransactionMapping!.get(key) ?? key, cloneTransactionMapping!.get(value) ?? value];
                  }
                }),
              );
              break;
            case "child-map": {
              // Phase 2: Now that all child entities are cloned, remap keys.
              const vf = (source.constructor as any)[Symbol.metadata]?.virtualFactories?.[fieldKey];
              const tempEntries = childMapTempEntries!.get(clonedModel)?.get(fieldKey);
              if (tempEntries) {
                const finalEntries: [AllowedYJSMapKey, AllowedYJSValue][] = tempEntries.map(([key, value]) => {
                  let remappedKey: AllowedYJSMapKey;
                  if (key instanceof Set) {
                    remappedKey = new Set([...key].map((item) => cloneTransactionMapping!.get(item) ?? item));
                  } else if (Array.isArray(key)) {
                    remappedKey = key.map((item) => cloneTransactionMapping!.get(item) ?? item);
                  } else {
                    remappedKey = cloneTransactionMapping!.get(key) ?? key;
                  }
                  // Mark cloned entities as bound when going into a virtual map
                  if (vf && value instanceof PlexusModel) {
                    const internals = getInternals(value);
                    invariant(
                      !internals.isDependency,
                      `Clone: dependency entity ${safeUuid(value)} cannot be placed in a virtual map`,
                    );
                    internals.binding = "bound";
                  }
                  return [remappedKey, value]; // Value already cloned in phase 1
                });
                if (vf) {
                  // Virtual maps: use .assign() which is allowed during clone transactions
                  (clonedModel[fieldKey] as any).assign(new Map(finalEntries));
                } else {
                  clonedModel[fieldKey] = new Map(finalEntries);
                }
                childMapTempEntries!.get(clonedModel)?.delete(fieldKey);
              }
              break;
            }
          }
        });
      }
    });
    if (isTopLevel) {
      for (const fn of postMappingFill) {
        fn();
      }
      postMappingFill.clear();
    }
    return clonedModel;
  } finally {
    if (isTopLevel) {
      postMappingFill.clear();
      cloneTransactionMapping = null;
      childMapTempEntries = null;
    }
  }
}
