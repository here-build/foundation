/**
 * Repro: cross-doc field update on a locally-constructed-then-attached
 * child entity is lost when the inter-doc bridge is **asynchronous**.
 *
 * Topology mirrors what y-websocket does in production (each Y update
 * is forwarded to the other doc in a later tick), reduced to a minimal
 * `setTimeout(0)` bridge with zero transport dependencies. Same Plexus
 * primitives as the passing `child-map-field-update-repro.test.ts`.
 *
 * Observed:
 *   - The synchronous `syncDocs` variant of this scenario passes.
 *   - The async-bridge variant in this file FAILS — locally-constructed
 *     cell on side B does not pick up a `resultJson` write made on side
 *     A, even though the Y update is delivered (verified by attaching a
 *     `doc.on("update", …)` listener that fires).
 *
 * To run a debugger over this:
 *     pnpm test src/__tests__/4-cross-document/async-bridge-field-update.test.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
// y-protocols is a Plexus devDep — used to mimic y-websocket's wire
// protocol (sync step1/step2 + update messages) without a transport.
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("AsyncBugCell")
class Cell extends PlexusModel {
  @syncing accessor specJson: string = "";
  @syncing accessor resultJson: string | null = null;
}

@syncing("AsyncBugRoot")
class Root extends PlexusModel {
  @syncing.child.map accessor cells!: Map<string, Cell>;
}

/**
 * Bidirectional async forwarder between two Y.Docs. Updates emitted by
 * one are applied to the other in a later tick (setTimeout 0). Origin
 * tagging breaks the echo loop. This is the minimal model of what
 * y-websocket does between peers.
 */
