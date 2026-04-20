/**
 * Plexus ClientId Namespaces — 2-bit prefix partitioning of the 53-bit safe integer space.
 *
 * ## Layout (2 leading bits + 51-bit payload)
 *
 * ```
 * Prefix  Range                              Priority   Purpose
 * 0b00    [0, 2^51)                          lowest     Regular Yjs clients
 * 0b01    [2^51, 2^52)                       low        Liminal sessions (ephemeral)
 * 0b10    [2^52, 3×2^51)                     medium     Committed-liminal (permanent)
 * 0b11    [3×2^51, 2^53)                     highest    Genesis scaffold (deterministic)
 * ```
 *
 * Each range has 2^51 values (2,251,799,813,685,248). With 51 bits of entropy per range,
 * even 10K liminal sessions consuming 13 bits leave 38 bits of random entropy —
 * p < 10^-4 for birthday collision on 10K bases.
 *
 * ## Priority (Yjs conflict resolution — higher clientId wins)
 *
 * regular < liminal < committed < genesis
 *
 * ## Namespace Conversion
 *
 * liminal → committed: add 2^51 (prefix 01 → 10)
 * committed → liminal: subtract 2^51 (prefix 10 → 01)
 *
 * This enables targeted invalidation: given a committed clientId, compute the
 * originating liminal clientId to identify which preview Items to clean up.
 */

import * as Y from "yjs";

import { murmur32 } from "./crdt-uuid.js";

// ── Namespace Constants ──────────────────────────────────────────────

/** 2^51 — the size of each namespace range and the stride between adjacent ranges. */
const RANGE_SIZE = 2 ** 51;

/** Liminal clientId range: [2^51, 2^52). Prefix 0b01. */
export const LIMINAL_BASE = RANGE_SIZE; // 2^51 = 2_251_799_813_685_248

/** Committed-liminal range: [2^52, 3×2^51). Prefix 0b10. */
export const COMMITTED_BASE = 2 * RANGE_SIZE; // 2^52

/** Genesis clientId range: [3×2^51, 2^53). Prefix 0b11. */
export const GENESIS_BASE = 3 * RANGE_SIZE; // 3 × 2^51

/** Genesis hash space size: 2^51 values. */
const GENESIS_RANGE = RANGE_SIZE;

/** Yjs regular clientIds are uint32: [0, 0xFFFFFFFF]. Fits within the regular range [0, 2^51). */
export const MAX_UINT32 = 0xff_ff_ff_ff;

// ── Namespace Discriminators ─────────────────────────────────────────

export function isRegularClientId(clientId: number): boolean {
  return clientId < LIMINAL_BASE;
}

export function isLiminalClientId(clientId: number): boolean {
  return clientId >= LIMINAL_BASE && clientId < COMMITTED_BASE;
}

export function isCommittedClientId(clientId: number): boolean {
  return clientId >= COMMITTED_BASE && clientId < GENESIS_BASE;
}

export function isGenesisClientId(clientId: number): boolean {
  return clientId >= GENESIS_BASE;
}

/**
 * Generate a 51-bit random clientId in the regular range [0, 2^51).
 *
 * Used as the base for ALL derived clientIds:
 *   regular:   X                 (doc.clientID)
 *   liminal:   X + LIMINAL_BASE (shadow.clientID, incremented per session)
 *   committed: limId + 2^51     (prefix flip 0b01 → 0b10)
 *
 * 51 bits of entropy scales to 1M+ documents without collision (p ≈ 2×10⁻⁴).
 */
export function newClientId(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return (buf[0] & 0x7_ff_ff) * 0x1_00_00_00_00 + (buf[1] >>> 0);
}

// ── Genesis ClientId ─────────────────────────────────────────────────

const SEED_HI = 0x47_45_4e; // "GEN"
const SEED_LO = 0x53_49_53; // "SIS"

/**
 * Compute a deterministic genesis clientId for a scaffold element.
 *
 * Produces a value in [GENESIS_BASE, GENESIS_BASE + 2^51) — the 0b11 prefix namespace.
 * Two independent 32-bit hashes combined into a 51-bit intermediate, constrained via modulo.
 */
export function genesisClientId(type: string, path: string[]): number {
  const canonical = `${type}\0${path.join("\0")}`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  // (hi & 0x7FFFF) keeps 19 bits; * 2^32 shifts left; + lo fills lower 32 bits = 51 bits.
  // No bitwise ops on the result — JS bitwise truncates to int32.
  const wide = (hi & 0x7_ff_ff) * 0x1_00_00_00_00 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + GENESIS_BASE;
}

// ── High-level deterministic scaffold API ────────────────────────────
//
// One throwaway Y.Doc per segment → clock is always 0 → perfectly deterministic.
// Applied via Y.applyUpdate → invisible to UndoManager.

const vectorCache = new Map<string, Uint8Array>();

function getSegmentVector(type: "map" | "array", path: string[]): Uint8Array {
  const cacheKey = `${type}\0${path.join("\0")}`;
  let vector = vectorCache.get(cacheKey);
  if (vector) return vector;

  const tmpDoc = new Y.Doc();
  tmpDoc.clientID = genesisClientId(type, path);

  if (path.length > 2) {
    Y.applyUpdate(tmpDoc, getSegmentVector("map", path.slice(0, -1)));
  }

  const parent = path.slice(1, -1).reduce<Y.Map<any>>((m, k) => m.get(k), tmpDoc.getMap(path[0]));
  parent.set(path.at(-1)!, type === "array" ? new Y.Array() : new Y.Map());

  vector = Y.encodeStateAsUpdate(tmpDoc);
  tmpDoc.destroy();
  vectorCache.set(cacheKey, vector);
  return vector;
}

/** Guard transaction.local around applyUpdate — genesis is not a remote update. */
function genesisApplyUpdate(doc: Y.Doc, update: Uint8Array): void {
  const activeTxn = (doc as any)._transaction;
  const savedLocal = activeTxn?.local;
  Y.applyUpdate(doc, update);
  if (activeTxn && savedLocal !== undefined) activeTxn.local = savedLocal;
}

export function declareDeterministicMap<V = any>(doc: Y.Doc, path: string[]): Y.Map<V> {
  if (path.length > 1) genesisApplyUpdate(doc, getSegmentVector("map", path));
  return path.slice(1).reduce<Y.Map<any>>((m, k) => m.get(k), doc.getMap(path[0])) as Y.Map<V>;
}

export function declareDeterministicArray<V = any>(doc: Y.Doc, path: string[]): Y.Array<V> {
  if (path.length > 1) genesisApplyUpdate(doc, getSegmentVector("array", path));
  return path.slice(1).reduce<any>((m, k) => m.get(k), doc.getMap(path[0])) as Y.Array<V>;
}
