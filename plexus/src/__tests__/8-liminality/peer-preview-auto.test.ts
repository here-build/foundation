/**
 * Automatic peer preview integration — validates that peer liminality
 * works end-to-end via awareness without manual applyPeerPreview calls.
 *
 * Two Plexus instances share awareness updates. When A enters liminality
 * and broadcasts, B automatically sees the preview via the awareness
 * change listener. On commit/revert, B automatically cleans up.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  PlexusAwareness,
} from "../../awareness.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("AutoPreviewEntity")
class AutoPreviewEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

/** Simulate awareness transport: sync all awareness state from src to dst (including removals). */
function syncAwareness(src: PlexusAwareness, dst: PlexusAwareness) {
  // Encode all clients that src knows about (from meta, not just states — includes removed)
  const allClients = [...src.meta.keys()];
  if (allClients.length === 0) return;
  const update = encodeAwarenessUpdate(src, allClients);
  applyAwarenessUpdate(dst, update, "remote");
}

describe("Automatic peer preview via awareness", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<AutoPreviewEntity>;
  let rootA: AutoPreviewEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<AutoPreviewEntity>;
  let rootB: AutoPreviewEntity;

  beforeEach(() => {
    const resultA = initTestPlexus(new AutoPreviewEntity({ width: "100px", height: "200px", color: "red" }));
    docA = resultA.doc;
    plexusA = resultA.plexus;
    rootA = resultA.root;

    docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const resultB = connectTestPlexus<AutoPreviewEntity>(docB);
    plexusB = resultB.plexus;
    rootB = resultB.root as AutoPreviewEntity;

    expect(rootA.width).toBe("100px");
    expect(rootB.width).toBe("100px");
  });

  it("B auto-sees A's liminal preview via awareness sync", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    rootA.height = "400px";
    plexusA.broadcastLiminalPreview();

    // Awareness transport: A → B
    syncAwareness(plexusA.awareness, plexusB.awareness);

    // B should automatically see the preview — no manual applyPeerPreview needed
    expect(rootB.width).toBe("300px");
    expect(rootB.height).toBe("400px");
    expect(rootB.color).toBe("red"); // untouched

    plexusA.revertLiminality();
  });

  it("B auto-clears preview when A reverts (awareness field goes null)", () => {
    plexusA.enterLiminality();
    rootA.width = "999px";
    plexusA.broadcastLiminalPreview();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    expect(rootB.width).toBe("999px");

    // A reverts — liminal field cleared
    plexusA.revertLiminality();
    syncAwareness(plexusA.awareness, plexusB.awareness);

    // B should automatically revert
    expect(rootB.width).toBe("100px");
  });

  it("B auto-clears on commit + auto-gets committed value via sync", () => {
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    expect(rootB.width).toBe("500px"); // preview

    plexusA.commitLiminality();
    syncAwareness(plexusA.awareness, plexusB.awareness); // awareness clears
    syncDocs(docA, docB); // committed delta syncs

    expect(rootB.width).toBe("500px"); // now from committed delta
  });

  it("full drag lifecycle: enter → 10 broadcasts → commit → all automatic", () => {
    plexusA.enterLiminality();

    for (let i = 0; i < 10; i++) {
      rootA.width = `${100 + i * 20}px`;
      plexusA.broadcastLiminalPreview();
      syncAwareness(plexusA.awareness, plexusB.awareness);
      expect(rootB.width).toBe(`${100 + i * 20}px`);
    }

    plexusA.commitLiminality();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    syncDocs(docA, docB);

    expect(rootB.width).toBe("280px"); // last broadcast value, now committed
  });

  it("two sessions: commit then revert — all automatic", () => {
    // Session 1: commit
    plexusA.enterLiminality();
    rootA.width = "200px";
    plexusA.broadcastLiminalPreview();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    expect(rootB.width).toBe("200px");

    plexusA.commitLiminality();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    syncDocs(docA, docB);
    expect(rootB.width).toBe("200px"); // committed

    // Session 2: revert
    plexusA.enterLiminality();
    rootA.width = "999px";
    plexusA.broadcastLiminalPreview();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    expect(rootB.width).toBe("999px"); // preview

    plexusA.revertLiminality();
    syncAwareness(plexusA.awareness, plexusB.awareness);
    expect(rootB.width).toBe("200px"); // back to session 1's committed value
  });
});
