/**
 * Liminality — shadow-primary architecture integration tests.
 *
 * Tests the complete lifecycle: enter → write → commit/revert,
 * with undo/redo, peer sync, rapid cycles, and edge cases.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("LimEntity")
class LimEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
  @syncing accessor opacity: number = 1;
  @syncing.child accessor child: LimEntity | null = null;
}

let doc: Y.Doc;
let plexus: TestPlexus<LimEntity>;
let root: LimEntity;

function setup() {
  const result = initTestPlexus(new LimEntity({ width: "100px", height: "200px", color: "red", opacity: 1 }));
  doc = result.doc;
  plexus = result.plexus;
  root = result.root;
}

// ═══════════════════════════════════════════════════════════════════════

describe("Liminality: lifecycle", () => {
  beforeEach(setup);

  it("enter / commit / revert toggle isLiminal correctly", () => {
    expect(plexus.isLiminal).toBe(false);

    plexus.enterLiminality();
    expect(plexus.isLiminal).toBe(true);

    plexus.commitLiminality();
    expect(plexus.isLiminal).toBe(false);

    plexus.enterLiminality();
    plexus.revertLiminality();
    expect(plexus.isLiminal).toBe(false);
  });

  it("guards: double enter, commit/revert when not liminal — no-ops", () => {
    plexus.enterLiminality();
    plexus.enterLiminality(); // no-op
    expect(plexus.isLiminal).toBe(true);
    plexus.revertLiminality();

    plexus.commitLiminality(); // no-op
    plexus.revertLiminality(); // no-op
    expect(plexus.isLiminal).toBe(false);
  });

  it("main doc clientID is unchanged during liminality", () => {
    const regId = doc.clientID;
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();
    expect(doc.clientID).toBe(regId);
  });
});

describe("Liminality: commit", () => {
  beforeEach(setup);

  it("60-frame drag: preserves final value, untouched fields unaffected", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) {
      root.width = `${100 + i * 3}px`;
    }
    plexus.commitLiminality();
    expect(root.width).toBe("277px");
    expect(root.height).toBe("200px"); // untouched
    expect(root.color).toBe("red");    // untouched
  });

  it("multi-field commit", () => {
    plexus.enterLiminality();
    root.width = "300px";
    root.height = "400px";
    root.color = "blue";
    plexus.commitLiminality();
    expect(root.width).toBe("300px");
    expect(root.height).toBe("400px");
    expect(root.color).toBe("blue");
  });

  it("commit with no writes is a no-op", () => {
    plexus.enterLiminality();
    plexus.commitLiminality();
    expect(root.width).toBe("100px");
  });

  it("numeric fields", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) root.opacity = i / 59;
    plexus.commitLiminality();
    expect(root.opacity).toBeCloseTo(1);
    plexus.undo();
    expect(root.opacity).toBe(1);
  });
});

describe("Liminality: revert", () => {
  beforeEach(setup);

  it("60-frame drag: restores all original values", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) {
      root.width = `${100 + i * 5}px`;
      root.height = `${200 + i * 3}px`;
    }
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");
  });

  it("liminal writes visible during session, gone after revert", () => {
    plexus.enterLiminality();
    root.width = "200px";
    expect(root.width).toBe("200px");
    root.width = "300px";
    expect(root.width).toBe("300px");
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });

  it("revert with no writes is a no-op", () => {
    plexus.enterLiminality();
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });
});

describe("Liminality: undo/redo", () => {
  beforeEach(setup);

  it("commit → undo → redo roundtrip", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) root.width = `${100 + i * 3}px`;
    plexus.commitLiminality();

    expect(root.width).toBe("277px");
    plexus.undo();
    expect(root.width).toBe("100px");
    plexus.redo();
    expect(root.width).toBe("277px");
  });

  it("multi-field undo restores all", () => {
    plexus.enterLiminality();
    root.width = "300px";
    root.height = "400px";
    plexus.commitLiminality();

    plexus.undo();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");
  });

  it("commit isolated from preceding write", () => {
    root.color = "blue";

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    plexus.undo(); // undo commit
    expect(root.width).toBe("100px");
    expect(root.color).toBe("blue"); // survives

    plexus.undo(); // undo color
    expect(root.color).toBe("red");
  });

  it("commit isolated from subsequent write", async () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    root.color = "blue";

    plexus.undo(); // undo color
    expect(root.color).toBe("red");
    expect(root.width).toBe("300px");

    plexus.undo(); // undo commit
    expect(root.width).toBe("100px");
  });

  it("undo during liminality: reverts session then undoes previous", () => {
    root.color = "blue";

    plexus.enterLiminality();
    root.width = "999px";

    plexus.undo();
    expect(plexus.isLiminal).toBe(false);
    expect(root.width).toBe("100px");
    expect(root.color).toBe("red");

    plexus.redo();
    expect(root.color).toBe("blue");
  });
});

describe("Liminality: peer sync", () => {
  beforeEach(setup);

  it("liminal writes invisible to peers, committed value syncs", () => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    plexus.enterLiminality();
    root.width = "999px";

    // During liminality — peer sees nothing
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("LimEntity")?.values().next().value;
    expect(peerEl?.getAttribute("width")).toBe("100px");

    // After commit — peer sees committed value
    root.width = "300px";
    plexus.commitLiminality();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
    expect(peerEl?.getAttribute("width")).toBe("300px");
  });

  it("committed value syncs via Plexus observation", () => {
    const peer = new Y.Doc({ guid: doc.guid });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const plexus2 = (plexus.constructor as any).connect(peer);

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
    expect(plexus2.root.width).toBe("300px");
    peer.destroy();
  });

  it("liminal writes stay off main doc YJS", () => {
    plexus.enterLiminality();
    root.width = "999px";

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("LimEntity")?.values().next().value;
    expect(mainEl?.getAttribute("width")).toBe("100px");

    plexus.revertLiminality();
  });
});

describe("Liminality: rapid cycles", () => {
  beforeEach(setup);

  it("10 commit cycles with full undo/redo", () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      plexus.enterLiminality();
      for (let f = 0; f < 10; f++) {
        root.width = `${100 + cycle * 50 + f * 5}px`;
      }
      plexus.commitLiminality();
    }

    expect(root.width).toBe("595px");

    for (let i = 0; i < 10; i++) plexus.undo();
    expect(root.width).toBe("100px");

    for (let i = 0; i < 10; i++) plexus.redo();
    expect(root.width).toBe("595px");
  });

  it("mixed commit/revert cycles with undo", () => {
    plexus.enterLiminality();
    root.width = "200px";
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.width = "999px";
    plexus.revertLiminality();
    expect(root.width).toBe("200px");

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();
    expect(root.width).toBe("300px");

    plexus.undo();
    expect(root.width).toBe("200px");
    plexus.undo();
    expect(root.width).toBe("100px");
    plexus.redo();
    plexus.redo();
    expect(root.width).toBe("300px");
  });

  it("5 cycles multi-field drag", () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      plexus.enterLiminality();
      for (let f = 0; f < 20; f++) {
        root.width = `${100 + f * 10}px`;
        root.height = `${200 + f * 5}px`;
      }
      plexus.commitLiminality();
    }

    for (let i = 0; i < 5; i++) plexus.undo();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");

    for (let i = 0; i < 5; i++) plexus.redo();
    expect(root.width).toBe("290px");
    expect(root.height).toBe("295px");
  });

  it("100 rapid enter/revert with no writes", () => {
    for (let i = 0; i < 100; i++) {
      plexus.enterLiminality();
      plexus.revertLiminality();
    }
    expect(root.width).toBe("100px");
    expect(plexus.isLiminal).toBe(false);
  });
});

describe("Liminality: edge cases", () => {
  beforeEach(setup);

  it("same value write is a no-op", () => {
    plexus.enterLiminality();
    root.width = "100px"; // same as current
    plexus.commitLiminality();
    expect(root.width).toBe("100px");
  });

  it("child field untouched during scalar liminality", () => {
    const child = new LimEntity({ width: "50px" });
    plexus.transact(() => {
      root.child = child;
    });

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    expect(root.width).toBe("300px");
    expect(root.child).toBe(child);
  });

  it("revert after writing back to original value", () => {
    plexus.enterLiminality();
    root.width = "999px";
    root.width = "100px"; // back to original
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });
});
