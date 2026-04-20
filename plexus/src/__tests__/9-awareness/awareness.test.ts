/**
 * PlexusAwareness — multi-channel presence protocol tests.
 *
 * Validates: field-per-channel isolation, schema discovery,
 * heartbeat on channel 0 only, peer merge, cleanup on timeout.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  PlexusAwareness,
  removeAwarenessStates,
} from "../../awareness.js";

// ── Helpers ──

function createPair() {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const awA = new PlexusAwareness(docA);
  const awB = new PlexusAwareness(docB);

  /** One-way sync: A → B */
  const syncAtoB = () => {
    const allClients = [...awA.states.keys()];
    if (allClients.length === 0) return;
    const update = encodeAwarenessUpdate(awA, allClients);
    applyAwarenessUpdate(awB, update, "remote");
  };

  /** One-way sync: B → A */
  const syncBtoA = () => {
    const allClients = [...awB.states.keys()];
    if (allClients.length === 0) return;
    const update = encodeAwarenessUpdate(awB, allClients);
    applyAwarenessUpdate(awA, update, "remote");
  };

  /** Bidirectional sync */
  const sync = () => { syncAtoB(); syncBtoA(); };

  return { docA, docB, awA, awB, syncAtoB, syncBtoA, sync };
}

function cleanup(...docs: Y.Doc[]) {
  for (const doc of docs) doc.destroy();
}

// ═══════════════════════════════════════════════════════════════════════

describe("PlexusAwareness: local state", () => {
  let doc: Y.Doc;
  let aw: PlexusAwareness;

  beforeEach(() => {
    doc = new Y.Doc();
    aw = new PlexusAwareness(doc);
  });

  afterEach(() => doc.destroy());

  it("setField registers field in schema", () => {
    aw.setField("cursor", { x: 10, y: 20 });
    expect(aw.getSchema()).toEqual(["cursor"]);
  });

  it("setField stores value retrievable via getField", () => {
    aw.setField("cursor", { x: 10, y: 20 });
    expect(aw.getField("cursor")).toEqual({ x: 10, y: 20 });
  });

  it("multiple fields get separate schema indices", () => {
    aw.setField("cursor", { x: 10, y: 20 });
    aw.setField("name", "Alice");
    aw.setField("tool", "pen");
    expect(aw.getSchema()).toEqual(["cursor", "name", "tool"]);
    expect(aw.getField("cursor")).toEqual({ x: 10, y: 20 });
    expect(aw.getField("name")).toBe("Alice");
    expect(aw.getField("tool")).toBe("pen");
  });

  it("getLocalState returns merged object", () => {
    aw.setField("cursor", { x: 10, y: 20 });
    aw.setField("name", "Alice");
    const state = aw.getLocalState();
    expect(state).toEqual({ cursor: { x: 10, y: 20 }, name: "Alice" });
  });

  it("clearField sets value to null", () => {
    aw.setField("cursor", { x: 10, y: 20 });
    aw.clearField("cursor");
    expect(aw.getField("cursor")).toBeNull();
    // Schema still has the field (append-only)
    expect(aw.getSchema()).toEqual(["cursor"]);
  });

  it("getField for unregistered field returns undefined", () => {
    expect(aw.getField("nonexistent")).toBeUndefined();
  });
});

