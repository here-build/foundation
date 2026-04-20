/**
 * Tests for lazy container genesis — containers created on first write should
 * use GENESIS_ORIGIN so they survive undo/redo and don't bloat the CRDT log.
 *
 * Key invariant: container shell creation is STRUCTURAL (like entity creation),
 * not CONTENT. Undo reverts the content, not the container.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../decorators.js";
import { PlexusModel } from "../PlexusModel.js";
import type { TestPlexus } from "./_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

// ── Test models ──

@syncing("LCGItem")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("LCGRoot")
class Root extends PlexusModel {
  @syncing accessor title: string = "";
  @syncing.child.list accessor items: Item[] = [];
  @syncing.child.record accessor entries: Record<string, Item> = {};
  @syncing.child.set accessor tags: Set<Item> = new Set();
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
}

describe("Lazy container genesis", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<Root>;
  let root: Root;

  beforeEach(() => {
    const result = initTestPlexus(new Root({ title: "test", items: [], entries: {}, tags: new Set() }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  describe("containers are not eagerly created for empty fields", () => {
    it("empty list field has no Y.Array in wrapper", () => {
      expect(root.__yjsFieldsMap__!.has("items")).to.equal(false);
    });

    it("empty record field has no Y.Map in wrapper", () => {
      expect(root.__yjsFieldsMap__!.has("entries")).to.equal(false);
    });

    it("empty set field has no Y.Array in wrapper", () => {
      expect(root.__yjsFieldsMap__!.has("tags")).to.equal(false);
    });
  });

  describe("containers are created on first write", () => {
    it("list container created on push", () => {
      root.items.push(new Item({ name: "a" }));
      expect(root.__yjsFieldsMap__!.has("items")).to.equal(true);
      expect(root.items).to.have.lengthOf(1);
    });

    it("record container created on set", () => {
      root.entries["x"] = new Item({ name: "x" });
      expect(root.__yjsFieldsMap__!.has("entries")).to.equal(true);
      expect(Object.keys(root.entries)).to.have.lengthOf(1);
    });

    it("set container created on add", () => {
      root.tags.add(new Item({ name: "t" }));
      expect(root.__yjsFieldsMap__!.has("tags")).to.equal(true);
      expect(root.tags.size).to.equal(1);
    });
  });

  describe("container shell survives undo (GENESIS_ORIGIN)", () => {
    it("list: push → undo → container persists, content reverted", () => {
      plexus.transact(() => {
        root.items.push(new Item({ name: "a" }));
      });

      expect(root.items).to.have.lengthOf(1);
      expect(root.__yjsFieldsMap__!.has("items")).to.equal(true);

      plexus.undo();

      // Content is reverted
      expect(root.items).to.have.lengthOf(0);
      // Container shell should survive undo
      expect(root.__yjsFieldsMap__!.has("items")).to.equal(true);
    });

    it("list: push → undo → push again works without re-creating container", () => {
      plexus.transact(() => {
        root.items.push(new Item({ name: "first" }));
      });

      plexus.undo();
      expect(root.items).to.have.lengthOf(0);

      // Push again — should reuse existing container, not create new one
      plexus.transact(() => {
        root.items.push(new Item({ name: "second" }));
      });

      expect(root.items).to.have.lengthOf(1);
      expect(root.items[0].name).to.equal("second");
    });

    it("record: set → undo → container persists", () => {
      plexus.transact(() => {
        root.entries["x"] = new Item({ name: "x" });
      });

      expect(Object.keys(root.entries)).to.have.lengthOf(1);

      plexus.undo();

      expect(Object.keys(root.entries)).to.have.lengthOf(0);
      expect(root.__yjsFieldsMap__!.has("entries")).to.equal(true);
    });

    it("set: add → undo → container persists", () => {
      plexus.transact(() => {
        root.tags.add(new Item({ name: "t" }));
      });

      expect(root.tags.size).to.equal(1);

      plexus.undo();

      expect(root.tags.size).to.equal(0);
      expect(root.__yjsFieldsMap__!.has("tags")).to.equal(true);
    });

    it("list: push → undo → redo roundtrips correctly", () => {
      const item = new Item({ name: "roundtrip" });

      plexus.transact(() => {
        root.items.push(item);
      });

      expect(root.items).to.have.lengthOf(1);

      plexus.undo();
      expect(root.items).to.have.lengthOf(0);

      plexus.redo();
      expect(root.items).to.have.lengthOf(1);
      expect(root.items[0].name).to.equal("roundtrip");
    });
  });

  describe("cross-document sync with lazy containers", () => {
    it("lazily created container syncs to remote peer", () => {
      root.items.push(new Item({ name: "synced" }));

      const doc2 = new Y.Doc({ guid: doc.guid });
      syncDocs(doc, doc2);

      const { root: root2 } = connectTestPlexus<Root>(doc2);
      expect(root2.items).to.have.lengthOf(1);
      expect(root2.items[0].name).to.equal("synced");
    });

    it("empty field on remote peer stays empty (no phantom container)", () => {
      // Only write to items, not entries
      root.items.push(new Item({ name: "a" }));

      const doc2 = new Y.Doc({ guid: doc.guid });
      syncDocs(doc, doc2);

      const { root: root2 } = connectTestPlexus<Root>(doc2);
      expect(root2.items).to.have.lengthOf(1);
      expect(Object.keys(root2.entries)).to.have.lengthOf(0);
      // entries should not have a Y.Map on the remote peer either
      expect(root2.__yjsFieldsMap__!.has("entries")).to.equal(false);
    });
  });
});
