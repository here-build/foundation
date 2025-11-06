import * as Y from "yjs";
import { AllowedYJSValue, AllowedYValue, referenceSymbol, ReferenceTuple } from "../proxy-runtime-types";
import { PlexusModel } from "../PlexusModel"; // Re-export from defaulted-collections for backward compatibility

// Re-export from defaulted-collections for backward compatibility
export { DefaultedMap, DefaultedWeakMap } from "./defaulted-collections";

export function never(value: never): never {
  debugger;
  throw new Error(`Unexpected value: ${value}`);
}

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length >= 1 && val.length <= 2 && typeof val[0] === "string";

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue =>
  (val instanceof PlexusModel ? val?.[referenceSymbol]?.(doc) : val) ?? null;

export const curryMaybeReference =
  (doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    (val instanceof PlexusModel ? val[referenceSymbol](doc) : val) ?? null;

// doc transactions are rather expensive, even nested ones, and it's better to track them across the call chain efficiently
// plus it will avoid transaction events for mid-transaction stuff
const docInTransactionMotion = new WeakSet();

// Notification batching state
export let isTransacting = false;
export const pendingNotifications: Set<() => void> = new Set();

export const flushNotifications = () => {
  const toNotify = new Set(pendingNotifications);
  pendingNotifications.clear();

  // Wrap in try-catch to prevent notification errors from propagating
  for (const notify of toNotify) {
    try {
      notify();
    } catch (e) {
      // Log but don't propagate notification errors
      console.error("Error in notification callback:", e);
    }
  }
  return toNotify.size > 0;
};

export const maybeTransacting = <T>(doc: Y.Doc | null | undefined, fn: () => T): T => {
  if (!doc) {
    if (isTransacting) {
      return fn();
    } else {
      isTransacting = true;
      try {
        return fn();
      } finally {
        isTransacting = false;
        while (flushNotifications()) {}
      }
    }
  }
  const isNestedTransaction = !doc || docInTransactionMotion.has(doc);
  const wasAlreadyTransacting = isTransacting;

  if (isNestedTransaction) {
    // Shadow transaction - just execute
    return fn();
  }

  try {
    docInTransactionMotion.add(doc);

    // Set transacting flag for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = true;
    }

    let result: T;
    if (doc) {
      result = doc.transact(fn);
    } else {
      result = fn();
    }

    return result;
  } catch (error) {
    if (!wasAlreadyTransacting) {
      pendingNotifications.clear();
    }
    throw error;
  } finally {
    docInTransactionMotion.delete(doc);

    // Reset flag only for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = false;
      while (flushNotifications()) {}
    }
  }
};
