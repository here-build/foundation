import * as Y from "yjs";
import type { PlexusModel } from "./PlexusModel";

// we have to duplicate that class because of bundling bugs producing effectively circular imports
export class DefaultedWeakMap<K extends object, V> extends WeakMap<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

// Entity cache - stores weak references to PlexusModel instances by document and entity ID
export const documentEntityCaches = new DefaultedWeakMap<Y.Doc, Map<string, WeakRef<PlexusModel>>>(
  () => new Map<string, WeakRef<PlexusModel>>()
);
