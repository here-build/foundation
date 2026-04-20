/**
 * CRDT-Native UUID: prefix-discriminated encoding of Yjs {clientId, clock} addresses.
 *
 * Format: prefix (1 char) + body (14 chars base63) = 15 chars total.
 *
 * Prefixes:
 *   'p' — plexus (user-generated entity, clientId in regular range)
 *   'l' — liminal (ephemeral session entity, clientId in liminal range)
 *   'b' — bound (cloned into virtual map — same as 'p', reparent blocked)
 *   'd' — deterministic (genesis entity, clientId in genesis range)
 *   'a' — arbitrary (test-only, PLEXUS_UUID_MODE=arbitrary, not decodable)
 *
 * Body encodes the full {clientId, clock} pair: 51-bit clientId payload + 32-bit clock
 * = 83 bits. 63^14 ≈ 2^84 — fits with margin.
 *
 * Body alphabet: a-zA-Z0-9_ (63 chars). Valid in JS identifiers, CSS class names,
 * and member access keys. No quotes, no special chars.
 *
 * Pure module — zero Yjs imports. The UUID IS the entity's physical CRDT address,
 * decodable back to a StructStore lookup in O(log n).
 */

import invariant from "tiny-invariant";

import {
  COMMITTED_BASE,
  GENESIS_BASE,
  isGenesisClientId,
  isLiminalClientId,
  isRegularClientId,
  LIMINAL_BASE,
} from "./genesis-client.js";
import type { PlexusUUID } from "./proxy-runtime-types.js";

// ── Body alphabet: Base63 ──

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
const BODY_LEN = 14;

const DECODE_TABLE = new Uint8Array(128);
for (let i = 0; i < ALPHA.length; i++) DECODE_TABLE[ALPHA.charCodeAt(i)] = i;

// ── Murmur3-inspired 32-bit hash (used by genesis, exported) ──

export function murmur32(key: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i++) {
    let k = key.charCodeAt(i);
    k = Math.imul(k, 0xcc_9e_2d_51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b_87_35_93);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6_54_6b_64) >>> 0;
  }
  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85_eb_ca_6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2_b2_ae_35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Feistel cipher (4-round balanced network on two uint32 halves) ──
// NOT for security — for visual dispersion: sequential (clientId, clock) pairs
// produce UUIDs with no obvious pattern.

const ROUND_KEYS: [number, number, number, number] = [0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a];

function roundFn(value: number, key: number): number {
  let h = (value ^ key) >>> 0;
  h = Math.imul(h, 0x5b_d1_e9_95);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5b_d1_e9_95);
  h ^= h >>> 15;
  return h >>> 0;
}

function feistelEncrypt(L: number, R: number): [number, number] {
  L = L >>> 0;
  R = R >>> 0;
  for (let i = 0; i < 4; i++) {
    const newR = (L ^ roundFn(R, ROUND_KEYS[i])) >>> 0;
    L = R;
    R = newR;
  }
  return [L, R];
}

function feistelDecrypt(L: number, R: number): [number, number] {
  for (let i = 3; i >= 0; i--) {
    const newL = (R ^ roundFn(L, ROUND_KEYS[i])) >>> 0;
    R = L;
    L = newL;
  }
  return [L, R];
}

// ── Body encoding: {a: uint19, b: uint32, c: uint32} → 14 base63 chars ──
//
// Three components packed as a single 83-bit number:
//   a: upper 19 bits (namespace payload upper bits)
//   b: lower 32 bits (namespace payload lower bits, possibly Feistel-scrambled)
//   c: 32 bits (clock, possibly Feistel-scrambled)
//
// The encoding extracts base-63 digits from the combined value using
// mixed-radix arithmetic across two JS float64s. All intermediates
// stay within safe integer range (< 2^53).
//
// Capacity: 63^14 ≈ 2^83.8 > 2^83 ✓

