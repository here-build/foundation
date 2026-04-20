/**
 * Peer Preview Stress Tests — rapid successive updates and idempotency.
 *
 * Validates that:
 * 1. 60 successive preview updates from the same peer (same session/height)
 *    each supersede the previous, with clean undo back to pre-preview state.
 * 2. Applying the exact same delta twice is idempotent (no phantom state).
 * 3. Rapid updates across multiple fields all revert cleanly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("StressPreviewEntity")
class StressPreviewEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

describe("Peer preview stress: rapid updates & idempotency", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<StressPreviewEntity>;
  let rootA: StressPreviewEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<StressPreviewEntity>;
  let rootB: StressPreviewEntity;

  beforeEach(() => {
    const resultA = initTestPlexus(new StressPreviewEntity({ width: "100px", height: "200px", color: "red" }));
    docA = resultA.doc;
    plexusA = resultA.plexus;
    rootA = resultA.root;

    docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const resultB = connectTestPlexus<StressPreviewEntity>(docB);
    plexusB = resultB.plexus;
    rootB = resultB.root as StressPreviewEntity;

    expect(rootA.width).toBe("100px");
    expect(rootB.width).toBe("100px");
  });

  it("60 successive preview updates within same session — final value correct, undo restores original", () => {
    plexusA.enterLiminality();

    // Simulate 60fps cursor drag: each frame broadcasts a new width
    for (let i = 0; i < 60; i++) {
      rootA.width = `${100 + i}px`;
      plexusA.broadcastLiminalPreview();

      const field = plexusA.awareness.getField("liminal") as [number, number, string];
      plexusB.applyPeerPreview(plexusA.awareness.clientID, field);

      // B always sees the latest value
      expect(rootB.width).toBe(`${100 + i}px`);
    }

    // Untouched fields remain stable through all 60 frames
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");

    // Final frame value
    expect(rootB.width).toBe("159px");

    // Session ends — single null clears all 60 accumulated undo items
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);

    // Must restore to the original pre-preview state, not an intermediate frame
    expect(rootB.width).toBe("100px");
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");

    plexusA.revertLiminality();
  });

  it("applying the exact same delta twice is idempotent", () => {
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];

    // Apply once
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("500px");

    // Apply the exact same field again (duplicate awareness message)
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("500px");

    // Undo must still cleanly restore — no phantom stack entries
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("100px");
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");

    plexusA.revertLiminality();
  });

  it("60 rapid multi-field updates — all fields revert cleanly after session end", () => {
    plexusA.enterLiminality();

    // Simulate dragging a resize handle that changes both width and height,
    // plus a color swatch preview that changes on every frame
    const colors = ["red", "orange", "yellow", "green", "cyan", "blue", "indigo", "violet"];

    for (let i = 0; i < 60; i++) {
      rootA.width = `${100 + i * 2}px`;
      rootA.height = `${200 + i * 3}px`;
      rootA.color = colors[i % colors.length];
      plexusA.broadcastLiminalPreview();

      const field = plexusA.awareness.getField("liminal") as [number, number, string];
      plexusB.applyPeerPreview(plexusA.awareness.clientID, field);

      // Spot-check: B tracks the latest values
      expect(rootB.width).toBe(`${100 + i * 2}px`);
      expect(rootB.height).toBe(`${200 + i * 3}px`);
      expect(rootB.color).toBe(colors[i % colors.length]);
    }

    // Final frame values (i=59): width=100+59*2=218, height=200+59*3=377, color=colors[59%8]=colors[3]="green"
    expect(rootB.width).toBe("218px");
    expect(rootB.height).toBe("377px");
    expect(rootB.color).toBe("green");

    // Revert the session
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);

    // ALL three fields must revert to original values
    expect(rootB.width).toBe("100px");
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");
  });
});
