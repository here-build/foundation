/**
 * Contagious Materialization Tests
 *
 * When a PlexusModel entity is materialized via [referenceSymbol](doc), it gets a
 * CRDT-native UUID. During materialization, child entities and entities referenced
 * in map keys are also materialized recursively. This cascading is called
 * "contagious materialization."
 *
 * The bug that motivated these tests: serializeKey for Set keys used to sort BEFORE
 * serializing (accessing .uuid before materialization). Now it serializes first
 * (triggering materialization), then sorts. These tests cover all edge cases.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { referenceSymbol } from "../../proxy-runtime-types.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// ── Shared leaf entity ──

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

// ── Containers for each scenario ──

/**
 * Scenario 1 & 7: child-map with Set<Item> key, items owned by child-list.
 * The Set key contains entities that are siblings in the child-list.
 */
@syncing("SetKeyWithChildList")
class SetKeyWithChildList extends PlexusModel<null> {
  @syncing.child.list accessor children: Item[] = [];
  @syncing.child.map accessor byGroup!: Map<Set<Item>, string>;
}

/**
 * Scenario 7 (declaration order): child-map BEFORE child-list.
 * Schema iteration order should not affect contagious materialization.
 */
@syncing("SetKeyMapFirst")
class SetKeyMapFirst extends PlexusModel<null> {
  @syncing.child.map accessor byGroup!: Map<Set<Item>, string>;
  @syncing.child.list accessor children: Item[] = [];
}

/**
 * Scenario 2: child-map with Set<Item> key, item owned by child-val.
 */
@syncing("SetKeyWithChildVal")
class SetKeyWithChildVal extends PlexusModel<null> {
  @syncing.child accessor item: Item | null = null;
  @syncing.child.map accessor byGroup!: Map<Set<Item>, string>;
}

/**
 * Scenario 4: child-map with entity as direct key (not in Set).
 */
@syncing("DirectEntityKey")
class DirectEntityKey extends PlexusModel<null> {
  @syncing.child.list accessor children: Item[] = [];
  @syncing.child.map accessor byName!: Map<Item, string>;
}

/**
 * Scenario 5: child-map with Array key containing entities mixed with primitives.
 */
@syncing("ArrayKeyWithEntities")
class ArrayKeyWithEntities extends PlexusModel<null> {
  @syncing.child.list accessor children: Item[] = [];
  @syncing.child.map accessor byComposite!: Map<Array<Item | string>, string>;
}

/**
 * Scenario 6: Deep cascade — child-map value is entity that also has child-map with entity keys.
 */
@syncing("InnerContainer")
class InnerContainer extends PlexusModel {
  @syncing.child.list accessor leaves: Item[] = [];
  @syncing.child.map accessor innerMap!: Map<Set<Item>, string>;
}

@syncing("OuterContainer")
class OuterContainer extends PlexusModel<null> {
  @syncing.child.list accessor inners: InnerContainer[] = [];
  @syncing.child.map accessor outerMap!: Map<Set<Item>, InnerContainer>;
}

/**
 * Scenario 9: Multiple child-maps sharing key entities.
 */
@syncing("MultiMapSharedKeys")
class MultiMapSharedKeys extends PlexusModel<null> {
  @syncing.child.list accessor children: Item[] = [];
  @syncing.child.map accessor mapA!: Map<Set<Item>, string>;
  @syncing.child.map accessor mapB!: Map<Set<Item>, string>;
}

// ── Helpers ──

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// ── Tests ──

