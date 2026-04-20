import { DefaultedWeakMap } from "@here.build/collections";
import type * as Y from "yjs";

import type { PlexusModel } from "./PlexusModel.js";

// Entity cache - stores weak references to PlexusModel instances by document and entity ID
export const documentEntityCaches = new DefaultedWeakMap<Y.Doc, Map<string, WeakRef<PlexusModel>>>(
  () => new Map<string, WeakRef<PlexusModel>>(),
);
