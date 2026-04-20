/**
 * CRDT-Native UUID Tests
 *
 * Tests the prefix-discriminated UUID encoding:
 *   'p' + Feistel body (user-generated entities)
 *   'd' + packed body (deterministic genesis entities)
 *
 * Pure codec tests — no Yjs dependency.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decode, encode, murmur32 } from "../../crdt-uuid.js";
import { COMMITTED_BASE, GENESIS_BASE, LIMINAL_BASE } from "../../genesis-client.js";

// ── Arbitraries ──

const uint32 = fc.integer({ min: 0, max: 0xff_ff_ff_ff });

// Genesis clientIds: [GENESIS_BASE, GENESIS_BASE + 2^51)
const genesisClientId = fc.integer({ min: GENESIS_BASE, max: GENESIS_BASE + 2 ** 51 - 1 });
const genesisClock = uint32; // no cap in new scheme

// Liminal clientIds: [LIMINAL_BASE, LIMINAL_BASE + 2^51)
const liminalClientId = fc.integer({ min: LIMINAL_BASE, max: LIMINAL_BASE + 2 ** 51 - 1 });
const liminalClock = uint32;

describe("CRDT-Native UUID Codec", () => {
  describe("Feistel encode/decode roundtrip ('p' prefix)", () => {
    it("roundtrips with basic values", () => {
      const { clientId, clock } = decode(encode(1, 0));
      expect(clientId).toBe(1);
      expect(clock).toBe(0);
    });

    it("roundtrips with clock=0", () => {
      const result = decode(encode(42, 0));
      expect(result.clientId).toBe(42);
      expect(result.clock).toBe(0);
    });

    it("roundtrips with max uint32 clientId", () => {
      const result = decode(encode(0xff_ff_ff_ff, 12_345));
      expect(result.clientId).toBe(0xff_ff_ff_ff);
      expect(result.clock).toBe(12_345);
    });

    it("roundtrips with max uint32 clock", () => {
      const result = decode(encode(7, 0xff_ff_ff_ff));
      expect(result.clientId).toBe(7);
      expect(result.clock).toBe(0xff_ff_ff_ff);
    });

    it("roundtrips any (clientId, clock) pair (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          const result = decode(encode(clientId, clock));
          return result.clientId === clientId >>> 0 && result.clock === clock >>> 0;
        }),
      );
    });

    it("always produces 'p' prefix (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          return encode(clientId, clock)[0] === "p";
        }),
      );
    });
  });

  describe("Genesis encode/decode roundtrip ('d' prefix)", () => {
    it("roundtrips basic genesis values", () => {
      const clientId = GENESIS_BASE; // smallest genesis clientId
      const result = decode(encode(clientId, 0));
      expect(result.clientId).toBe(clientId);
      expect(result.clock).toBe(0);
    });

    it("roundtrips max genesis values", () => {
      const clientId = GENESIS_BASE + 2 ** 51 - 1;
      const clock = 0xff_ff_ff_ff;
      const result = decode(encode(clientId, clock));
      expect(result.clientId).toBe(clientId);
      expect(result.clock).toBe(clock);
    });

    it("roundtrips any genesis (clientId, clock) pair (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          const result = decode(encode(clientId, clock));
          return result.clientId === clientId && result.clock === clock;
        }),
      );
    });

    it("always produces 'd' prefix (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          return encode(clientId, clock)[0] === "d";
        }),
      );
    });

  });

  describe("output format", () => {
    it("plexus UUIDs: always 15 chars, p + base63 (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          const uuid = encode(clientId, clock);
          return uuid.length === 15 && /^p\w{14}$/.test(uuid);
        }),
      );
    });

    it("genesis UUIDs: always 15 chars, d + base63 (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          const uuid = encode(clientId, clock);
          return uuid.length === 15 && /^d\w{14}$/.test(uuid);
        }),
      );
    });

    it("liminal UUIDs: always 15 chars, l + base63 (fuzz)", () => {
      fc.assert(
        fc.property(liminalClientId, liminalClock, (clientId, clock) => {
          const uuid = encode(clientId, clock);
          return uuid.length === 15 && /^l\w{14}$/.test(uuid);
        }),
      );
    });
  });

  describe("collision resistance", () => {
    it("sequential clocks produce different UUIDs", () => {
      const uuids = new Set<string>();
      for (let clock = 0; clock < 1000; clock++) {
        uuids.add(encode(1, clock));
      }
      expect(uuids.size).toBe(1000);
    });

    it("different clients produce different UUIDs", () => {
      const uuids = new Set<string>();
      for (let clientId = 0; clientId < 1000; clientId++) {
        uuids.add(encode(clientId, 0));
      }
      expect(uuids.size).toBe(1000);
    });

    it("p-prefix encode is injective (fuzz)", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(uint32, uint32), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });

    it("d-prefix encode is injective (fuzz)", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(genesisClientId, genesisClock), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });

    it("l-prefix encode is injective (fuzz)", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(liminalClientId, liminalClock), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });

    it("p, l, and d prefixes never collide", () => {
      const pUuid = encode(1, 0);
      const lUuid = encode(LIMINAL_BASE + 1, 0);
      const dUuid = encode(GENESIS_BASE, 0);
      expect(pUuid[0]).toBe("p");
      expect(lUuid[0]).toBe("l");
      expect(dUuid[0]).toBe("d");
      expect(new Set([pUuid, lUuid, dUuid]).size).toBe(3);
    });
  });

  describe("committed-range rejection", () => {
    it("encode throws for committed-range clientIds", () => {
      expect(() => encode(COMMITTED_BASE, 0)).toThrow("committed-range");
      expect(() => encode(COMMITTED_BASE + 1, 0)).toThrow("committed-range");
      expect(() => encode(COMMITTED_BASE + 2 ** 51 - 1, 0)).toThrow("committed-range");
    });

    it("committed range does not silently produce a broken roundtrip", () => {
      // This is the specific bug that was fixed: encode used prefix 'p' with
      // COMMITTED_BASE, but decode used base=0 for 'p', so the roundtrip
      // recovered (clientId - COMMITTED_BASE) instead of clientId.
      // Now encode throws instead of silently corrupting.
      const clientId = COMMITTED_BASE + 42;
      expect(() => encode(clientId, 7)).toThrow();
    });

    it("adjacent ranges are correctly discriminated", () => {
      // Regular range: just below LIMINAL_BASE
      expect(encode(LIMINAL_BASE - 1, 0)[0]).toBe("p");
      // Liminal range: at LIMINAL_BASE
      expect(encode(LIMINAL_BASE, 0)[0]).toBe("l");
      // Liminal range: just below COMMITTED_BASE
      expect(encode(COMMITTED_BASE - 1, 0)[0]).toBe("l");
      // Committed range: at COMMITTED_BASE — throws
      expect(() => encode(COMMITTED_BASE, 0)).toThrow();
      // Genesis range: at GENESIS_BASE
      expect(encode(GENESIS_BASE, 0)[0]).toBe("d");
    });
  });

  describe("murmur32 properties", () => {
    it("always returns uint32 (fuzz)", () => {
      fc.assert(
        fc.property(fc.string(), uint32, (key, seed) => {
          const h = murmur32(key, seed);
          return h >= 0 && h <= 0xff_ff_ff_ff && h >>> 0 === h;
        }),
      );
    });

    it("is deterministic (fuzz)", () => {
      fc.assert(
        fc.property(fc.string(), uint32, (key, seed) => {
          return murmur32(key, seed) === murmur32(key, seed);
        }),
      );
    });

    it("different seeds produce different hashes (avalanche, fuzz)", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), uint32, uint32, (key, seedA, seedB) => {
          fc.pre(seedA !== seedB);
          return murmur32(key, seedA) !== murmur32(key, seedB);
        }),
      );
    });
  });
});