function bodyEncode(a: number, b: number, c: number): string {
  // Three uint32 chunks [a (19 bits), b (32 bits), c (32 bits)] = 83-bit big number.
  // Long division by 63 extracts base-63 digits right-to-left.
  // Max intermediate: 62 × 2^32 + (2^32 - 1) ≈ 2.7×10^11, within float64 safe range.
  const chars = Array.from({ length: BODY_LEN });
  const chunks = [a, b >>> 0, c >>> 0];

  for (let i = BODY_LEN - 1; i >= 0; i--) {
    let carry = 0;
    for (let j = 0; j < 3; j++) {
      const cur = carry * 0x1_00_00_00_00 + chunks[j];
      chunks[j] = Math.floor(cur / 63);
      carry = cur % 63;
    }
    chars[i] = ALPHA[carry];
  }

  return chars.join("");
}

function bodyDecode(s: string): { a: number; b: number; c: number } {
  // Reconstruct the three chunks by multiplying by 63 and adding each digit
  const chunks = [0, 0, 0]; // hi, mid, lo

  for (let i = 0; i < BODY_LEN; i++) {
    const digit = DECODE_TABLE[s.charCodeAt(i)];
    // Long multiplication by 63 + digit across chunks
    let carry = digit;
    for (let j = 2; j >= 0; j--) {
      const cur = chunks[j] * 63 + carry;
      chunks[j] = cur >>> 0;
      carry = Math.floor(cur / 0x1_00_00_00_00);
    }
  }

  return { a: chunks[0], b: chunks[1] >>> 0, c: chunks[2] >>> 0 };
}

// ── Encode: {clientId, clock} → PlexusUUID ──

export function encode(clientId: number, clock: number, binding?: "bound"): PlexusUUID {
  // Determine prefix and base
  let prefix: string;
  let base: number;

  if (isLiminalClientId(clientId)) {
    prefix = "l";
    base = LIMINAL_BASE;
  } else if (isRegularClientId(clientId)) {
    prefix = binding === "bound" ? "b" : "p";
    base = 0;
  } else if (isGenesisClientId(clientId)) {
    prefix = "d";
    base = GENESIS_BASE;
  } else {
    // Committed-liminal range — must not be encoded as UUID.
    // Committed Items use their own clientId; entities are resolved by their original UUID.
    invariant(false, `Cannot encode committed-range clientId ${clientId} as UUID — use the original entity UUID`);
  }

  // Payload: clientId - base (up to 51 bits)
  const payload = clientId - base;
  const payloadHi = Math.floor(payload / 0x1_00_00_00_00); // upper 19 bits
  const payloadLo = payload % 0x1_00_00_00_00; // lower 32 bits

  // Feistel scramble for regular and liminal (non-hash IDs benefit from visual dispersion)
  // Genesis: already content-addressed hash — no scramble needed
  if (prefix === "d") {
    return (prefix + bodyEncode(payloadHi, payloadLo >>> 0, clock >>> 0)) as PlexusUUID;
  }

  // Feistel on (payloadLo, clock) — upper bits pass through (random base, rarely changes)
  const [fL, fR] = feistelEncrypt(payloadLo >>> 0, clock >>> 0);
  return (prefix + bodyEncode(payloadHi, fL, fR)) as PlexusUUID;
}

// ── Decode: PlexusUUID → {clientId, clock} ──

export function decode(uuid: PlexusUUID): { clientId: number; clock: number } {
  const prefix = uuid[0];
  const body = uuid.slice(1);

  invariant(body.length === BODY_LEN, `UUID body must be ${BODY_LEN} chars, got ${body.length}`);

  if (prefix === "a") {
    invariant(false, "Arbitrary UUIDs ('a' prefix) cannot be decoded — test-only");
  }

  const { a: payloadHi, b, c } = bodyDecode(body);

  let base: number;
  let payloadLo: number;
  let clock: number;

  if (prefix === "d") {
    // Genesis: no Feistel, direct
    base = GENESIS_BASE;
    payloadLo = b;
    clock = c;
  } else {
    // Regular, liminal, bound, committed: Feistel decrypt
    const [origLo, origClock] = feistelDecrypt(b, c);
    payloadLo = origLo;
    clock = origClock;

    if (prefix === "l") base = LIMINAL_BASE;
    else if (prefix === "b" || prefix === "p") base = 0;
    else invariant(false, `Unknown UUID prefix: '${prefix}'`);
  }

  const clientId = payloadHi * 0x1_00_00_00_00 + payloadLo + base;
  return { clientId, clock };
}
