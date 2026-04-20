import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { deref } from "../deref.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue, AllowedYValue } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";

const SET_PREFIX = "Set";
const ARRAY_PREFIX = "Array";
const VALUE_PREFIX = "Value";

const BIGINT_REGEX = /^-?\d+n$/;

// ── Local entity namer ──────────────────────────────────────────────
// Runtime-local incremental IDs for doc-free key serialization.
// Two canonical forms exist for PlexusModel references in map keys:
//   - local:  incremental integers (lazy, doc-free, O(n) resolution)
//   - global: CRDT UUIDs via Y.Doc (shared storage, O(1) resolution)
// They can be interchanged: local IDs are always valid within the
// current runtime; global IDs are valid across peers.

let localIdCounter = 0;
const entityToLocalId = new WeakMap<PlexusModel, string>();
const localIdToEntity = new Map<string, WeakRef<PlexusModel>>();

function getOrCreateLocalId(entity: PlexusModel): string {
  let id = entityToLocalId.get(entity);
  if (!id) {
    id = `${localIdCounter++}`;
    entityToLocalId.set(entity, id);
    localIdToEntity.set(id, new WeakRef(entity));
  }
  return id;
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate that a value is an allowed primitive type.
 * Throws TypeError for disallowed types.
 */
function validatePrimitive(item: unknown): void {
  const type = typeof item;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint" || item === null) {
    return; // Valid primitive
  }
  if (item instanceof PlexusModel) {
    return; // Valid model reference
  }
  if (type === "undefined") {
    throw new TypeError("undefined is not allowed as a map key or value in Plexus");
  }
  if (type === "symbol") {
    throw new TypeError("Symbols are not allowed as map keys or values in Plexus");
  }
  if (type === "function") {
    throw new TypeError("Functions are not allowed as map keys or values in Plexus");
  }
  // Plain object
  throw new TypeError(
    `Plain objects are not allowed as map keys or values in Plexus. ` +
      `Use PlexusModel, Set, Array, or primitives instead. Got: ${Object.prototype.toString.call(item)}`,
  );
}

// ── Value serialization ─────────────────────────────────────────────

/**
 * Serialize a single value to a line (global canonical form).
 * PlexusModel → CRDT reference tuple via doc.
 */
function serializeValueGlobal(item: AllowedYJSValue, doc: Y.Doc): string {
  validatePrimitive(item);

  if (typeof item === "bigint") {
    return `${item}n`;
  }
  if (typeof item === "number") {
    if (Number.isNaN(item)) return "NaN";
    if (item === Infinity) return "Infinity";
    if (item === -Infinity) return "-Infinity";
  }
  if (item instanceof PlexusModel) {
    return JSON.stringify(item[referenceSymbol](doc));
  }
  return JSON.stringify(item);
}

/**
 * Serialize a single value to a line (local canonical form).
 * PlexusModel → local incremental ID, no doc needed.
 */
function serializeValueLocal(item: AllowedYJSValue): string {
  validatePrimitive(item);

  if (typeof item === "bigint") {
    return `${item}n`;
  }
  if (typeof item === "number") {
    if (Number.isNaN(item)) return "NaN";
    if (item === Infinity) return "Infinity";
    if (item === -Infinity) return "-Infinity";
  }
  if (item instanceof PlexusModel) {
    return JSON.stringify([getOrCreateLocalId(item)]);
  }
  return JSON.stringify(item);
}

// ── Value deserialization ───────────────────────────────────────────

/**
 * Deserialize a single line back to a value.
 * Tries local resolution first (for local IDs), then doc-based (for CRDT UUIDs).
 * Returns null for unresolvable entity references.
 */
function deserializeValueFlexible(line: string, doc: Y.Doc | null): AllowedYJSValue {
  if (BIGINT_REGEX.test(line)) {
    return BigInt(line.slice(0, -1));
  }
  if (line === "NaN") return Number.NaN;
  if (line === "Infinity") return Infinity;
  if (line === "-Infinity") return -Infinity;

  const parsed = JSON.parse(line);

  // Check if it's a reference tuple: [id] or [id, docId]
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 2 && typeof parsed[0] === "string") {
    // Try local resolution first
    const localEntity = localIdToEntity.get(parsed[0])?.deref();
    if (localEntity) return localEntity;
    // Fall back to doc-based resolution
    if (doc) return deref(doc, parsed as AllowedYValue);
    // Can't resolve
    return null as unknown as AllowedYJSValue;
  }

  return parsed;
}

// ── Key serialization (public API) ──────────────────────────────────

/**
 * Serialize a key to a string for storage.
 * Format: Type\nValue1\nValue2\n...
 *
 * When doc is available, uses global canonical form (CRDT UUIDs).
 * When doc is null, uses local canonical form (incremental IDs).
 */
export function serializeKey(key: AllowedYJSMapKey, doc: Y.Doc | null = null): string {
  const sv = doc ? (item: AllowedYJSValue) => serializeValueGlobal(item, doc) : serializeValueLocal;

  if (key instanceof Set) {
    // Serialize first (materializes entities in global mode), then sort.
    // Serialized form is deterministic and cross-peer stable.
    const lines = [...key].map(sv);
    lines.sort();
    return [SET_PREFIX, ...lines].join("\n");
  }
  if (Array.isArray(key)) {
    const lines = key.map(sv);
    return [ARRAY_PREFIX, ...lines].join("\n");
  }
  return [VALUE_PREFIX, sv(key)].join("\n");
}

/**
 * Deserialize a key from storage.
 *
 * Tries local resolution first (local IDs via WeakRef),
 * then doc-based resolution (CRDT UUIDs). Returns null for
 * unresolvable entity references.
 */
export function deserializeKey(serialized: string, doc: Y.Doc | null = null): AllowedYJSMapKey {
  const [prefix, ...lines] = serialized.split("\n");

  const dv = (line: string) => deserializeValueFlexible(line, doc);

  switch (prefix) {
    case SET_PREFIX:
      return new Set<AllowedYJSValue>(lines.map(dv));
    case ARRAY_PREFIX:
      return lines.map(dv);
    case VALUE_PREFIX:
      invariant(lines.length === 1, `Value key must have exactly one line, got ${lines.length}`);
      return dv(lines[0]);
    default:
      throw new TypeError(`Invalid prefix ${prefix} for serialized map key`);
  }
}