function asyncBridge(a: Y.Doc, b: Y.Doc): () => void {
  const onA = (update: Uint8Array, origin: unknown): void => {
    if (origin === b) return;
    setTimeout(() => Y.applyUpdate(b, update, a), 0);
  };
  const onB = (update: Uint8Array, origin: unknown): void => {
    if (origin === a) return;
    setTimeout(() => Y.applyUpdate(a, update, b), 0);
  };
  a.on("update", onA);
  b.on("update", onB);
  return () => {
    a.off("update", onA);
    b.off("update", onB);
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("async-bridged Plexus: locally-constructed child + cross-doc field update", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  it("synchronous syncDocs control — passes (baseline)", () => {
    // Synchronous bridge: one-shot state-vector exchange. This is the
    // existing Plexus test pattern. Same scenario, sync delivery.
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const cellA = new Cell({ specJson: "spec-payload" });
    rootA.cells.set("k1", cellA);

    const doc2 = new Y.Doc({ guid: doc1.guid });
    const u1 = Y.encodeStateAsUpdate(doc1);
    Y.applyUpdate(doc2, u1);
    const { root: rootB } = connectTestPlexus<Root>(doc2);
    const cellB = rootB.cells.get("k1")!;
    expect(cellB.specJson).toBe("spec-payload");

    cellB.resultJson = "answered-from-B";
    const u2 = Y.encodeStateAsUpdate(doc2);
    Y.applyUpdate(doc1, u2);

    expect(cellA.resultJson).toBe("answered-from-B"); // PASSES
  });

  it("async-bridged with opaque-transport origin (mimics y-websocket)", async () => {
    // Variant: each side has a distinct "transport" origin object,
    // matching y-websocket which uses the provider as origin and prevents
    // echoes by inspecting origin identity rather than source-doc identity.
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const doc2 = new Y.Doc({ guid: doc1.guid });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const transportToA = { id: "to-a" };
    const transportToB = { id: "to-b" };
    const onA = (update: Uint8Array, origin: unknown): void => {
      if (origin === transportToA) return;
      setTimeout(() => Y.applyUpdate(doc2, update, transportToB), 0);
    };
    const onB = (update: Uint8Array, origin: unknown): void => {
      if (origin === transportToB) return;
      setTimeout(() => Y.applyUpdate(doc1, update, transportToA), 0);
    };
    doc1.on("update", onA);
    doc2.on("update", onB);
    cleanups.push(() => {
      doc1.off("update", onA);
      doc2.off("update", onB);
    });

    const { root: rootB } = connectTestPlexus<Root>(doc2);

    const cellB = new Cell({ specJson: "spec-payload" });
    rootB.cells.set("k1", cellB);
    await tick(20);

    const cellA = rootA.cells.get("k1")!;
    expect(cellA.specJson).toBe("spec-payload");
    cellA.resultJson = "answered-from-A";
    await tick(50);

    expect(cellB.resultJson).toBe("answered-from-A");
  });

  it("y-protocols sync mimic — what y-websocket does on the wire (no transport)", async () => {
    // Mimics y-websocket's wire protocol with two in-memory peers.
    // Each side: subscribes to its local doc's updates, encodes them as
    // y-protocols update messages, ships them to the other side via a
    // setTimeout(0) "transport." The other side reads via readSyncMessage.
    //
    // The connect handshake is the y-protocols way: side B writes step1
    // (its state vector); side A replies step2 (the missing updates).
    // This is the closest in-process equivalent of y-websocket's wire.
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const doc2 = new Y.Doc({ guid: doc1.guid });

    type Peer = { doc: Y.Doc; origin: object };
    const peerA: Peer = { doc: doc1, origin: { tag: "to-a" } };
    const peerB: Peer = { doc: doc2, origin: { tag: "to-b" } };

    const send = (to: Peer, msg: Uint8Array): void => {
      setTimeout(() => {
        const reader = decoding.createDecoder(msg);
        const writer = encoding.createEncoder();
        syncProtocol.readSyncMessage(reader, writer, to.doc, to.origin);
        // If the reader produced a reply (a step2 in response to step1),
        // ship that back.
        if (encoding.length(writer) > 0) {
          send(to === peerA ? peerB : peerA, encoding.toUint8Array(writer));
        }
      }, 0);
    };

    // Wire local updates → outgoing y-protocols update messages.
    const wireUpdates = (from: Peer, to: Peer): (() => void) => {
      const onUpdate = (update: Uint8Array, origin: unknown): void => {
        if (origin === from.origin) return; // echo prevention
        const enc = encoding.createEncoder();
        syncProtocol.writeUpdate(enc, update);
        send(to, encoding.toUint8Array(enc));
      };
      from.doc.on("update", onUpdate);
      return () => from.doc.off("update", onUpdate);
    };
    cleanups.push(wireUpdates(peerA, peerB));
    cleanups.push(wireUpdates(peerB, peerA));

    // Initial sync handshake: B writes step1, A receives + replies step2.
    const step1 = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1, doc2);
    send(peerA, encoding.toUint8Array(step1));
    await tick(20);

    const { root: rootB } = connectTestPlexus<Root>(doc2);

    const cellB = new Cell({ specJson: "spec-payload" });
    rootB.cells.set("k1", cellB);
    await tick(20);

    const cellA = rootA.cells.get("k1")!;
    expect(cellA).toBeDefined();
    expect(cellA.specJson).toBe("spec-payload");
    cellA.resultJson = "answered-from-A";
    await tick(50);

    expect(cellB.resultJson).toBe("answered-from-A");
  });

  it("async-bridged — locally-constructed cell loses cross-doc field update", async () => {
    // Same scenario as the control, but updates are delivered in a
    // later tick (mirroring y-websocket / any real transport).
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const doc2 = new Y.Doc({ guid: doc1.guid });

    // Initial state copy + bridge installation — order matches what a
    // real transport does (server sends initial state, then live).
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
    cleanups.push(asyncBridge(doc1, doc2));
    const { root: rootB } = connectTestPlexus<Root>(doc2);

    // Side B locally constructs a child and attaches it.
    const cellB = new Cell({ specJson: "spec-payload" });
    rootB.cells.set("k1", cellB);
    await tick(10); // let the bridge deliver

    // Side A materializes from sync and reads the spec.
    const cellA = rootA.cells.get("k1")!;
    expect(cellA).toBeDefined();
    expect(cellA.specJson).toBe("spec-payload");

    // Side A writes the field that was null at construction.
    cellA.resultJson = "answered-from-A";

    // Wait long enough for the async bridge to deliver to doc2, AND for
    // any Plexus observer chain on side B to fire.
    await tick(50);

    // Side B's locally-constructed instance should reflect side A's write.
    // This is what FAILS — cellB.resultJson stays null despite the Y
    // update reaching doc2 (verifiable by adding a doc2.on("update", …)
    // listener; it fires).
    expect(cellB.resultJson).toBe("answered-from-A");
  });
});