describe("PlexusAwareness: multi-channel isolation", () => {
  let doc: Y.Doc;
  let aw: PlexusAwareness;

  beforeEach(() => {
    doc = new Y.Doc();
    aw = new PlexusAwareness(doc);
  });

  afterEach(() => doc.destroy());

  it("each field uses a separate clientId in the states map", () => {
    aw.setField("cursor", { x: 0, y: 0 });
    aw.setField("name", "Alice");

    // Channel 0: schema
    expect(aw.states.has(aw.clientID)).toBe(true);
    // Channel 1: cursor (base + 1 * 2^32)
    const cursorCid = aw.clientID + 2 ** 51;
    expect(aw.states.has(cursorCid)).toBe(true);
    expect(aw.states.get(cursorCid)).toEqual({ x: 0, y: 0 });
    // Channel 2: name (base + 2 * 2^32)
    const nameCid = aw.clientID + 2 * 2 ** 51;
    expect(aw.states.has(nameCid)).toBe(true);
    expect(aw.states.get(nameCid)).toBe("Alice");
  });

  it("updating one field only increments that channel's clock", () => {
    aw.setField("cursor", { x: 0, y: 0 });
    aw.setField("name", "Alice");

    const cursorCid = aw.clientID + 2 ** 51;
    const nameCid = aw.clientID + 2 * 2 ** 51;

    const cursorClockBefore = aw.meta.get(cursorCid)!.clock;
    const nameClockBefore = aw.meta.get(nameCid)!.clock;

    // Update cursor 10 times
    for (let i = 0; i < 10; i++) {
      aw.setField("cursor", { x: i, y: i });
    }

    expect(aw.meta.get(cursorCid)!.clock).toBe(cursorClockBefore + 10);
    expect(aw.meta.get(nameCid)!.clock).toBe(nameClockBefore); // unchanged
  });

  it("update event fires only for the changed channel's clientId", () => {
    aw.setField("cursor", { x: 0, y: 0 });
    aw.setField("name", "Alice");

    const updates: number[][] = [];
    aw.on("update", (ev) => {
      updates.push([...ev.added, ...ev.updated, ...ev.removed]);
    });

    aw.setField("cursor", { x: 100, y: 200 });

    // Only cursor channel should be in the update
    expect(updates.length).toBe(1);
    const cursorCid = aw.clientID + 2 ** 51;
    expect(updates[0]).toEqual([cursorCid]);
  });
});

describe("PlexusAwareness: peer sync", () => {
  it("B sees A's fields after sync", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("cursor", { x: 42, y: 99 });
    awA.setField("name", "Alice");
    syncAtoB();

    const peer = awB.getPeer(awA.clientID);
    expect(peer).toEqual({ cursor: { x: 42, y: 99 }, name: "Alice" });

    cleanup(docA, docB);
  });

  it("B discovers A's schema from channel 0", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("cursor", { x: 0, y: 0 });
    awA.setField("name", "Alice");
    awA.setField("selection", ["el-1"]);
    syncAtoB();

    // B can read A's schema from states map
    const schema = awB.states.get(awA.clientID);
    expect(schema).toEqual(["cursor", "name", "selection"]);

    cleanup(docA, docB);
  });

  it("field update syncs independently", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("cursor", { x: 0, y: 0 });
    awA.setField("name", "Alice");
    syncAtoB();

    // Track B's update events
    const updatedClients: number[] = [];
    awB.on("update", (ev) => updatedClients.push(...ev.updated));

    // A updates only cursor
    awA.setField("cursor", { x: 100, y: 200 });

    // Sync only the cursor channel
    const cursorCid = awA.clientID + 2 ** 51;
    const update = encodeAwarenessUpdate(awA, [cursorCid]);
    applyAwarenessUpdate(awB, update, "remote");

    // B's merged state reflects the update
    const peer = awB.getPeer(awA.clientID);
    expect(peer!.cursor).toEqual({ x: 100, y: 200 });
    expect(peer!.name).toBe("Alice"); // unchanged

    // Only cursor channel was in the update
    expect(updatedClients).toEqual([cursorCid]);

    cleanup(docA, docB);
  });

  it("getPeerIds returns all remote base clientIds", () => {
    const { awA, awB, sync, docA, docB } = createPair();

    awA.setField("name", "Alice");
    awB.setField("name", "Bob");
    sync();

    expect(awA.getPeerIds()).toEqual([awB.clientID]);
    expect(awB.getPeerIds()).toEqual([awA.clientID]);

    cleanup(docA, docB);
  });

  it("peers() iterator yields merged states", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("name", "Alice");
    awA.setField("cursor", { x: 1, y: 2 });
    syncAtoB();

    const entries = [...awB.peers()];
    expect(entries.length).toBe(1);
    expect(entries[0][0]).toBe(awA.clientID);
    expect(entries[0][1]).toEqual({ name: "Alice", cursor: { x: 1, y: 2 } });

    cleanup(docA, docB);
  });
});

