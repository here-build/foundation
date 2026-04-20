/**
 * Structural Liminality — array operations during liminality.
 *
 * Tests the boundary between what works and what doesn't for Y.Array
 * operations in the shadow-primary architecture. Scalar liminality
 * (Y.Map attributes) is fully proven. This file maps the exact
 * failure surface for structural operations.
 *
 * For each test: checks shadow, main, peer, undo/redo separately.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("StructEntity")
class StructEntity extends PlexusModel {
  @syncing accessor name: string = "root";
  @syncing.list accessor items: string[] = [];
  @syncing.child.list accessor children: StructEntity[] = [];
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

describe("Structural liminality: array insert", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "root", items: ["a", "b", "c"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("insert during liminality — commit: shadow value", () => {
    plexus.enterLiminality();
    root.items.push("d", "e");
    plexus.commitLiminality();
    expect([...root.items]).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("insert during liminality — commit: main value", () => {
    plexus.enterLiminality();
    root.items.push("d", "e");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("insert during liminality — commit: peer value", () => {
    plexus.enterLiminality();
    root.items.push("d", "e");
    plexus.commitLiminality();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("StructEntity")?.values().next().value;
    const peerItems = peerEl?.getAttribute("items") as Y.Array<string>;
    expect(peerItems?.toArray()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("insert during liminality — commit + undo on main", () => {
    plexus.enterLiminality();
    root.items.push("d", "e");
    plexus.commitLiminality();

    plexus.undo();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c"]);
  });

  it("insert during liminality — revert", () => {
    plexus.enterLiminality();
    root.items.push("d", "e");
    plexus.revertLiminality();
    expect([...root.items]).toEqual(["a", "b", "c"]);
  });
});

describe("Structural liminality: array delete", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "root", items: ["a", "b", "c", "d", "e"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("delete during liminality — shadow shows deletion", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2); // remove 'b', 'c'
    expect([...root.items]).toEqual(["a", "d", "e"]);
    plexus.revertLiminality();
  });

  it("delete during liminality — commit: shadow value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2);
    plexus.commitLiminality();
    expect([...root.items]).toEqual(["a", "d", "e"]);
  });

  it("delete during liminality — commit: main value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2);
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "d", "e"]);
  });

  it("delete during liminality — commit: peer value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2);
    plexus.commitLiminality();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("StructEntity")?.values().next().value;
    const peerItems = peerEl?.getAttribute("items") as Y.Array<string>;
    expect(peerItems?.toArray()).toEqual(["a", "d", "e"]);
  });

  it("delete during liminality — commit + undo on main", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2);
    plexus.commitLiminality();

    plexus.undo();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("delete during liminality — revert restores deleted items", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2);
    plexus.revertLiminality();
    expect([...root.items]).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("Structural liminality: array reorder (splice)", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "root", items: ["a", "b", "c", "d", "e"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("insert + delete during liminality — commit: shadow value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 1); // remove 'b'
    root.items.push("f");    // add 'f'
    root.items.unshift("z"); // prepend 'z'
    plexus.commitLiminality();
    expect([...root.items]).toEqual(["z", "a", "c", "d", "e", "f"]);
  });

  it("insert + delete during liminality — commit: main value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 1);
    root.items.push("f");
    root.items.unshift("z");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["z", "a", "c", "d", "e", "f"]);
  });

  it("insert + delete during liminality — commit: peer value", () => {
    plexus.enterLiminality();
    root.items.splice(1, 1);
    root.items.push("f");
    root.items.unshift("z");
    plexus.commitLiminality();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("StructEntity")?.values().next().value;
    const peerItems = peerEl?.getAttribute("items") as Y.Array<string>;
    expect(peerItems?.toArray()).toEqual(["z", "a", "c", "d", "e", "f"]);
  });

  it("insert + delete during liminality — revert restores original", () => {
    plexus.enterLiminality();
    root.items.splice(1, 1);
    root.items.push("f");
    root.items.unshift("z");
    plexus.revertLiminality();
    expect([...root.items]).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("Structural liminality: mixed scalar + array", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "original", items: ["a", "b", "c"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("scalar + array in same liminal session — commit: shadow", () => {
    plexus.enterLiminality();
    root.name = "changed";
    root.items.push("d");
    plexus.commitLiminality();
    expect(root.name).toBe("changed");
    expect([...root.items]).toEqual(["a", "b", "c", "d"]);
  });

  it("scalar + array in same liminal session — commit: main", () => {
    plexus.enterLiminality();
    root.name = "changed";
    root.items.push("d");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    expect(mainEl?.getAttribute("name")).toBe("changed");
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d"]);
  });

  it("scalar + array in same liminal session — revert", () => {
    plexus.enterLiminality();
    root.name = "changed";
    root.items.push("d");
    plexus.revertLiminality();
    expect(root.name).toBe("original");
    expect([...root.items]).toEqual(["a", "b", "c"]);
  });

  it("scalar + array in same liminal session — commit + undo on main", () => {
    plexus.enterLiminality();
    root.name = "changed";
    root.items.push("d");
    plexus.commitLiminality();

    plexus.undo();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    expect(mainEl?.getAttribute("name")).toBe("original");
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c"]);
  });
});

describe("Structural liminality: multi-cycle array", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "root", items: ["a", "b", "c"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("two array commits — main shows accumulated result", () => {
    plexus.enterLiminality();
    root.items.push("d");
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.items.push("e");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("commit then revert — main has first commit only", () => {
    plexus.enterLiminality();
    root.items.push("d");
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.items.push("e");
    plexus.revertLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d"]);
  });

  it("two commits — undo both on main", () => {
    plexus.enterLiminality();
    root.items.push("d");
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.items.push("e");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;

    plexus.undo();
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d"]);

    plexus.undo();
    expect(mainItems?.toArray()).toEqual(["a", "b", "c"]);

    plexus.redo();
    plexus.redo();
    expect(mainItems?.toArray()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("peer sync after array commit", () => {
    plexus.enterLiminality();
    root.items.push("d");
    root.items.splice(0, 1); // remove 'a'
    plexus.commitLiminality();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("StructEntity")?.values().next().value;
    const peerItems = peerEl?.getAttribute("items") as Y.Array<string>;
    expect(peerItems?.toArray()).toEqual(["b", "c", "d"]);
  });
});

describe("Structural liminality: shadow correctness after commit", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<StructEntity>;
  let root: StructEntity;

  beforeEach(() => {
    const result = initTestPlexus(new StructEntity({ name: "root", items: ["a", "b", "c", "d", "e"] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  it("shadow matches main after array insert commit", () => {
    plexus.enterLiminality();
    root.items.push("f");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;

    expect([...root.items]).toEqual(mainItems?.toArray());
  });

  it("shadow matches main after array delete commit", () => {
    plexus.enterLiminality();
    root.items.splice(1, 2); // remove 'b', 'c'
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;

    expect([...root.items]).toEqual(mainItems?.toArray());
  });

  it("shadow matches main after insert+delete commit", () => {
    plexus.enterLiminality();
    root.items.splice(1, 1); // remove 'b'
    root.items.push("f");
    root.items.unshift("z");
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;

    expect([...root.items]).toEqual(mainItems?.toArray());
  });

  it("shadow matches main after multi-cycle array commits", () => {
    plexus.enterLiminality();
    root.items.push("f");
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.items.splice(0, 1); // remove 'a'
    plexus.commitLiminality();

    const mainTypes = doc.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const mainEl = mainTypes.get("StructEntity")?.values().next().value;
    const mainItems = mainEl?.getAttribute("items") as Y.Array<string>;

    expect([...root.items]).toEqual(mainItems?.toArray());
  });
});
