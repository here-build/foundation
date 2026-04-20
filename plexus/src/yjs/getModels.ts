import type * as Y from "yjs";

import { declareDeterministicMap } from "../genesis-client.js";
import type { YPlexusNode } from "../proxy-runtime-types.js";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

/** Top-level "types" map: type name → Y.Map of entities */
export const getModelTypesMap = (doc: Y.Doc) =>
  declareDeterministicMap<Y.Map<YPlexusNode>>(doc, [YJS_GLOBALS.types.key]);

/** Top-level "meta" map: well-known keys (root UUID, etc.) */
export const getMetaMap = (doc: Y.Doc) => declareDeterministicMap<string>(doc, [YJS_GLOBALS.meta.key]);

/** Top-level "dependencies" map: projectId → singular snapshot blob */
export const getDependenciesMap = (doc: Y.Doc) =>
  declareDeterministicMap<Uint8Array>(doc, [YJS_GLOBALS.dependencies.key]);

/** Deterministic type sub-map within "types" — genesis-backed, idempotent */
export const getTypeMap = (doc: Y.Doc, type: string): Y.Map<YPlexusNode> =>
  declareDeterministicMap<YPlexusNode>(doc, [YJS_GLOBALS.types.key, type]);
