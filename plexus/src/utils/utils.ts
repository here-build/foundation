import type * as Y from "yjs";

import { docPlexus, docTransactionOrigin } from "../plexus-registry.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReferenceTuple } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { telemetry } from "../telemetry.js";

/**
 * Per-doc deferred stopCapturing.
 * When entities are created, we schedule a deferred stopCapturing so that
 * creation and subsequent user modifications end up as separate undo items.
 * If another transaction starts before the deferred fires, it's cancelled
 * (the new transaction merges naturally via captureTimeout).
 */
const pendingStopCapturing = new WeakMap<Y.Doc, boolean>();

export function markEntityCreated(doc: Y.Doc): void {
  if (pendingStopCapturing.has(doc)) return; // already scheduled
  pendingStopCapturing.set(doc, true);
}

export function never(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length > 0 && val.length <= 2 && typeof val[0] === "string";

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue =>
  (val instanceof PlexusModel ? val[referenceSymbol](doc) : val) ?? null;

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

export const flushNotificationsHook: { wrapper?: (fn: () => void) => void } = {};

export const flushNotifications = () => {
  const toNotify = new Set(pendingNotifications);
  pendingNotifications.clear();

  if (telemetry.enabled) {
    telemetry.histogram("plexus.tracking.flush_batch_size", toNotify.size);
    telemetry.counter("plexus.tracking.flush");
  }

  const doFlush = () => {
    for (const notify of toNotify) {
      try {
        notify();
      } catch (error) {
        console.error("Error in notification callback:", error);
      }
    }
  };

  if (flushNotificationsHook.wrapper) {
    flushNotificationsHook.wrapper(doFlush);
  } else {
    doFlush();
  }
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
        flushNotifications();
      }
    }
  }
  const isNestedTransaction = docInTransactionMotion.has(doc);
  const wasAlreadyTransacting = isTransacting;

  if (isNestedTransaction) {
    // Shadow transaction - just execute
    return fn();
  }

  // Entering a new transaction — cancel any pending deferred stopCapturing.
  // The new transaction will merge with the previous one via captureTimeout.
  pendingStopCapturing.delete(doc);

  try {
    docInTransactionMotion.add(doc);

    // Set transacting flag for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = true;
    }

    return doc.transact(fn, docTransactionOrigin.get(doc));
  } catch (error) {
    if (!wasAlreadyTransacting) {
      pendingNotifications.clear();
    }
    throw error;
  } finally {
    docInTransactionMotion.delete(doc);

    // Reset flag only for outermost transaction
    if (!wasAlreadyTransacting) {
      // If entities were created, break the undo capture so creation
      // and subsequent modifications are separate undo items.
      // If entities were created, schedule deferred stopCapturing.
      // If the next synchronous code starts a new transaction before the
      // deferred fires, the pending flag is consumed and stopCapturing is skipped
      // (the transactions merge naturally via captureTimeout).
      if (pendingStopCapturing.has(doc)) {
        const capturedDoc = doc;
        setTimeout(() => {
          // Only fire if still pending and not mid-transaction
          if (pendingStopCapturing.has(capturedDoc) && !docInTransactionMotion.has(capturedDoc)) {
            pendingStopCapturing.delete(capturedDoc);
            try {
              docPlexus.get(capturedDoc)?.stopCapturing();
            } catch {
              /* UM may not exist during bootstrap */
            }
          }
        }, 0);
      }
      isTransacting = false;
      flushNotifications();
    }
  }
};
