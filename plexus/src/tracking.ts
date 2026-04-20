/**
 * Granular field-level tracking system built into plexus core.
 *
 * Provides trackAccess/trackModification primitives that Plexus decorators call
 * on every field read/write. External reactive systems (MobX) plug in via trackingHook.
 *
 * Field Access Types:
 * - val: root entity + field access
 * - map: root entity + field access + keyset access + property access + "access all"
 * - list: root entity + field access + length access + index access + "access all"
 */

import type { AllowedYJSMapKey } from "./proxy-runtime-types.js";
import { flushNotifications, isTransacting, pendingNotifications } from "./utils/utils.js";

// Special symbols for tracking comprehensive access patterns
export const ACCESS_ALL_SYMBOL = Symbol("ACCESS_ALL");

/**
 * Semantic tracking symbols for collections (Set, Map, Array, Record)
 * Some cases require specific trigger conditions to avoid false-positives:
 * - KEYS_SYMBOL: Track key/index additions/removals. (has(), keys(), includes())
 * - VALUES_SYMBOL: Track value changes (get(), values(), at())
 * - ENTRIES_LENGTH_SYMBOL: Track length/size changes (size, length)
 *
 * Derivation rules:
 * - ENTRIES_LENGTH_SYMBOL fires when KEYS_SYMBOL fires (key add/remove changes length)
 * - ACCESS_ALL_SYMBOL fires on any change
 */

export const KEYS_SYMBOL = Symbol("KEYS");
export const VALUES_SYMBOL = Symbol("VALUES");
export const ENTRIES_LENGTH_SYMBOL = Symbol("ENTRIES_LENGTH");

export type Tracker = string | symbol | AllowedYJSMapKey;

let untracked = false;
/** @protected internal method to suppress tracking during specific operations */
export const __untracked__ = <T>(fn: () => T): T => {
  const wasUntracked = untracked;
  untracked = true;
  try {
    return fn();
  } finally {
    if (!wasUntracked) {
      untracked = false;
    }
  }
};

type TrackingHook = {
  access?: (entity: any, field: Tracker) => void;
  modification?: (entity: any, field: Tracker) => void;
};

export const trackingHook: TrackingHook = {};

/** Report a field access — external reactive systems (MobX) track dependencies via the hook. */
export function trackAccess(entity: any, field: Tracker): void {
  trackingHook.access?.(entity, field);
}

/** Report a field modification — external reactive systems (MobX) invalidate dependents via the hook. */
export function trackModification(entity: any, field: Tracker): void {
  if (untracked) return;
  if (trackingHook.modification) {
    if (isTransacting) {
      pendingNotifications.add(() => {
        trackingHook.modification!(entity, field);
      });
    } else {
      trackingHook.modification(entity, field);
    }
  }
  if (!isTransacting) {
    flushNotifications();
  }
}
