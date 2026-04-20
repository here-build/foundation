import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import { createAtom, runInAction } from "mobx";

import { ACCESS_ALL_SYMBOL, type Tracker, trackingHook } from "../tracking.js";
import { flushNotificationsHook } from "../utils/utils.js";

/**
 * Flag to track if global MobX integration is enabled
 * @internal
 */
export let isGlobalIntegrationEnabled = false;

export const enableMobXIntegration = () => {
  if (isGlobalIntegrationEnabled) return;
  isGlobalIntegrationEnabled = true;

  const objectAllMap = new DefaultedWeakMap(() => createAtom(""));
  const objectFieldMap = new DefaultedWeakMap(() => new DefaultedMap((key: Tracker) => createAtom(String(key))));

  trackingHook.access = (entity, field) => {
    const atom = field === ACCESS_ALL_SYMBOL ? objectAllMap.get(entity) : objectFieldMap.get(entity).get(field);
    atom.reportObserved();
  };

  trackingHook.modification = (entity, field) => {
    if (field === ACCESS_ALL_SYMBOL) {
      objectAllMap.get(entity).reportChanged();
      for (const atom of objectFieldMap.get(entity).values()) {
        atom.reportChanged();
      }
    } else {
      if (objectAllMap.has(entity)) objectAllMap.get(entity).reportChanged();
      objectFieldMap.get(entity).get(field).reportChanged();
    }
  };

  flushNotificationsHook.wrapper = (flush) => runInAction(flush);
};
