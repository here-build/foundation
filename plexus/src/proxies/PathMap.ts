import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue } from "../proxy-runtime-types.js";

// ── PathMap moved to @here.build/collections ─────────────────────────────────
//
// PathMap (the structural-key trie Map) is a general collection with no Plexus
// knowledge, so it now lives in @here.build/collections next to DefaultedMap.
// Re-exported here for back-compat (materialized-map + existing imports).
//
// What stays plexus-specific is `canonicalSort` below: the cross-peer Y.Map key
// serialization order, which uses model UUIDs. PathMap's own in-memory trie uses
// a process-local ordinal sort (in collections); this UUID sort is only the
// serialization concern, used when materializing keys into a Y.Map.
export { PathMap } from "@here.build/collections";
export type { PathMapKey, PathMapKeyElement } from "@here.build/collections";

/**
 * Shared sort for Y.Map key serialization. Uses UUID — always available at
 * serialization time, since serialization only happens after materialization.
 * (PathMap's in-memory ordering uses a local ordinal instead — UUIDs aren't
 * needed there and may not exist before materialization.)
 */
export function canonicalSort(a: AllowedYJSValue, b: AllowedYJSValue): number {
  const aIsModel = a instanceof PlexusModel;
  const bIsModel = b instanceof PlexusModel;

  if (aIsModel && !bIsModel) return -1;
  if (!aIsModel && bIsModel) return 1;

  if (aIsModel && bIsModel) {
    return a.uuid.localeCompare(b.uuid);
  }

  const aType = a === null ? "null" : typeof a;
  const bType = b === null ? "null" : typeof b;
  if (aType !== bType) return aType.localeCompare(bType);

  return String(a).localeCompare(String(b));
}
