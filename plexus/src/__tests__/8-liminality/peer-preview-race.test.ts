/**
 * Race condition tests: committed sync vs preview cleanup ordering.
 *
 * When A commits and B has an active preview, the committed delta (via Yjs sync)
 * and the preview undo (via applyPeerPreview(null)) can arrive in either order.
 * These tests verify both orderings produce the correct final state.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("RaceEntity")
class RaceEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

describe("Race: committed sync vs preview cleanup", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<RaceEntity>;
  let rootA: RaceEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<RaceEntity>;
  let rootB: RaceEntity;

  beforeEach(() => {
    const resultA = initTestPlexus(new RaceEntity({ width: "100px", height: "200px", color: "red" }));
    docA = resultA.doc;
    plexusA = resultA.plexus;
    rootA = resultA.root;

    docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const resultB = connectTestPlexus<RaceEntity>(docB);
    plexusB = resultB.plexus;
    rootB = resultB.root as RaceEntity;

    expect(rootA.width).toBe("100px");
    expect(rootB.width).toBe("100px");
  });

  it("A commits, B receives sync BEFORE clearing preview — committed value survives preview undo", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("300px"); // preview

    // A commits
    plexusA.commitLiminality();

    // Committed sync arrives BEFORE B clears preview
    syncDocs(docA, docB);
    expect(rootB.width).toBe("300px"); // committed + preview overlay both present

    // NOW B clears the stale preview
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);

    // The committed Items (different clientId range) must survive the preview undo
    expect(rootB.width).toBe("300px");
  });

  it("A commits, B clears preview BEFORE sync arrives — sync restores committed value", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("300px"); // preview

    // A commits
    plexusA.commitLiminality();

    // B clears preview BEFORE committed sync arrives
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("100px"); // preview undone, committed data not yet received

    // Committed sync arrives after preview is already gone
    syncDocs(docA, docB);
    expect(rootB.width).toBe("300px"); // committed value restored
  });

  it("A commits session 1, immediately starts session 2 — B sees session 2 preview atop session 1 committed value", () => {
    // ── Session 1: A drags width to 300px ──
    plexusA.enterLiminality();
    rootA.width = "300px";
    plexusA.broadcastLiminalPreview();

    const field1 = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field1);
    expect(rootB.width).toBe("300px"); // session 1 preview

    // ── Session 1 commits, session 2 starts immediately ──
    plexusA.commitLiminality();
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field2 = plexusA.awareness.getField("liminal") as [number, number, string];
    expect(field2[0]).toBeGreaterThan(field1[0]); // height increased — new session detected

    // B receives session 1 committed sync AND session 2 preview (both arrive)
    syncDocs(docA, docB);
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field2);
    expect(rootB.width).toBe("500px"); // session 2 preview visible

    // ── Session 2 reverts ──
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);

    // Session 1's committed value (300px) must be the final state
    expect(rootB.width).toBe("300px");

    // Untouched fields remain at their original values throughout
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");
  });
});
