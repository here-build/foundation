import type * as Y from "yjs";

import type { YPlexusNode } from "../proxy-runtime-types.js";
import { getModelTypesMap, getTypeMap } from "../yjs/getModels.js";

export const getModelsMap = (doc: Y.Doc) => {
  const outerMap = getModelTypesMap(doc);
  return {
    /** The raw outer Y.Map — for UndoManager tracking */
    raw: outerMap,
    get(uuid: string): YPlexusNode | undefined {
      for (const typeMap of outerMap.values()) {
        const node = typeMap.get(uuid);
        if (node) return node;
      }
      return undefined;
    },
    has(uuid: string): boolean {
      for (const typeMap of outerMap.values()) {
        if (typeMap.has(uuid)) return true;
      }
      return false;
    },
    set(type: string, uuid: string, value: YPlexusNode) {
      getTypeMap(doc, type).set(uuid, value);
    },
    delete(uuid: string) {
      for (const typeMap of outerMap.values()) {
        if (typeMap.has(uuid)) {
          typeMap.delete(uuid);
          return;
        }
      }
    },
  };
};