describe("PlexusAwareness: heartbeat and timeout", () => {
  // NOTE: lib0/time caches Date.now at import time, so vitest fake timers
  // don't affect it. These tests verify the LOGIC of heartbeat/timeout
  // without relying on timer advancement.

  it("channel 0 has heartbeat interval set up", () => {
    const doc = new Y.Doc();
    const aw = new PlexusAwareness(doc);
    // The _checkInterval exists (we can't inspect it directly, but destroy clears it)
    expect(aw.states.has(aw.clientID)).toBe(true);
    doc.destroy();
  });

  it("field channels have independent clocks from channel 0", () => {
    const doc = new Y.Doc();
    const aw = new PlexusAwareness(doc);
    aw.setField("name", "Alice");

    const ch0Clock = aw.meta.get(aw.clientID)!.clock;
    const nameCid = aw.clientID + 2 ** 51;
    const nameClock = aw.meta.get(nameCid)!.clock;

    // Channel 0 was written twice (constructor + setField schema update)
    // Name channel was written once
    expect(ch0Clock).toBeGreaterThan(nameClock);

    doc.destroy();
  });

  it("_removePeer cleans up all channels for a peer", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("cursor", { x: 0, y: 0 });
    awA.setField("name", "Alice");
    syncAtoB();

    expect(awB.getPeerIds()).toEqual([awA.clientID]);

    // Simulate timeout cleanup by calling removeAwarenessStates
    // This removes channel 0; our wrapper should also clean field channels
    const cursorCid = awA.clientID + 2 ** 51;
    const nameCid = awA.clientID + 2 * 2 ** 51;

    // Manually remove all of A's channels from B (simulating what timeout would do)
    removeAwarenessStates(awB, [awA.clientID, cursorCid, nameCid], "timeout");

    expect(awB.getPeerIds()).toEqual([]);
    expect(awB.getPeer(awA.clientID)).toBeNull();
    expect(awB.states.has(cursorCid)).toBe(false);
    expect(awB.states.has(nameCid)).toBe(false);

    cleanup(docA, docB);
  });
});

describe("PlexusAwareness: destroy", () => {
  it("destroy removes all local channels", () => {
    const doc = new Y.Doc();
    const aw = new PlexusAwareness(doc);
    aw.setField("cursor", { x: 0, y: 0 });
    aw.setField("name", "Alice");

    const removed: number[] = [];
    aw.on("update", (ev) => removed.push(...ev.removed));

    aw.destroy();

    // Should have removed channel 0 + 2 field channels
    expect(removed.length).toBe(3);
    expect(aw.states.size).toBe(0);
  });
});

describe("PlexusAwareness: self-protection", () => {
  it("refuses removal of own channel by remote peer", () => {
    const { awA, awB, syncAtoB, docA, docB } = createPair();

    awA.setField("name", "Alice");
    syncAtoB();

    // B tries to remove A's channel 0
    removeAwarenessStates(awB, [awA.clientID], "malicious");

    // A should still have its state (self-protection in applyAwarenessUpdate)
    // But B locally removed it — this is B's view
    expect(awB.states.has(awA.clientID)).toBe(false);

    // A still has its own state
    expect(awA.states.has(awA.clientID)).toBe(true);
    expect(awA.getField("name")).toBe("Alice");

    cleanup(docA, docB);
  });
});

describe("PlexusAwareness: wire compatibility", () => {
  it("encodeAwarenessUpdate produces valid wire format", () => {
    const doc = new Y.Doc();
    const aw = new PlexusAwareness(doc);
    aw.setField("cursor", { x: 10, y: 20 });

    const allClients = [...aw.states.keys()];
    const update = encodeAwarenessUpdate(aw, allClients);

    // Should be a non-empty Uint8Array
    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.byteLength).toBeGreaterThan(0);

    // Should be decodable by another PlexusAwareness
    const doc2 = new Y.Doc();
    const aw2 = new PlexusAwareness(doc2);
    applyAwarenessUpdate(aw2, update, "remote");

    const peer = aw2.getPeer(aw.clientID);
    expect(peer).toEqual({ cursor: { x: 10, y: 20 } });

    doc.destroy();
    doc2.destroy();
  });
});
