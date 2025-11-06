import { isPlexusEntity } from "./proxy-runtime-types";
import { __untracked__, ACCESS_ALL_SYMBOL, trackAccess } from "./tracking";
import { type ConcretePlexusConstructor, PlexusModel } from "./PlexusModel";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

const postMappingFill = new Set<() => void>();

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
  }
  cloneTransactionMapping ??= new WeakMap();
  if (cloneTransactionMapping.has(source)) {
    return cloneTransactionMapping.get(source);
  }
  try {
    trackAccess(source, ACCESS_ALL_SYMBOL);
    // this is vital to not pass anything at all during that phase. we need to first register cloned entity
    // in cloneTransactionMapping, then assign values to solve circular dependencies
    const clonedModel = new (source.constructor as ConcretePlexusConstructor)();
    // alternative concept to consider:
    // const clonedModel = new PlexusModel();
    // Reflect.setPrototypeOf(clonedModel, source.constructor) - may work better or solve some problems on weird cases
    cloneTransactionMapping.set(source, clonedModel);
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const [fieldKey, type] of Object.entries(source._schema)) {
      const fieldValue =
        fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      if (fieldValue?.[isPlexusEntity]) {
        trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
      }
    }
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const [fieldKey, type] of Object.entries(source._schema)) {
      const fieldValue =
        fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      __untracked__(() => {
        // we need to spawn children first to fill the tracking cache
        switch (type) {
          case "child-val":
            const clonedValue =
              fieldValue instanceof PlexusModel
                ? fieldValue.clone()
                : fieldValue;
            clonedModel[fieldKey] = clonedValue;
            break;
          case "child-list":
            clonedModel[fieldKey] = (fieldValue as any as any[]).map((item) =>
              item instanceof PlexusModel ? item.clone() : item,
            );
            break;
          case "child-set":
            clonedModel[fieldKey] = new Set(
              [...(fieldValue as any as Set<any>)].map((item) =>
                item instanceof PlexusModel ? item.clone() : item,
              ),
            );
            break;
          case "child-record":
            clonedModel[fieldKey] = Object.fromEntries(
              Object.entries(fieldValue as Record<string, any>).map(
                ([key, item]) => [
                  key,
                  item instanceof PlexusModel ? item.clone() : item,
                ],
              ),
            );
            break;
        }
      });
    }
    postMappingFill.add(() => {
      // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
      for (const [fieldKey, type] of Object.entries(source._schema)) {
        const fieldValue =
          fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
        __untracked__(() => {
          switch (type) {
            case "val":
              clonedModel[fieldKey] =
                cloneTransactionMapping!.get(fieldValue) ?? fieldValue;
              break;
            case "list":
              clonedModel[fieldKey] = (fieldValue as any[]).map(
                (item) => cloneTransactionMapping!.get(item) ?? item,
              );
              break;
            case "record":
              clonedModel[fieldKey] = Object.fromEntries(
                Object.entries(fieldValue as Record<string, any>).map(
                  ([key, item]) => [
                    key,
                    cloneTransactionMapping!.get(item) ?? item,
                  ],
                ),
              );
              break;
            case "set":
              clonedModel[fieldKey] = new Set(
                [...(fieldValue as any as Set<any>)].map(
                  (item) => cloneTransactionMapping!.get(item) ?? item,
                ),
              );
              break;
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
    }
  }
}