describe("contagious materialization", () => {
  describe("child-map with entity Set key — key entity owned by sibling child-list", () => {
    it("materializes Set key elements during clone → materialize", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      const container = new SetKeyWithChildList({
        children: [itemA, itemB],
        byGroup: new Map([[new Set([itemA, itemB]), "group-1"]]),
      });

      const { root } = initTestPlexus(container);

      // Verify root is materialized and everything resolved
      expect(root).to.have.property("uuid").that.is.a("string");
      expect(root.children).to.have.length(2);
      expect(root.children[0]).to.have.property("uuid").that.is.a("string");
      expect(root.children[1]).to.have.property("uuid").that.is.a("string");

      // The map should have one entry
      expect(root.byGroup.size).to.equal(1);

      // Get the Set key and verify its elements are the same materialized Items
      const [[setKey, value]] = [...root.byGroup.entries()];
      expect(value).to.equal("group-1");
      expect(setKey).to.be.instanceOf(Set);
      expect(setKey.size).to.equal(2);

      // Set key elements should be the exact same objects as children
      const setItems = [...setKey];
      expect(setItems).to.include(root.children[0]);
      expect(setItems).to.include(root.children[1]);
    });

    it("clone produces distinct entities with correct Set key remapping", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });
      const setKey = new Set([itemA, itemB]);

      const container = new SetKeyWithChildList({
        children: [itemA, itemB],
        byGroup: new Map([[setKey, "group-1"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone the materialized root
      const cloned = root.clone();

      // Cloned entities should be different objects
      expect(cloned).not.toBe(root);
      expect(cloned.children[0]).not.toBe(root.children[0]);
      expect(cloned.children[1]).not.toBe(root.children[1]);

      // Materialize cloned tree
      cloned[referenceSymbol](root.__doc__!);

      // After materialization, cloned entities should have UUIDs
      expect(cloned).to.have.property("uuid").that.is.a("string");
      expect(cloned.children[0]).to.have.property("uuid").that.is.a("string");
      expect(cloned.children[1]).to.have.property("uuid").that.is.a("string");

      // Cloned UUIDs should differ from originals
      expect(cloned.uuid).not.to.equal(root.uuid);

      // The map's Set key in the clone should reference cloned Items, not originals
      const [[clonedSetKey, clonedValue]] = [...cloned.byGroup.entries()];
      expect(clonedValue).to.equal("group-1");
      const clonedSetItems = [...clonedSetKey];

      // Set key elements should be the CLONED children, not the originals
      expect(clonedSetItems).to.include(cloned.children[0]);
      expect(clonedSetItems).to.include(cloned.children[1]);
      expect(clonedSetItems).not.to.include(root.children[0]);
      expect(clonedSetItems).not.to.include(root.children[1]);
    });
  });

  describe("child-map with entity Set key — key entity owned by child-val sibling", () => {
    it("materializes Set key element from child-val during clone → materialize", () => {
      const item = new Item({ name: "solo" });

      const container = new SetKeyWithChildVal({
        item,
        byGroup: new Map([[new Set([item]), "only-group"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone and materialize
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      // Cloned item should be distinct
      expect(cloned.item).not.toBe(root.item);
      expect(cloned.item).to.have.property("uuid").that.is.a("string");

      // Set key should reference the cloned item
      const [[clonedSetKey]] = [...cloned.byGroup.entries()];
      const clonedSetItems = [...clonedSetKey];
      expect(clonedSetItems).to.have.length(1);
      expect(clonedSetItems[0]).toBe(cloned.item);
      expect(clonedSetItems[0]).not.toBe(root.item);
    });
  });

  describe("child-map with entity Set key — mixed materialized and virtual entities in Set", () => {
    it("Set key contains both an already-materialized reference and a virtual cloned entity", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      const container = new SetKeyWithChildList({
        children: [itemA, itemB],
        byGroup: new Map([[new Set([itemA, itemB]), "mixed-group"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // itemA and itemB are now materialized via root
      const materializedA = root.children[0];
      const materializedB = root.children[1];
      expect(materializedA).to.have.property("uuid").that.is.a("string");
      expect(materializedB).to.have.property("uuid").that.is.a("string");

      // Create a new virtual item (not yet materialized)
      const virtualItem = new Item({ name: "virtual" });

      // Create a new container that mixes materialized + virtual in Set key
      // The materialized item is a reference (not a child), the virtual is a new child
      const container2 = new SetKeyWithChildList({
        children: [virtualItem],
        byGroup: new Map([[new Set<Item>([virtualItem]), "virtual-only-group"]]),
      });

      const { root: root2 } = initTestPlexus(container2);

      // The virtual item should now be materialized
      expect(root2.children[0]).to.have.property("uuid").that.is.a("string");
      expect(root2.byGroup.size).to.equal(1);

      const [[setKey2]] = [...root2.byGroup.entries()];
      expect(setKey2.size).to.equal(1);
      expect([...setKey2]).to.include(root2.children[0]);
    });
  });

  describe("child-map with entity as direct key (not in Set)", () => {
    it("materializes single entity key during clone → materialize", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      const container = new DirectEntityKey({
        children: [itemA, itemB],
        byName: new Map([
          [itemA, "first"],
          [itemB, "second"],
        ]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone and materialize
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      // Verify map keys are cloned entities
      const clonedEntries = [...cloned.byName.entries()];
      expect(clonedEntries).to.have.length(2);

      const clonedKeys = clonedEntries.map(([k]) => k);
      expect(clonedKeys).to.include(cloned.children[0]);
      expect(clonedKeys).to.include(cloned.children[1]);
      expect(clonedKeys).not.to.include(root.children[0]);
      expect(clonedKeys).not.to.include(root.children[1]);

      // Values preserved
      expect(cloned.byName.get(cloned.children[0])).to.equal("first");
      expect(cloned.byName.get(cloned.children[1])).to.equal("second");
    });
  });

  describe("child-map with Array key containing entities", () => {
    it("materializes entities inside array keys during clone → materialize", () => {
      const item = new Item({ name: "mixed" });

      const container = new ArrayKeyWithEntities({
        children: [item],
        byComposite: new Map([[[item, "literal-part"], "composite-value"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone and materialize
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      expect(cloned.children[0]).not.toBe(root.children[0]);
      expect(cloned.children[0]).to.have.property("uuid").that.is.a("string");

      // Array key should contain cloned entity + original primitive
      const [[arrayKey, val]] = [...cloned.byComposite.entries()];
      expect(val).to.equal("composite-value");
      expect(arrayKey).to.have.length(2);
      expect(arrayKey[0]).toBe(cloned.children[0]);
      expect(arrayKey[0]).not.toBe(root.children[0]);
      expect(arrayKey[1]).to.equal("literal-part");
    });
  });

  describe("deep cascade — nested child-maps with entity keys", () => {
    it("materializes two levels of entity-keyed maps", () => {
      const leafA = new Item({ name: "leaf-a" });
      const leafB = new Item({ name: "leaf-b" });

      const inner = new InnerContainer({
        leaves: [leafA],
        innerMap: new Map([[new Set([leafA]), "inner-group"]]),
      });

      // inner is only in outerMap (not also in inners) to avoid stealing
      const container = new OuterContainer({
        inners: [],
        outerMap: new Map([[new Set([leafB]), inner]]),
      });

      const { root } = initTestPlexus(container);

      // Clone and materialize against shadow (where entities live)
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      // Outer map's value should be the cloned inner
      const outerEntries = [...cloned.outerMap.entries()];
      expect(outerEntries).to.have.length(1);
      const clonedInner = outerEntries[0][1];
      expect(clonedInner).not.toBe(inner);
      expect(clonedInner).to.have.property("uuid").that.is.a("string");

      // Inner level leaves
      expect(clonedInner.leaves).to.have.length(1);
      expect(clonedInner.leaves[0]).not.toBe(leafA);
      expect(clonedInner.leaves[0]).to.have.property("uuid").that.is.a("string");

      // Inner map's Set key should use cloned leaf
      const [[innerSetKey]] = [...clonedInner.innerMap.entries()];
      expect([...innerSetKey]).to.include(clonedInner.leaves[0]);
    });
  });

  describe("declaration order independence", () => {
    it("child-map declared BEFORE child-list works identically", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      // SetKeyMapFirst has byGroup BEFORE children in class body
      const container = new SetKeyMapFirst({
        children: [itemA, itemB],
        byGroup: new Map([[new Set([itemA, itemB]), "group-1"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone and materialize — this exercises schema iteration order
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      expect(cloned.children).to.have.length(2);
      expect(cloned.byGroup.size).to.equal(1);

      const [[clonedSetKey, clonedValue]] = [...cloned.byGroup.entries()];
      expect(clonedValue).to.equal("group-1");

      const clonedSetItems = [...clonedSetKey];
      expect(clonedSetItems).to.include(cloned.children[0]);
      expect(clonedSetItems).to.include(cloned.children[1]);
      expect(clonedSetItems).not.to.include(root.children[0]);
      expect(clonedSetItems).not.to.include(root.children[1]);
    });
  });

  describe("cross-peer sync after contagious materialization", () => {
    it("entities resolve correctly on both peers", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      const container = new SetKeyWithChildList({
        children: [itemA, itemB],
        byGroup: new Map([[new Set([itemA, itemB]), "synced-group"]]),
      });

      const { root: root1, doc: doc1 } = initTestPlexus(container);

      // Create peer doc with same guid (CRDT-native UUIDs need same guid to decode)
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);

      const { root: root2 } = connectTestPlexus<SetKeyWithChildList>(doc2);

      // Peer 2 should see the same structure
      expect(root2.children).to.have.length(2);
      expect(root2.children[0].name).to.equal("a");
      expect(root2.children[1].name).to.equal("b");
      expect(root2.byGroup.size).to.equal(1);

      const [[peer2SetKey, peer2Value]] = [...root2.byGroup.entries()];
      expect(peer2Value).to.equal("synced-group");
      expect(peer2SetKey.size).to.equal(2);

      // Set key elements on peer 2 should resolve to peer 2's own entity instances
      const peer2SetItems = [...peer2SetKey];
      expect(peer2SetItems).to.include(root2.children[0]);
      expect(peer2SetItems).to.include(root2.children[1]);

      // UUIDs should match across peers
      expect(root2.uuid).to.equal(root1.uuid);
      expect(root2.children[0].uuid).to.equal(root1.children[0].uuid);
      expect(root2.children[1].uuid).to.equal(root1.children[1].uuid);
    });
  });

  describe("multiple child-maps sharing key entities", () => {
    it("same entities in Set keys of two different child-maps", () => {
      const itemA = new Item({ name: "a" });
      const itemB = new Item({ name: "b" });

      const container = new MultiMapSharedKeys({
        children: [itemA, itemB],
        mapA: new Map([[new Set([itemA]), "in-A"]]),
        mapB: new Map([[new Set([itemA, itemB]), "in-B"]]),
      });

      const { root, doc } = initTestPlexus(container);

      // Clone and materialize
      const cloned = root.clone();
      cloned[referenceSymbol](root.__doc__!);

      // mapA key should reference cloned itemA
      const [[mapAKey, mapAVal]] = [...cloned.mapA.entries()];
      expect(mapAVal).to.equal("in-A");
      expect([...mapAKey]).to.include(cloned.children[0]);
      expect([...mapAKey]).not.to.include(root.children[0]);

      // mapB key should reference both cloned items
      const [[mapBKey, mapBVal]] = [...cloned.mapB.entries()];
      expect(mapBVal).to.equal("in-B");
      const mapBItems = [...mapBKey];
      expect(mapBItems).to.include(cloned.children[0]);
      expect(mapBItems).to.include(cloned.children[1]);
      expect(mapBItems).not.to.include(root.children[0]);
      expect(mapBItems).not.to.include(root.children[1]);

      // The same cloned entity should appear in both maps' keys
      const mapAEntity = [...mapAKey].find((e) => (e as Item).name === "a");
      const mapBEntityA = mapBItems.find((e) => (e as Item).name === "a");
      expect(mapAEntity).toBe(mapBEntityA);
    });
  });
});
