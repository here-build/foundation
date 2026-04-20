/**
 * Peer Preview Tests — validates liminal preview via awareness.
 *
 * Two Plexus instances on synced docs. A enters liminality and broadcasts.
 * B applies A's preview to its shadow doc. On commit/revert, B cleans up.
 * Committed values arrive via normal Yjs sync under a different clientId.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("PreviewEntity")
class PreviewEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

describe("Peer liminal preview", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<PreviewEntity>;
  let rootA: PreviewEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<PreviewEntity>;
  let rootB: PreviewEntity;

  beforeEach(() => {
    const resultA = initTestPlexus(new PreviewEntity({ width: "100px", height: "200px", color: "red" }));
    docA = resultA.doc;
    plexusA = resultA.plexus;
    rootA = resultA.root;

    docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const resultB = connectTestPlexus<PreviewEntity>(docB);
    plexusB = resultB.plexus;
    rootB = resultB.root as PreviewEntity;

    expect(rootA.width).toBe("100px");
    expect(rootB.width).toBe("100px");
  });

  it("B sees A's liminal changes via applyPeerPreview", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    rootA.height = "400px";
    plexusA.broadcastLiminalPreview();

    // Simulate awareness transport: read A's field, pass to B
    const liminalField = plexusA.awareness.getField("liminal") as [number, number, string];
    expect(liminalField).toBeTruthy();

    plexusB.applyPeerPreview(plexusA.awareness.clientID, liminalField);

    // B's entity should show A's preview values
    expect(rootB.width).toBe("300px");
    expect(rootB.height).toBe("400px");

    // B's main doc is unchanged
    const mainTypes = docB.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("PreviewEntity")?.values().next().value;
    expect(mainEl?.getAttribute("width")).toBe("100px");

    plexusA.revertLiminality();
  });

  it("B reverts preview when A's session ends (field null)", () => {
    plexusA.enterLiminality();
    rootA.width = "999px";
    plexusA.broadcastLiminalPreview();

    const liminalField = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, liminalField);
    expect(rootB.width).toBe("999px");

    // A reverts — awareness field clears
    plexusA.revertLiminality();

    // B removes preview
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("100px"); // restored
  });

  it("B reverts preview when A's height changes (new session)", () => {
    plexusA.enterLiminality();
    rootA.width = "500px";
    plexusA.broadcastLiminalPreview();

    const field1 = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field1);
    expect(rootB.width).toBe("500px");

    // A commits (session 1 ends) and starts new session
    plexusA.commitLiminality();
    syncDocs(docA, docB);

    plexusA.enterLiminality();
    rootA.width = "700px";
    plexusA.broadcastLiminalPreview();

    // Height changed → B auto-undoes previous preview before applying new one
    const field2 = plexusA.awareness.getField("liminal") as [number, number, string];
    expect(field2[0]).toBeGreaterThan(field1[0]); // height increased
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field2);
    expect(rootB.width).toBe("700px");

    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("500px"); // committed value from session 1
  });

  it("A commits — B gets committed value via sync, preview is redundant", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("300px"); // preview

    // A commits
    plexusA.commitLiminality();

    // B clears preview
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);

    // Sync committed value — arrives under committed clientId (different from preview)
    syncDocs(docA, docB);
    expect(rootB.width).toBe("300px"); // now from committed delta, not preview
  });

  it("60-frame drag with periodic preview broadcasts", () => {
    plexusA.enterLiminality();

    for (let i = 0; i < 60; i++) {
      rootA.width = `${100 + i * 3}px`;

      if (i % 10 === 9) {
        plexusA.broadcastLiminalPreview();
        const field = plexusA.awareness.getField("liminal") as [number, number, string];
        plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
        expect(rootB.width).toBe(`${100 + i * 3}px`);
      }
    }

    plexusA.commitLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    syncDocs(docA, docB);
    expect(rootB.width).toBe("277px");
  });

  it("multiple fields preview and revert", () => {
    plexusA.enterLiminality();
    rootA.width = "300px";
    rootA.height = "400px";
    rootA.color = "blue";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("300px");
    expect(rootB.height).toBe("400px");
    expect(rootB.color).toBe("blue");

    // Revert
    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.width).toBe("100px");
    expect(rootB.height).toBe("200px");
    expect(rootB.color).toBe("red");
  });

  it("untouched fields not affected by preview", () => {
    plexusA.enterLiminality();
    rootA.width = "999px";
    plexusA.broadcastLiminalPreview();

    const field = plexusA.awareness.getField("liminal") as [number, number, string];
    plexusB.applyPeerPreview(plexusA.awareness.clientID, field);
    expect(rootB.width).toBe("999px");
    expect(rootB.color).toBe("red"); // untouched

    plexusA.revertLiminality();
    plexusB.applyPeerPreview(plexusA.awareness.clientID, null);
    expect(rootB.color).toBe("red"); // still untouched
  });
});
