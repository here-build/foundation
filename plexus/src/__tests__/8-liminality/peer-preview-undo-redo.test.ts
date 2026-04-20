/**
 * Peer Preview + Local Undo/Redo interaction tests.
 *
 * Scenario: B has committed history on main (width=100px -> width=200px).
 * A broadcasts a liminal preview (width=500px). B performs undo/redo while
 * that preview is active.
 *
 * Key architecture:
 * - Peer preview Items live on shadow only (per-peer origin, not forwarded to main)
 * - B's UndoManager operates on main; undo/redo propagates main->shadow via FROM_MAIN
 * - Preview Items have later logical clocks, so they win over base Items on shadow
 * - When preview is cleared, per-peer UM undoes preview Items on shadow
 *
 * FINDINGS (two bugs discovered):
 *
 * BUG 1 (tests 1-2): When B undoes on main while a peer preview is active, then
 * clears the preview, the per-peer UndoManager restores a stale "before" snapshot.
 * The "before" Item (200px) was invalidated by the intervening main undo, so the
 * attribute resolves to null instead of the current base value (100px or 200px).
 * Root cause: two independent UndoManagers modifying overlapping map keys on the
 * same Y.Doc — the per-peer UM's undo stack records Item references that become
 * stale when the main UM changes the same attributes.
 *
 * BUG 2 (test 3): Even without undo during preview, the preview clear (per-peer
 * UM.undo()) leaks to main via shadow->main forwarding. The shadow->main listener
 * blocks the per-peer *application* origin (symbol) but not the per-peer *UM undo*
 * origin (the UndoManager instance itself). This write on main interferes with the
 * main UndoManager's Item graph, corrupting B's undo/redo stack.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("UndoPreviewEntity")
class UndoPreviewEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

describe("Peer preview + local undo/redo", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<UndoPreviewEntity>;
  let rootA: UndoPreviewEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<UndoPreviewEntity>;
  let rootB: UndoPreviewEntity;

  beforeEach(() => {
    // B bootstraps with initial width=100px, then writes width=200px (undoable)
    const resultB = initTestPlexus(new UndoPreviewEntity({ width: "100px", height: "200px" }));
    docB = resultB.doc;
    plexusB = resultB.plexus;
    rootB = resultB.root;

    // Committed write on B: width 100px -> 200px
    rootB.width = "200px";

    // A connects to B's doc state
    docA = new Y.Doc({ guid: docB.guid });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const resultA = connectTestPlexus<UndoPreviewEntity>(docA);
    plexusA = resultA.plexus;
    rootA = resultA.root as UndoPreviewEntity;

    syncDocs(docA, docB);

    expect(rootA.width).toBe("200px");
    expect(rootB.width).toBe("200px");
  });

  it("BUG 1a: undo during preview — cleared preview yields null instead of undone base", () => {
    // A previews width=500px
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("500px");

    // B undoes its 200px write. Main reverts to 100px, propagates to shadow.
    // Preview Items (500px) have later clock — still win on shadow.
    plexusB.undo();
    expect(rootB.width).toBe("500px");

    // Height was never part of any preview — unaffected
    expect(rootB.height).toBe("200px");

    // Clear preview. Per-peer UM restores stale "before" snapshot (200px Item),
    // but 200px was deleted by the main undo. Attribute resolves to null.
    // EXPECTED: "100px" (the undone base)  ACTUAL: null
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBeNull();
  });

  it("BUG 1b: undo+redo during preview — cleared preview yields null", () => {
    // A previews width=500px
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("500px");

    // B undoes (base -> 100px), preview still wins
    plexusB.undo();
    expect(rootB.width).toBe("500px");

    // B redoes (base -> 200px), preview still wins
    plexusB.redo();
    expect(rootB.width).toBe("500px");

    // Same stale-snapshot bug as 1a — null instead of 200px
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBeNull();
  });

  it("BUG 2: preview clear leaks to main — B's undo stack is corrupted", () => {
    // A previews and clears WITHOUT B undoing during preview.
    // This isolates the second bug: shadow->main forwarding of peer preview undo.
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("500px");

    // A reverts, B clears preview — base restores to 200px
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("200px");

    // B's undo should revert 200px -> 100px. But the per-peer UM undo leaked
    // to main (origin was the UM instance, not the per-peer symbol — forwarding
    // doesn't block it). This write on main corrupts the main UM's Item graph.
    // EXPECTED: "100px"  ACTUAL: "200px" (undo is a no-op — stack corrupted)
    plexusB.undo();
    expect(rootB.width).toBe("200px");
  });
});
