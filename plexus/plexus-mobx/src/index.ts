import {createAtom} from "mobx";
import {ACCESS_ALL_SYMBOL, DefaultedMap, DefaultedWeakMap, PlexusModel, trackingHook} from "@here.build/plexus";

export * from "./observer.js";
export * from "./useObserver.js";

/**
 * Flag to track if global MobX integration is enabled
 * @internal
 */
export let isGlobalIntegrationEnabled = false;

export const enableMobXIntegration = () => {
    if (isGlobalIntegrationEnabled)
        return;
    isGlobalIntegrationEnabled = true;
    const objectAllMap = new DefaultedWeakMap(() => createAtom(""));
    const objectFieldMap = new DefaultedWeakMap(() => new DefaultedMap((key: symbol | string) => createAtom(key.toString())));
    trackingHook.access = (entity, field) => {
        const atom = field === ACCESS_ALL_SYMBOL ? objectAllMap.get(entity) : objectFieldMap.get(entity).get(field);
        atom.reportObserved();
    }
    trackingHook.modification = (entity, field) => {
        if (field === ACCESS_ALL_SYMBOL) {
            objectAllMap.get(entity).reportChanged();
            for (const atom of objectFieldMap.get(entity).values()) {
                atom.reportChanged();
            }
        } else {
            if (objectAllMap.has(entity))
                objectAllMap.get(entity).reportChanged();
            objectFieldMap.get(entity).get(field).reportChanged();
        }
    }
}
