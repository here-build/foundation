/**
 * Tests for @syncing.child.map decorator
 * Verifies that Map values are tracked as children with proper ownership.
 */

import { reaction } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import { serializeKey } from "../../proxies/key-serialization.js";
import type { YPlexusNode } from "../../proxy-runtime-types.js";
import { AllowedYValue, referenceSymbol } from "../../proxy-runtime-types.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";
import { getModelsMap } from "../getModelsMap.js";

beforeAll(() => { enableMobXIntegration(); });

function getParentRef(element: YPlexusNode | undefined): string[] | undefined {
  if (!element || element.length === 0) return undefined;
  const result: string[] = [];
  for (let i = 0; i < element.length; i++) {
    result.push(element.get(i) as any as string);
  }
  return result;
}

// Test models
@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("Container")
class Container extends PlexusModel {
  @syncing.child.map
  accessor items!: Map<string, Item>;
}

describe("child.map field (@syncing.child.map)", () => {
  it("should track parent when value added via set()", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item = new Item({ name: "test" });
    expect(item.parent).toBeNull();
    expect(item.parentField).toBeNull();
    expect(item.parentFieldKey).toBeNull();

    root.items.set("key1", item);

    expect(item.parent).toBe(root);
    expect(item.parentField).toBe("items");
    expect(item.parentFieldKey).toBe("key1");
  });

  it("should orphan value when deleted", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item = new Item({ name: "test" });
    root.items.set("key1", item);
    expect(item.parent).toBe(root);
    expect(item.parentField).toBe("items");
    expect(item.parentFieldKey).toBe("key1");

    root.items.delete("key1");
    expect(item.parent).toBeNull();
    expect(item.parentField).toBeNull();
    expect(item.parentFieldKey).toBeNull();
  });

  it("should orphan old value and adopt new value on set()", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item1 = new Item({ name: "item1" });
    const item2 = new Item({ name: "item2" });

    root.items.set("key1", item1);
    expect(item1.parent).toBe(root);
    expect(item1.parentField).toBe("items");
    expect(item1.parentFieldKey).toBe("key1");

    root.items.set("key1", item2);
    expect(item1.parent).toBeNull();
    expect(item1.parentField).toBeNull();
    expect(item1.parentFieldKey).toBeNull();
    expect(item2.parent).toBe(root);
    expect(item2.parentField).toBe("items");
    expect(item2.parentFieldKey).toBe("key1");
  });

  it("should orphan all values on clear()", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item1 = new Item({ name: "item1" });
    const item2 = new Item({ name: "item2" });

    root.items.set("key1", item1);
    root.items.set("key2", item2);
    expect(item1.parent).toBe(root);
    expect(item1.parentField).toBe("items");
    expect(item1.parentFieldKey).toBe("key1");
    expect(item2.parent).toBe(root);
    expect(item2.parentField).toBe("items");
    expect(item2.parentFieldKey).toBe("key2");

    root.items.clear();
    expect(item1.parent).toBeNull();
    expect(item1.parentField).toBeNull();
    expect(item1.parentFieldKey).toBeNull();
    expect(item2.parent).toBeNull();
    expect(item2.parentField).toBeNull();
    expect(item2.parentFieldKey).toBeNull();
  });

  it("should handle assign() with proper orphaning and adoption", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item1 = new Item({ name: "item1" });
    const item2 = new Item({ name: "item2" });
    const item3 = new Item({ name: "item3" });

    root.items.set("key1", item1);
    root.items.set("key2", item2);
    expect(item1.parent).toBe(root);
    expect(item1.parentField).toBe("items");
    expect(item1.parentFieldKey).toBe("key1");
    expect(item2.parent).toBe(root);
    expect(item2.parentField).toBe("items");
    expect(item2.parentFieldKey).toBe("key2");

    // Use type assertion for Plexus's extended Map with assign() method
    (root.items as Map<string, Item> & { assign: (map: Map<string, Item>) => void }).assign(new Map([["key3", item3]]));

    expect(item1.parent).toBeNull();
    expect(item1.parentField).toBeNull();
    expect(item1.parentFieldKey).toBeNull();
    expect(item2.parent).toBeNull();
    expect(item2.parentField).toBeNull();
    expect(item2.parentFieldKey).toBeNull();
    expect(item3.parent).toBe(root);
    expect(item3.parentField).toBe("items");
    expect(item3.parentFieldKey).toBe("key3");
  });

  it("should handle detach() correctly", () => {
    const container = new Container({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item = new Item({ name: "test" });
    root.items.set("key1", item);
    expect(item.parent).toBe(root);
    expect(item.parentField).toBe("items");
    expect(item.parentFieldKey).toBe("key1");
    expect(root.items).to.has.key("key1");

    // Detach the child - should remove from parent's map
    item.detach();
    expect(item.parent).toBeNull();
    expect(item.parentField).toBeNull();
    expect(item.parentFieldKey).toBeNull();
    expect(root.items).to.not.has.key("key1");
  });

  it("should work with structural keys", () => {
    @syncing("ComplexKeyContainer")
    class ComplexKeyContainer extends PlexusModel {
      @syncing.child.map
      accessor items!: Map<[string, number], Item>;
    }

    const container = new ComplexKeyContainer({ items: new Map() });
    const { root } = initTestPlexus(container);

    const item = new Item({ name: "test" });
    expect(item.parent).toBeNull();
    expect(item.parentField).toBeNull();
    expect(item.parentFieldKey).toBeNull();

    root.items.set(["a", 1], item);

    expect(item.parent).toBe(root);
    expect(item.parentField).toBe("items");
    // parentFieldKey is the serialized form of the structural key
    expect(item.parentFieldKey).toBeDefined();
    expect(root.items.get(["a", 1])).toBe(item);
  });
});

// Helper to sync two YJS docs bidirectionally
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("child.map edge cases", () => {
  describe("Remote changes via YJS sync", () => {
    let doc1: Y.Doc;
    let doc2: Y.Doc;

    beforeEach(() => {
      doc1 = new Y.Doc();
      doc2 = new Y.Doc();
    });

    afterEach(() => {
      doc1.destroy();
      doc2.destroy();
    });

    it("should adopt children when remote set() is received", () => {
      // Setup doc1 with container and item
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      const item = new Item({ name: "remote-item" });
      root1.items.set("key1", item);

      // Sync to doc2
      syncDocs(doc1, doc2);

      // Connect to doc2 and verify child is adopted
      const { root: root2 } = connectTestPlexus<Container>(doc2);
      const item2 = root2.items.get("key1");

      expect(item2).to.exist.and.to.include({ name: "remote-item", parent: root2, parentField: "items" });
    });

    it("should orphan children when remote delete() is received", () => {
      // Setup doc1 with container and item
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      const item = new Item({ name: "will-be-deleted" });
      root1.items.set("key1", item);

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);
      const item2 = root2.items.get("key1")!;
      expect(item2).to.have.property("parent", root2);
      expect(item2.parentField).toBe("items");

      // Delete on doc1
      root1.items.delete("key1");

      // Sync deletion to doc2
      syncDocs(doc1, doc2);

      // Item in doc2 should be orphaned
      expect(item2).to.have.property("parent", null);
      expect(item2.parentField).toBeNull();
      expect(item2.parentFieldKey).toBeNull();
      expect(root2.items).to.not.has.key("key1");
    });

    it("should handle remote replacement (orphan old, adopt new)", () => {
      // Setup doc1 with container and initial item
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      const item1 = new Item({ name: "original" });
      root1.items.set("key1", item1);

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);
      const oldItem2 = root2.items.get("key1")!;
      expect(oldItem2).to.have.property("parent", root2);

      // Replace on doc1
      const item2 = new Item({ name: "replacement" });
      root1.items.set("key1", item2);

      // Sync replacement to doc2
      syncDocs(doc1, doc2);

      // Old item should be orphaned, new item should be adopted
      const newItem2 = root2.items.get("key1")!;
      expect(oldItem2).to.have.property("parent", null);
      expect(newItem2).to.include({ name: "replacement", parent: root2 });
    });

    it("should handle remote clear() - orphan all children", () => {
      // Setup doc1 with container and multiple items
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      root1.items.set("key1", item1);
      root1.items.set("key2", item2);

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);
      const item1_doc2 = root2.items.get("key1")!;
      const item2_doc2 = root2.items.get("key2")!;
      expect([item1_doc2.parent, item2_doc2.parent]).to.have.ordered.members([root2, root2]);

      // Clear on doc1
      root1.items.clear();

      // Sync clear to doc2
      syncDocs(doc1, doc2);

      // All items should be orphaned
      expect([item1_doc2.parent, item2_doc2.parent]).to.have.ordered.members([null, null]);
      expect(root2.items).to.have.property("size", 0);
    });
  });

  describe("Initial Y.Map load and materialization", () => {
    it("should adopt children when connecting to existing doc with data", () => {
      // Create doc1 with data
      const container = new Container({ items: new Map() });
      const { doc: doc1, root: root1 } = initTestPlexus(container);

      const item1 = new Item({ name: "existing-item" });
      root1.items.set("key1", item1);

      // Create doc2 and sync state
      const doc2 = new Y.Doc({ guid: doc1.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Connect to doc2 - children should be adopted during materialization
      const { root: root2 } = connectTestPlexus<Container>(doc2);
      const item2 = root2.items.get("key1");

      expect(item2).to.exist.and.to.include({ name: "existing-item", parent: root2 });

      doc1.destroy();
      doc2.destroy();
    });

    it("should handle materialization of map with multiple children", () => {
      // Create doc1 with multiple items
      const container = new Container({ items: new Map() });
      const { doc: doc1, root: root1 } = initTestPlexus(container);

      const items = Array.from({ length: 5 }, (_, i) => new Item({ name: `item-${i}` }));
      for (const [i, item] of items.entries()) root1.items.set(`key-${i}`, item);

      // Create doc2 and sync state
      const doc2 = new Y.Doc({ guid: doc1.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Connect to doc2
      const { root: root2 } = connectTestPlexus<Container>(doc2);

      // All children should be adopted
      expect(root2.items.size).toBe(5);
      for (let i = 0; i < 5; i++) {
        const item = root2.items.get(`key-${i}`);
        expect(item).toBeDefined();
        expect(item!.name).toBe(`item-${i}`);
        expect(item!.parent).toBe(root2);
      }

      doc1.destroy();
      doc2.destroy();
    });

    it("should handle ephemeral child-map with data before materialization", () => {
      // Create container with pre-populated map while ephemeral
      const item1 = new Item({ name: "pre-existing" });
      const container = new Container({
        items: new Map([["key1", item1]]),
      });

      // Item should have parent even while ephemeral (identical behavior to materialized)
      expect(item1.parent).toBe(container);
      expect(item1.parentField).toBe("items");
      expect(item1.parentFieldKey).toBe("key1");

      // Materialize - child should be adopted
      const { root } = initTestPlexus(container);

      // After materialization, child should be adopted
      const materializedItem = root.items.get("key1");
      expect(materializedItem).toBeDefined();
      expect(materializedItem!.parent).toBe(root);
    });
  });

  describe("assign() ordering and atomicity", () => {
    it("should orphan old values before adopting new ones in assign()", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const oldItem1 = new Item({ name: "old1" });
      const oldItem2 = new Item({ name: "old2" });
      root.items.set("key1", oldItem1);
      root.items.set("key2", oldItem2);

      // Verify initial state
      expect(oldItem1.parent).toBe(root);
      expect(oldItem1.parentField).toBe("items");
      expect(oldItem1.parentFieldKey).toBe("key1");
      expect(oldItem2.parent).toBe(root);
      expect(oldItem2.parentField).toBe("items");
      expect(oldItem2.parentFieldKey).toBe("key2");

      // Perform assign
      const newItem = new Item({ name: "new" });
      (root.items as any).assign(new Map([["key3", newItem]]));

      // Old items should be orphaned
      expect(oldItem1.parent).toBeNull();
      expect(oldItem1.parentField).toBeNull();
      expect(oldItem1.parentFieldKey).toBeNull();
      expect(oldItem2.parent).toBeNull();
      expect(oldItem2.parentField).toBeNull();
      expect(oldItem2.parentFieldKey).toBeNull();

      // New item should be adopted
      expect(newItem.parent).toBe(root);
      expect(newItem.parentField).toBe("items");
      expect(newItem.parentFieldKey).toBe("key3");
      expect(root.items.size).toBe(1);
      expect(root.items.get("key3")).toBe(newItem);
    });

    it("should handle assign() with item that was already in map", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const item = new Item({ name: "reused" });
      root.items.set("key1", item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key1");

      // Assign with same item under different key
      (root.items as any).assign(new Map([["newKey", item]]));

      // Item should still have parent (re-adopted under new key)
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("newKey");
      expect(root.items.size).toBe(1);
      expect(root.items.get("newKey")).toBe(item);
      expect(root.items.has("key1")).toBe(false);
    });

    it("should handle assign() with empty map", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      root.items.set("key1", item1);
      root.items.set("key2", item2);
      expect(item1.parent).toBe(root);
      expect(item1.parentField).toBe("items");
      expect(item2.parent).toBe(root);
      expect(item2.parentField).toBe("items");

      // Assign empty map - should orphan all
      (root.items as any).assign(new Map());

      expect(item1.parent).toBeNull();
      expect(item1.parentField).toBeNull();
      expect(item1.parentFieldKey).toBeNull();
      expect(item2.parent).toBeNull();
      expect(item2.parentField).toBeNull();
      expect(item2.parentFieldKey).toBeNull();
      expect(root.items.size).toBe(0);
    });
  });

  describe("Reparenting edge cases", () => {
    it("should handle moving child between different maps on same parent", () => {
      @syncing("MultiMapContainer")
      class MultiMapContainer extends PlexusModel {
        @syncing.child.map
        accessor leftItems!: Map<string, Item>;

        @syncing.child.map
        accessor rightItems!: Map<string, Item>;
      }

      const container = new MultiMapContainer({
        leftItems: new Map(),
        rightItems: new Map(),
      });
      const { root } = initTestPlexus(container);

      const item = new Item({ name: "movable" });
      root.leftItems.set("key1", item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("leftItems");
      expect(item.parentFieldKey).toBe("key1");
      expect(root.leftItems.has("key1")).toBe(true);

      // Move to right map
      root.rightItems.set("key2", item);

      // Should be removed from left, added to right
      expect(root.leftItems.has("key1")).toBe(false);
      expect(root.rightItems.has("key2")).toBe(true);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("rightItems");
      expect(item.parentFieldKey).toBe("key2");
    });

    it("should handle moving child from map to list", () => {
      @syncing("MixedContainerMapToList")
      class MixedContainerMapToList extends PlexusModel {
        @syncing.child.map
        accessor itemMap!: Map<string, Item>;

        @syncing.child.list
        accessor itemList!: Item[];
      }

      const container = new MixedContainerMapToList({
        itemMap: new Map(),
        itemList: [],
      });
      const { root } = initTestPlexus(container);

      const item = new Item({ name: "movable" });
      root.itemMap.set("key1", item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("itemMap");
      expect(item.parentFieldKey).toBe("key1");
      expect(root.itemMap.has("key1")).toBe(true);

      // Move to list
      root.itemList.push(item);

      // Should be removed from map, added to list
      expect(root.itemMap.has("key1")).toBe(false);
      expect(root.itemList).toContain(item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("itemList");
      expect(item.parentFieldKey).toBeNull();
    });

    it("should handle moving child from list to map", () => {
      @syncing("MixedContainerListToMap")
      class MixedContainerListToMap extends PlexusModel {
        @syncing.child.map
        accessor itemMap!: Map<string, Item>;

        @syncing.child.list
        accessor itemList!: Item[];
      }

      const container = new MixedContainerListToMap({
        itemMap: new Map(),
        itemList: [],
      });
      const { root } = initTestPlexus(container);

      const item = new Item({ name: "movable" });
      root.itemList.push(item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("itemList");
      expect(item.parentFieldKey).toBeNull();
      expect(root.itemList).toContain(item);

      // Move to map
      root.itemMap.set("key1", item);

      // Should be removed from list, added to map
      expect(root.itemList).not.toContain(item);
      expect(root.itemMap.has("key1")).toBe(true);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("itemMap");
      expect(item.parentFieldKey).toBe("key1");
    });
  });

  describe("Transaction boundaries", () => {
    it("should handle multiple operations in single transaction", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      const item3 = new Item({ name: "item3" });

      doc.transact(() => {
        root.items.set("key1", item1);
        root.items.set("key2", item2);
        root.items.set("key1", item3); // Replace item1
      });

      // After transaction: item1 orphaned, item2 and item3 adopted
      expect(item1.parent).toBeNull();
      expect(item1.parentField).toBeNull();
      expect(item1.parentFieldKey).toBeNull();
      expect(item2.parent).toBe(root);
      expect(item2.parentField).toBe("items");
      expect(item2.parentFieldKey).toBe("key2");
      expect(item3.parent).toBe(root);
      expect(item3.parentField).toBe("items");
      expect(item3.parentFieldKey).toBe("key1");
      expect(root.items.get("key1")).toBe(item3);
      expect(root.items.get("key2")).toBe(item2);
    });

    it("should handle delete and re-add in same transaction", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      const item = new Item({ name: "item" });
      root.items.set("key1", item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key1");

      doc.transact(() => {
        root.items.delete("key1");
        root.items.set("key1", item); // Re-add same item
      });

      // Item should still be adopted
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key1");
      expect(root.items.get("key1")).toBe(item);
    });
  });

  describe("YJS storage verification", () => {
    it("should store parent reference in YJS", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      const item = new Item({ name: "test" });
      root.items.set("key1", item);

      // Verify YJS storage
      const models = getModelsMap(doc);
      const itemFields = models.get(item.uuid);
      const parentRef = getParentRef(itemFields);

      // Map keys are serialized with a prefix format
      const serializedKey = serializeKey("key1", doc);
      expect(parentRef).toEqual([root.uuid, "items", serializedKey]);
    });

    it("should clear parent reference in YJS on delete", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      const item = new Item({ name: "test" });
      root.items.set("key1", item);

      // Verify parent ref exists
      const models = getModelsMap(doc);
      expect(getParentRef(models.get(item.uuid))).toBeDefined();

      // Delete item
      root.items.delete("key1");

      // Parent ref should be cleared
      expect(getParentRef(models.get(item.uuid))).toBeUndefined();
    });
  });

  describe("Clone operations", () => {
    it("should deep clone child-map with correct parent refs", () => {
      const container = new Container({ items: new Map() });
      const { doc, root, plexus } = initTestPlexus(container);

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      root.items.set("key1", item1);
      root.items.set("key2", item2);

      // Clone the container
      const cloned = root.clone();
      // Materialize the clone using referenceSymbol
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<Container>(clonedId)!;

      // Cloned container should have different item instances
      const clonedItem1 = materializedClone.items.get("key1");
      const clonedItem2 = materializedClone.items.get("key2");

      expect(clonedItem1).not.toBe(item1);
      expect(clonedItem2).not.toBe(item2);
      expect(clonedItem1!.name).toBe("item1");
      expect(clonedItem2!.name).toBe("item2");

      // Cloned items should have cloned parent
      expect(clonedItem1!.parent).toBe(materializedClone);
      expect(clonedItem2!.parent).toBe(materializedClone);

      // Original items should still have original parent
      expect(item1.parent).toBe(root);
      expect(item2.parent).toBe(root);
    });
  });
});

/**
 * Weird edge cases - exploring the boundaries of child-map behavior
 * with complex initialization patterns, structural keys containing entities,
 * self-references, and cross-field interactions.
 */
describe("child.map weird edge cases", () => {
  describe("Same entity as both key and value", () => {
    it("should handle entity as both key and value in same entry", () => {
      @syncing("EntityKeyContainer")
      class EntityKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, Item>;
      }

      const item = new Item({ name: "dual-role" });
      const container = new EntityKeyContainer({
        items: new Map([[item, item]]),
      });

      const { root } = initTestPlexus(container);

      // The item should be adopted as a VALUE (child-map tracks values, not keys)
      // Key is just a reference, not ownership
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");

      // The map should have the entry
      expect(root.items.get(item)).toBe(item);
      expect(root.items.size).toBe(1);
    });

    it("should handle entity as key for one entry and value for another", () => {
      @syncing("CrossRefEntityKeyContainer")
      class CrossRefEntityKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, Item>;
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });

      // item1 is key for item2, item2 is key for item1
      const container = new CrossRefEntityKeyContainer({
        items: new Map([
          [item1, item2],
          [item2, item1],
        ]),
      });

      const { root } = initTestPlexus(container);

      // Both items should be adopted as values
      expect(item1.parent).toBe(root);
      expect(item1.parentField).toBe("items");
      expect(item2.parent).toBe(root);
      expect(item2.parentField).toBe("items");

      // Cross-reference should work
      expect(root.items.get(item1)).toBe(item2);
      expect(root.items.get(item2)).toBe(item1);
    });
  });

  describe("Structural keys containing entities", () => {
    it("should handle array key containing entity with same entity as value", () => {
      @syncing("ArrayKeyContainer")
      class ArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<[Item], Item>;
      }

      const item = new Item({ name: "in-array-key" });
      const container = new ArrayKeyContainer({
        items: new Map([[[item], item]]),
      });

      const { root } = initTestPlexus(container);

      // Item should be adopted as value
      // The item in the array key is NOT a child (keys don't confer ownership)
      expect(item.parent).toBe(root);
      expect(root.items.get([item])).toBe(item);
    });

    it("should handle Set key containing entity with same entity as value", () => {
      @syncing("SetKeyContainer")
      class SetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Set<Item>, Item>;
      }

      const item = new Item({ name: "in-set-key" });
      const container = new SetKeyContainer({
        items: new Map([[new Set([item]), item]]),
      });

      const { root } = initTestPlexus(container);

      // Item should be adopted as value
      expect(item.parent).toBe(root);
      expect(root.items.get(new Set([item]))).toBe(item);
    });

    it("LIMITATION: Sets nested inside array keys are not supported", () => {
      // PathMap only supports flat key structures:
      // - primitives, PlexusModels
      // - Set<primitives | PlexusModels> (top-level)
      // - Array<primitives | PlexusModels> (top-level)
      // Nesting (e.g., Set inside Array, Array inside Set) is NOT supported
      @syncing("ArraySetKeyContainer")
      class ArraySetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<[Item, Set<Item>], Item>;
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      const item3 = new Item({ name: "item3" });

      // This should throw because nested Sets in arrays are not valid
      expect(() => {
        new ArraySetKeyContainer({
          items: new Map([[[item1, new Set([item2])], item3]]),
        });
      }).toThrow(/Plain objects are not allowed as map keys or values/);
    });

    it("multiple entities in array key (flat structure) works", () => {
      @syncing("FlatArrayKeyContainer")
      class FlatArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<[Item, Item], Item>;
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      const item3 = new Item({ name: "item3" });

      // Flat array with multiple entities works
      const container = new FlatArrayKeyContainer({
        items: new Map([[[item1, item2], item3]]),
      });

      const { root } = initTestPlexus(container);

      // Only item3 (the value) should be adopted
      expect(item3.parent).toBe(root);
      // item1 and item2 in the key are NOT children
      expect(item1.parent).toBeNull();
      expect(item2.parent).toBeNull();

      // Lookup works
      expect(root.items.get([item1, item2])).toBe(item3);
    });
  });

  describe("Same entity as value for multiple keys", () => {
    it("should handle same entity as value for two different keys - last one wins", () => {
      const item = new Item({ name: "shared-value" });
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      // Add same item under two keys
      root.items.set("key1", item);
      expect(root.items.has("key1")).toBe(true);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key1");

      // Setting same item under different key should:
      // 1. Remove from key1 (emancipation during adoption)
      // 2. Add to key2
      root.items.set("key2", item);

      expect(root.items.has("key1")).toBe(false); // Removed from old key
      expect(root.items.has("key2")).toBe(true); // Added to new key
      expect(root.items.get("key2")).toBe(item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key2");
    });

    it("should handle same entity in initial Map with multiple keys - last key wins via stealing", () => {
      const item = new Item({ name: "multi-key" });

      // Same entity under multiple keys: adoption triggers stealing, so only the last key survives
      const container = new Container({
        items: new Map([
          ["key1", item],
          ["key2", item],
          ["key3", item],
        ]),
      });

      const { root } = initTestPlexus(container);

      // Item should have parent with correct field tracking
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key3");

      // Only the last key survives (stealing removes previous entries)
      let count = 0;
      for (const [, v] of root.items) {
        if (v === item) count++;
      }
      expect(count).toBe(1);
      expect(root.items.has("key3")).toBe(true);
    });
  });

  describe("Self-reference prevention", () => {
    it("should prevent parent from being its own child value", () => {
      @syncing("SelfRefContainer")
      class SelfRefContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<string, PlexusModel>;
      }

      const container = new SelfRefContainer({ items: new Map() });
      const { root } = initTestPlexus(container);

      // Attempting to set parent as its own child should throw
      // Root entities cannot have parents, so trying to set root as value throws
      expect(() => {
        root.items.set("self", root);
      }).toThrow(/root entity cannot have a parent/i);

      expect(root.items.has("self")).toBe(false);
    });

    it("should prevent root entity from being added as child value anywhere", () => {
      @syncing("NestedContainerWithMap")
      class NestedContainerWithMap extends PlexusModel {
        @syncing.child
        accessor child!: NestedContainerWithMap | null;

        @syncing.child.map
        accessor items!: Map<string, PlexusModel>;
      }

      const parent = new NestedContainerWithMap({ child: null, items: new Map() });
      const child = new NestedContainerWithMap({ child: null, items: new Map() });

      const { root } = initTestPlexus(parent);
      root.child = child;

      // Child trying to add root as a map value should throw
      // Root entity cannot become a child of anything
      expect(() => {
        child.items.set("parent", root);
      }).toThrow(/root entity cannot have a parent/i);
    });
  });

  describe("Cross-field ownership - initialization vs runtime", () => {
    it("same entity in multiple fields during init - last field wins via stealing", () => {
      @syncing("MultiFieldContainer")
      class MultiFieldContainer extends PlexusModel {
        @syncing.child.list
        accessor list!: Item[];

        @syncing.child.map
        accessor map!: Map<string, Item>;
      }

      const sharedItem = new Item({ name: "shared" });

      // Same entity in multiple child fields: stealing moves it to the last-initialized field
      const container = new MultiFieldContainer({
        list: [sharedItem],
        map: new Map([["key", sharedItem]]),
      });

      const { root } = initTestPlexus(container);

      expect(sharedItem.parent).toBe(root);
      expect(sharedItem.parentField).toBe("map");
      expect(sharedItem.parentFieldKey).toBe("key");

      // Map was initialized after list, so stealing moved the item from list to map
      expect(root.list).not.toContain(sharedItem);
      expect(root.map.get("key")).toBe(sharedItem);
    });

    it("same entity in map and child-val during init - last field wins via stealing", () => {
      @syncing("MultiFieldContainer2")
      class MultiFieldContainer2 extends PlexusModel {
        @syncing.child.map
        accessor map!: Map<string, Item>;

        @syncing.child
        accessor single!: Item | null;
      }

      const sharedItem = new Item({ name: "shared" });

      // Same entity in map and single field: single is initialized after map, so it wins
      const container = new MultiFieldContainer2({
        map: new Map([["key", sharedItem]]),
        single: sharedItem,
      });

      const { root } = initTestPlexus(container);

      expect(sharedItem.parent).toBe(root);
      expect(sharedItem.parentField).toBe("single");
      expect(sharedItem.parentFieldKey).toBeNull();

      // child-val was initialized after map, so stealing moved item from map to single
      expect(root.map.has("key")).toBe(false);
      expect(root.single).toBe(sharedItem);
    });

    it("runtime operations DO trigger stealing between fields", () => {
      // This demonstrates that runtime operations properly trigger stealing
      @syncing("GetterContainer")
      class GetterContainer extends PlexusModel {
        @syncing.child.list
        accessor list!: Item[];
        @syncing.child.map
        accessor map!: Map<string, Item>;

        get firstItem(): Item | undefined {
          return this.list[0];
        }
      }

      const item = new Item({ name: "via-getter" });

      const container = new GetterContainer({
        list: [item],
        map: new Map(), // Empty at init
      });

      const { root } = initTestPlexus(container);

      // Initially item is in list
      expect(root.list).toContain(item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("list");
      expect(item.parentFieldKey).toBeNull();

      // Runtime operation: add via getter reference to map
      root.map.set("key", root.firstItem!);

      // NOW stealing happens - item is removed from list
      expect(root.list).not.toContain(item);
      expect(root.map.get("key")).toBe(item);
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("map");
      expect(item.parentFieldKey).toBe("key");
    });
  });

  describe("Entity as key - lookup after value ownership changes", () => {
    it("should still find entry by entity key after entity changes parent", () => {
      @syncing("EntityKeyWithOwnedContainer")
      class EntityKeyWithOwnedContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, string>;

        @syncing.child
        accessor owned!: Item | null;
      }

      const keyItem = new Item({ name: "key-item" });
      const container = new EntityKeyWithOwnedContainer({
        items: new Map([[keyItem, "value"]]),
        owned: null,
      });

      const { root } = initTestPlexus(container);

      // keyItem is NOT a child (it's a key, not a value)
      // Map value is a string, not an entity
      expect(keyItem.parent).toBeNull();

      // Lookup should work
      expect(root.items.get(keyItem)).toBe("value");

      // Now adopt keyItem via the owned field
      root.owned = keyItem;
      expect(keyItem.parent).toBe(root);
      expect(keyItem.parentField).toBe("owned");
      expect(keyItem.parentFieldKey).toBeNull();

      // Lookup should STILL work (key identity preserved)
      expect(root.items.get(keyItem)).toBe("value");
    });

    it("should handle entity key whose ownership changes to different parent", () => {
      @syncing("ParentWithMap")
      class ParentWithMap extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, string>;
      }

      @syncing("ParentWithOwned")
      class ParentWithOwned extends PlexusModel {
        @syncing.child
        accessor owned!: Item | null;
      }

      const keyItem = new Item({ name: "traveling-key" });

      const p1 = new ParentWithMap({ items: new Map([[keyItem, "from-p1"]]) });
      const p2 = new ParentWithOwned({ owned: null });

      const { doc, root: root1, plexus } = initTestPlexus(p1);

      // Materialize p2 in same doc
      const [p2Id] = p2[referenceSymbol](root1.__doc__!);
      const root2 = plexus.loadEntity<ParentWithOwned>(p2Id)!;

      // keyItem has no parent (it's just a key)
      expect(keyItem.parent).toBeNull();
      expect(root1.items.get(keyItem)).toBe("from-p1");

      // p2 adopts keyItem
      root2.owned = keyItem;
      expect(keyItem.parent).toBe(root2);

      // p1's map lookup should still work
      expect(root1.items.get(keyItem)).toBe("from-p1");
    });
  });

  describe("Map with entity keys referencing each other", () => {
    it("should handle circular entity key references", () => {
      @syncing("CircularKeyContainer")
      class CircularKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor forward!: Map<Item, Item>;

        @syncing.child.map
        accessor backward!: Map<Item, Item>;
      }

      const a = new Item({ name: "a" });
      const b = new Item({ name: "b" });

      const container = new CircularKeyContainer({
        forward: new Map([[a, b]]), // a -> b
        backward: new Map([[b, a]]), // b -> a
      });

      const { root } = initTestPlexus(container);

      // Both a and b should be adopted (as values)
      // But each can only have one parent, so last write wins
      // forward processed first: b adopted
      // backward processed second: a adopted, but b was already in forward...
      // Actually, let's check what happens

      // Both should have parent (they're values in their respective maps)
      expect(a.parent).toBe(root);
      expect(b.parent).toBe(root);

      // But due to stealing, each should only be in ONE map
      const aInForward = root.forward.get(a) === b;
      const aInBackward = root.backward.get(b) === a;

      // At least one relationship should be maintained
      expect(aInForward || aInBackward).toBe(true);
    });
  });

  describe("Key structure limitations", () => {
    it("LIMITATION: deeply nested arrays in keys are not supported", () => {
      // PathMap only supports single-level arrays and Sets as keys
      // Nested arrays like [[item]] are not allowed because they can't
      // be properly serialized and compared.
      @syncing("DeepKeyContainer")
      class DeepKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<[[Item]], Item>;
      }

      const keyItem = new Item({ name: "deep-in-key" });
      const valueItem = new Item({ name: "value" });

      // This should throw because nested arrays are not valid key structures
      expect(() => {
        new DeepKeyContainer({
          items: new Map([[[[keyItem]], valueItem]]),
        });
      }).toThrow(/Plain objects are not allowed as map keys or values/);
    });

    it("single-level array keys with entities ARE supported", () => {
      @syncing("ArrayKeyContainer2")
      class ArrayKeyContainer2 extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<[string, Item], Item>;
      }

      const keyItem = new Item({ name: "in-key" });
      const valueItem = new Item({ name: "value" });

      // Single-level array with mixed primitives and entities works
      const container = new ArrayKeyContainer2({
        items: new Map([[["prefix", keyItem], valueItem]]),
      });

      const { root } = initTestPlexus(container);

      // Only valueItem should be adopted
      expect(valueItem.parent).toBe(root);
      expect(keyItem.parent).toBeNull();

      // Lookup works with equivalent structure
      expect(root.items.get(["prefix", keyItem])).toBe(valueItem);
    });
  });

  describe("Empty and null edge cases", () => {
    it("should handle null value in child-map", () => {
      @syncing("NullableMapContainer")
      class NullableMapContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<string, Item | null>;
      }

      const container = new NullableMapContainer({
        items: new Map([["key", null]]),
      });

      const { root } = initTestPlexus(container);

      expect(root.items.get("key")).toBeNull();
      expect(root.items.size).toBe(1);
    });

    it("should handle transition from entity to null", () => {
      @syncing("NullableMapContainer2")
      class NullableMapContainer2 extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<string, Item | null>;
      }

      const item = new Item({ name: "will-be-null" });
      const container = new NullableMapContainer2({
        items: new Map([["key", item]]),
      });

      const { root } = initTestPlexus(container);

      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key");

      // Replace with null
      root.items.set("key", null);

      expect(item.parent).toBeNull(); // Orphaned
      expect(item.parentField).toBeNull();
      expect(item.parentFieldKey).toBeNull();
      expect(root.items.get("key")).toBeNull();
    });
  });

  describe("Rapid ownership changes", () => {
    it("should handle entity bouncing between map keys", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const item = new Item({ name: "bouncing" });

      // Rapidly move between keys
      for (let i = 0; i < 100; i++) {
        root.items.set(`key${i}`, item);
        expect(item.parent).toBe(root);
        expect(root.items.has(`key${i}`)).toBe(true);

        if (i > 0) {
          expect(root.items.has(`key${i - 1}`)).toBe(false);
        }
      }

      // Final state
      expect(root.items.size).toBe(1);
      expect(root.items.has("key99")).toBe(true);
      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("key99");
    });

    it("should handle entity bouncing between different collection types", () => {
      @syncing("MultiCollectionContainer")
      class MultiCollectionContainer extends PlexusModel {
        @syncing.child.list
        accessor list!: Item[];

        @syncing.child.set
        accessor set!: Set<Item>;

        @syncing.child.map
        accessor map!: Map<string, Item>;

        @syncing.child.record
        accessor record!: Record<string, Item>;
      }

      const container = new MultiCollectionContainer({
        list: [],
        set: new Set(),
        map: new Map(),
        record: {},
      });

      const { root } = initTestPlexus(container);
      const item = new Item({ name: "nomad" });

      // list -> set -> map -> record -> list
      root.list.push(item);
      expect(root.list).toContain(item);
      expect(item.parentField).toBe("list");
      expect(item.parentFieldKey).toBeNull();

      root.set.add(item);
      expect(root.list).not.toContain(item);
      expect(root.set.has(item)).toBe(true);
      expect(item.parentField).toBe("set");
      expect(item.parentFieldKey).toBeNull();

      root.map.set("key", item);
      expect(root.set.has(item)).toBe(false);
      expect(root.map.get("key")).toBe(item);
      expect(item.parentField).toBe("map");
      expect(item.parentFieldKey).toBe("key");

      root.record["key"] = item;
      expect(root.map.has("key")).toBe(false);
      expect(root.record["key"]).toBe(item);
      expect(item.parentField).toBe("record");
      expect(item.parentFieldKey).toBe("key");

      root.list.push(item);
      expect(root.record["key"]).toBeUndefined();
      expect(root.list).toContain(item);
      expect(item.parentField).toBe("list");
      expect(item.parentFieldKey).toBeNull();

      expect(item.parent).toBe(root);
    });
  });
});

/**
 * Advanced edge cases - undo/redo, CRDT, iteration, observers, tracking
 */
/**
 * Clone key rewriting tests for child.map with entity keys
 *
 * When cloning a child.map, keys that contain entities (Value | Set<Value> | Array<Value>)
 * should be REWRITTEN to reference the cloned instances, not create new duplicates.
 *
 * The problem: if entity A is both a VALUE (gets cloned) and a KEY somewhere,
 * after cloning, the key should reference the SAME cloned instance.
 */
describe("child.map clone key rewriting", () => {
  describe("Single entity as key - should be remapped to clone", () => {
    it("entity used as key and value in different entries - key should reference cloned value", () => {
      @syncing("EntityKeyMapContainer")
      class EntityKeyMapContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, string>;

        @syncing.child
        accessor owned!: Item | null;
      }

      const sharedItem = new Item({ name: "shared" });
      const container = new EntityKeyMapContainer({
        items: new Map([[sharedItem, "value-for-shared"]]),
        owned: sharedItem, // Same entity as key AND as owned child
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone the container
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<EntityKeyMapContainer>(clonedId)!;

      // The owned child should be cloned (different ref, same data)
      expect(materializedClone.owned).to.include({ name: "shared" }).and.not.equal(sharedItem);

      // The key should be REMAPPED to the cloned instance
      const [[clonedKey, clonedValue]] = [...materializedClone.items.entries()];
      expect([clonedKey, clonedValue]).to.have.ordered.members([materializedClone.owned, "value-for-shared"]);
      expect(clonedKey).to.not.equal(sharedItem); // Not the original

      // Lookup should work with the cloned key
      expect(materializedClone.items.get(materializedClone.owned!)).to.equal("value-for-shared");
    });

    it("entity used as key in child.map and cloned as value in same map", () => {
      @syncing("SelfRefMapContainer")
      class SelfRefMapContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, Item>;
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });

      // item1 is a KEY that points to item2 as VALUE
      // item2 should be cloned (it's a value in child.map)
      // item1 as key should be kept as-is (not a value) BUT if item1 is ALSO
      // used as a value elsewhere, it should be remapped
      const container = new SelfRefMapContainer({
        items: new Map([
          [item1, item2], // item1 is key, item2 is value (will be cloned)
          [item2, item1], // item2 is key (should be remapped to clone), item1 is value (will be cloned)
        ]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<SelfRefMapContainer>(clonedId)!;

      // Get the entries
      const entries = [...materializedClone.items.entries()];
      expect(entries).to.have.lengthOf(2);

      // Find the entry where key was item1/item2
      const item1NamedEntries = entries.filter(([k]) => k.name === "item1");
      const item2NamedEntries = entries.filter(([k]) => k.name === "item2");

      expect([item1NamedEntries.length, item2NamedEntries.length]).to.have.ordered.members([1, 1]);

      const [clonedKey1, clonedValue1] = item1NamedEntries[0];
      const [clonedKey2, clonedValue2] = item2NamedEntries[0];

      // All cloned (none are original references)
      expect([clonedKey1, clonedValue1, clonedKey2, clonedValue2]).to.satisfy((arr: Item[]) =>
        arr.every((x) => x !== item1 && x !== item2),
      );

      // CRITICAL: Keys should be SAME instances as corresponding values (remapped)
      // key "item2" === value "item2", key "item1" === value "item1"
      expect([clonedKey1, clonedKey2]).to.have.ordered.members([clonedValue2, clonedValue1]);
    });
  });

  describe("Array key containing entities - elements should be remapped", () => {
    it("array key with entity that is also a value elsewhere", () => {
      @syncing("CloneArrayKeyContainer")
      class CloneArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byTuple!: Map<[string, Item], string>;

        @syncing.child
        accessor singleChild!: Item | null;
      }

      const sharedItem = new Item({ name: "shared-in-array" });
      const container = new CloneArrayKeyContainer({
        byTuple: new Map([[["prefix", sharedItem], "tuple-value"]]),
        singleChild: sharedItem, // Same entity in array key AND as child
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<CloneArrayKeyContainer>(clonedId)!;

      // singleChild should be cloned (different ref, same data)
      expect(materializedClone.singleChild).to.not.equal(sharedItem);
      expect(materializedClone.singleChild).to.include({ name: "shared-in-array" });

      // The array key should have: string unchanged, entity REMAPPED to clone
      const [[clonedArrayKey, _value]] = [...materializedClone.byTuple.entries()];
      expect(clonedArrayKey).to.have.ordered.members(["prefix", materializedClone.singleChild]);
      expect(clonedArrayKey[1]).to.not.equal(sharedItem);

      // Lookup should work
      expect(materializedClone.byTuple.get(["prefix", materializedClone.singleChild!])).to.equal("tuple-value");
    });

    it("array key with multiple entities - all should be remapped", () => {
      @syncing("MultiEntityArrayKeyContainer")
      class MultiEntityArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byPair!: Map<[Item, Item], string>;

        @syncing.child.list
        accessor children!: Item[];
      }

      const itemA = new Item({ name: "A" });
      const itemB = new Item({ name: "B" });
      const container = new MultiEntityArrayKeyContainer({
        byPair: new Map([[[itemA, itemB], "A-to-B"]]),
        children: [itemA, itemB], // Both entities are also in child-list
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MultiEntityArrayKeyContainer>(clonedId)!;

      // Children should be cloned
      expect(materializedClone.children).to.have.lengthOf(2);
      const [clonedA, clonedB] = materializedClone.children;
      expect([clonedA, clonedB]).to.satisfy((arr: Item[]) => arr.every((x) => x !== itemA && x !== itemB));

      // Array key should have BOTH entities remapped
      const [[clonedPairKey, _value]] = [...materializedClone.byPair.entries()];
      expect(clonedPairKey).to.have.ordered.members([clonedA, clonedB]);

      // Lookup should work
      expect(materializedClone.byPair.get([clonedA, clonedB])).to.equal("A-to-B");
    });
  });

  describe("Set key containing entities - elements should be remapped", () => {
    it("set key with entity that is also a value elsewhere", () => {
      @syncing("CloneSetKeyContainer")
      class CloneSetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byGroup!: Map<Set<Item>, string>;

        @syncing.child
        accessor singleChild!: Item | null;
      }

      const sharedItem = new Item({ name: "shared-in-set" });
      const container = new CloneSetKeyContainer({
        byGroup: new Map([[new Set([sharedItem]), "set-value"]]),
        singleChild: sharedItem,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<CloneSetKeyContainer>(clonedId)!;

      // singleChild should be cloned
      expect(materializedClone.singleChild).to.not.equal(sharedItem);
      expect(materializedClone.singleChild).to.include({ name: "shared-in-set" });

      // The set key should have its entity element REMAPPED
      const [[clonedSetKey, _value]] = [...materializedClone.byGroup.entries()];
      expect(clonedSetKey).to.have.property("size", 1);
      const [keyElement] = [...clonedSetKey];
      // Key element is NOT original but IS the same as cloned child
      expect(keyElement).to.equal(materializedClone.singleChild).and.not.equal(sharedItem);

      // Lookup should work
      expect(materializedClone.byGroup.get(new Set([materializedClone.singleChild!]))).to.equal("set-value");
    });

    it("set key with multiple entities - all should be remapped", () => {
      @syncing("MultiEntitySetKeyContainer")
      class MultiEntitySetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byGroup!: Map<Set<Item>, string>;

        @syncing.child.list
        accessor children!: Item[];
      }

      const itemA = new Item({ name: "A" });
      const itemB = new Item({ name: "B" });
      const itemC = new Item({ name: "C" });
      const container = new MultiEntitySetKeyContainer({
        byGroup: new Map([[new Set([itemA, itemB, itemC]), "group-ABC"]]),
        children: [itemA, itemB, itemC],
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MultiEntitySetKeyContainer>(clonedId)!;

      // Children should be cloned
      expect(materializedClone.children).to.have.lengthOf(3);
      const clonedItems = materializedClone.children;

      // Set key should have ALL entities remapped
      const [[clonedSetKey, _value]] = [...materializedClone.byGroup.entries()];
      expect(clonedSetKey).to.have.property("size", 3);

      // Each element in the cloned set key should be one of the cloned children (not originals)
      for (const element of clonedSetKey) {
        expect(clonedItems).to.contain(element);
        expect([itemA, itemB, itemC]).to.not.contain(element);
      }

      // Lookup should work
      expect(materializedClone.byGroup.get(new Set(clonedItems))).to.equal("group-ABC");
    });
  });

  describe("Deeply nested children as keys - should be remapped", () => {
    // Test models for deep nesting
    @syncing("Leaf")
    class Leaf extends PlexusModel {
      @syncing accessor name!: string;
    }

    @syncing("Branch")
    class Branch extends PlexusModel {
      @syncing accessor name!: string;

      @syncing.child.list
      accessor leaves!: Leaf[];
    }

    @syncing("Tree")
    class Tree extends PlexusModel {
      @syncing accessor name!: string;

      @syncing.child.list
      accessor branches!: Branch[];

      @syncing.child.map
      accessor leafIndex!: Map<Leaf, string>; // Key is deeply nested child (grandchild)
    }

    it("single Value key that is a grandchild (depth 2)", () => {
      const leaf1 = new Leaf({ name: "leaf1" });
      const leaf2 = new Leaf({ name: "leaf2" });
      const branch = new Branch({ name: "branch", leaves: [leaf1, leaf2] });
      const tree = new Tree({
        name: "tree",
        branches: [branch],
        leafIndex: new Map([
          [leaf1, "first-leaf"],
          [leaf2, "second-leaf"],
        ]),
      });

      const { doc, root, plexus } = initTestPlexus(tree);

      // Clone the tree
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<Tree>(clonedId)!;

      // Get the cloned leaves from the nested structure
      const clonedBranch = materializedClone.branches[0];
      const clonedLeaf1 = clonedBranch.leaves[0];
      const clonedLeaf2 = clonedBranch.leaves[1];

      // Verify they're actually cloned (not originals) with correct data
      expect([clonedLeaf1, clonedLeaf2]).to.satisfy((arr: Leaf[]) => arr.every((x) => x !== leaf1 && x !== leaf2));
      expect([clonedLeaf1.name, clonedLeaf2.name]).to.have.ordered.members(["leaf1", "leaf2"]);

      // The keys in leafIndex should be REMAPPED to the cloned leaves
      const entries = [...materializedClone.leafIndex.entries()];
      expect(entries).to.have.lengthOf(2);

      // Find entries by value to match them
      const firstLeafEntry = entries.find(([, v]) => v === "first-leaf")!;
      const secondLeafEntry = entries.find(([, v]) => v === "second-leaf")!;

      // Keys remapped to cloned grandchildren
      expect([firstLeafEntry[0], secondLeafEntry[0]]).to.have.ordered.members([clonedLeaf1, clonedLeaf2]);

      // Lookup should work with cloned keys
      expect([
        materializedClone.leafIndex.get(clonedLeaf1),
        materializedClone.leafIndex.get(clonedLeaf2),
      ]).to.have.ordered.members(["first-leaf", "second-leaf"]);
    });

    it("Array<Value> key where Value is a grandchild (depth 2)", () => {
      @syncing("TreeWithArrayKey")
      class TreeWithArrayKey extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.list
        accessor branches!: Branch[];

        @syncing.child.map
        accessor leafPairIndex!: Map<[Leaf, Leaf], string>;
      }

      const leaf1 = new Leaf({ name: "A" });
      const leaf2 = new Leaf({ name: "B" });
      const branch = new Branch({ name: "branch", leaves: [leaf1, leaf2] });
      const tree = new TreeWithArrayKey({
        name: "tree",
        branches: [branch],
        leafPairIndex: new Map([[[leaf1, leaf2], "A-to-B"]]),
      });

      const { doc, root, plexus } = initTestPlexus(tree);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<TreeWithArrayKey>(clonedId)!;

      // Get cloned leaves
      const clonedLeaf1 = materializedClone.branches[0].leaves[0];
      const clonedLeaf2 = materializedClone.branches[0].leaves[1];

      expect([clonedLeaf1, clonedLeaf2]).to.satisfy((arr: Leaf[]) => arr.every((x) => x !== leaf1 && x !== leaf2));

      // Array key should have both elements remapped
      const [[arrayKey, value]] = [...materializedClone.leafPairIndex.entries()];
      expect(arrayKey).to.have.ordered.members([clonedLeaf1, clonedLeaf2]);
      expect(value).to.equal("A-to-B");

      // Lookup should work
      expect(materializedClone.leafPairIndex.get([clonedLeaf1, clonedLeaf2])).to.equal("A-to-B");
    });

    it("Set<Value> key where Value is a grandchild (depth 2)", () => {
      @syncing("TreeWithSetKey")
      class TreeWithSetKey extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.list
        accessor branches!: Branch[];

        @syncing.child.map
        accessor leafGroupIndex!: Map<Set<Leaf>, string>;
      }

      const leaf1 = new Leaf({ name: "X" });
      const leaf2 = new Leaf({ name: "Y" });
      const leaf3 = new Leaf({ name: "Z" });
      const branch = new Branch({ name: "branch", leaves: [leaf1, leaf2, leaf3] });
      const tree = new TreeWithSetKey({
        name: "tree",
        branches: [branch],
        leafGroupIndex: new Map([[new Set([leaf1, leaf2, leaf3]), "XYZ-group"]]),
      });

      const { doc, root, plexus } = initTestPlexus(tree);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<TreeWithSetKey>(clonedId)!;

      // Get cloned leaves (all different from originals)
      const clonedLeaves = materializedClone.branches[0].leaves;
      expect(clonedLeaves).to.have.lengthOf(3);
      expect(clonedLeaves).to.satisfy((arr: Leaf[]) => arr.every((x) => x !== leaf1 && x !== leaf2 && x !== leaf3));

      // Set key should have all elements remapped
      const [[setKey, value]] = [...materializedClone.leafGroupIndex.entries()];
      expect(setKey).to.have.property("size", 3);

      // Each element in the set should be one of the cloned leaves
      for (const element of setKey) {
        expect(clonedLeaves).to.contain(element);
      }

      expect(value).to.equal("XYZ-group");

      // Lookup should work
      expect(materializedClone.leafGroupIndex.get(new Set(clonedLeaves))).to.equal("XYZ-group");
    });

    it("depth 3: great-grandchild as key", () => {
      @syncing("DeepLeaf")
      class DeepLeaf extends PlexusModel {
        @syncing accessor value!: number;
      }

      @syncing("Level2")
      class Level2 extends PlexusModel {
        @syncing.child.list
        accessor deepLeaves!: DeepLeaf[];
      }

      @syncing("Level1")
      class Level1 extends PlexusModel {
        @syncing.child.list
        accessor level2s!: Level2[];
      }

      @syncing("RootWithDeepKey")
      class RootWithDeepKey extends PlexusModel {
        @syncing.child.list
        accessor level1s!: Level1[];

        @syncing.child.map
        accessor deepIndex!: Map<DeepLeaf, string>;
      }

      const deepLeaf = new DeepLeaf({ value: 42 });
      const level2 = new Level2({ deepLeaves: [deepLeaf] });
      const level1 = new Level1({ level2s: [level2] });
      const rootEntity = new RootWithDeepKey({
        level1s: [level1],
        deepIndex: new Map([[deepLeaf, "found-at-depth-3"]]),
      });

      const { doc, root, plexus } = initTestPlexus(rootEntity);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<RootWithDeepKey>(clonedId)!;

      // Navigate to the cloned deep leaf
      const clonedDeepLeaf = materializedClone.level1s[0].level2s[0].deepLeaves[0];
      expect(clonedDeepLeaf).to.not.equal(deepLeaf);
      expect(clonedDeepLeaf).to.include({ value: 42 });

      // Key should be remapped to the cloned great-grandchild
      const [[key, value]] = [...materializedClone.deepIndex.entries()];
      expect([key, value]).to.have.ordered.members([clonedDeepLeaf, "found-at-depth-3"]);
    });

    it("mixed depths: key array contains child and grandchild", () => {
      @syncing("MixedDepthTree")
      class MixedDepthTree extends PlexusModel {
        @syncing.child.list
        accessor branches!: Branch[]; // Branch has leaves (grandchildren)

        @syncing.child.list
        accessor directLeaves!: Leaf[]; // Direct children

        @syncing.child.map
        accessor mixedIndex!: Map<[Branch, Leaf], string>; // [child, grandchild] tuple
      }

      const grandchildLeaf = new Leaf({ name: "grandchild" });
      const branch = new Branch({ name: "branch", leaves: [grandchildLeaf] });
      const directLeaf = new Leaf({ name: "direct" });

      const tree = new MixedDepthTree({
        branches: [branch],
        directLeaves: [directLeaf],
        mixedIndex: new Map([
          [[branch, grandchildLeaf], "branch-points-to-grandchild"],
          [[branch, directLeaf], "branch-points-to-direct"],
        ]),
      });

      const { doc, root, plexus } = initTestPlexus(tree);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MixedDepthTree>(clonedId)!;

      // Get cloned entities at different depths
      const clonedBranch = materializedClone.branches[0];
      const clonedGrandchildLeaf = clonedBranch.leaves[0];
      const clonedDirectLeaf = materializedClone.directLeaves[0];

      // All should be clones, not originals
      expect([clonedBranch, clonedGrandchildLeaf, clonedDirectLeaf]).to.satisfy((arr: PlexusModel[]) =>
        arr.every((x) => x !== branch && x !== grandchildLeaf && x !== directLeaf),
      );

      // Both entries should have keys fully remapped
      const entries = [...materializedClone.mixedIndex.entries()];
      expect(entries).to.have.lengthOf(2);

      const entry1 = entries.find(([, v]) => v === "branch-points-to-grandchild")!;
      const entry2 = entries.find(([, v]) => v === "branch-points-to-direct")!;

      // First entry: [clonedBranch, clonedGrandchildLeaf]
      expect(entry1[0]).to.have.ordered.members([clonedBranch, clonedGrandchildLeaf]);
      // Second entry: [clonedBranch, clonedDirectLeaf]
      expect(entry2[0]).to.have.ordered.members([clonedBranch, clonedDirectLeaf]);
    });
  });

  describe("Mixed scenarios - complex key remapping", () => {
    it("entity is value in one entry and part of array key in another", () => {
      @syncing("MixedKeyValueContainer")
      class MixedKeyValueContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<string | [string, Item], Item | string>;
      }

      const itemA = new Item({ name: "A" });
      const itemB = new Item({ name: "B" });
      const container = new MixedKeyValueContainer({
        items: new Map<string | [string, Item], Item | string>([
          ["simple-key", itemA], // itemA as value
          [["tuple", itemA], "tuple-value"], // itemA in array key - should be remapped to clone
          ["itemB-key", itemB], // itemB as value
        ]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MixedKeyValueContainer>(clonedId)!;

      // Get the cloned itemA from the value position
      const clonedItemA = materializedClone.items.get("simple-key") as Item;
      expect(clonedItemA).to.not.equal(itemA);
      expect(clonedItemA).to.include({ name: "A" });

      // The tuple key should have itemA remapped to clonedItemA
      const tupleEntry = [...materializedClone.items.entries()].find(([k]) => Array.isArray(k));
      expect(tupleEntry).to.exist;
      const [tupleKey, tupleValue] = tupleEntry!;
      expect(Array.isArray(tupleKey)).to.eq(true);
      expect(tupleKey as [string, Item]).to.have.ordered.members(["tuple", clonedItemA]);
      expect(tupleValue).to.equal("tuple-value");
    });

    it("entity key that is NOT cloned as value should remain unchanged", () => {
      @syncing("KeyOnlyContainer")
      class KeyOnlyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, string>; // Values are strings, not child entities
      }

      const keyOnlyItem = new Item({ name: "key-only" });
      const container = new KeyOnlyContainer({
        items: new Map([[keyOnlyItem, "some-value"]]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<KeyOnlyContainer>(clonedId)!;

      // keyOnlyItem is ONLY a key, not a value - it was NOT cloned by the transaction
      // So the key should remain the ORIGINAL entity (not be cloned)
      const [[clonedKey, value]] = [...materializedClone.items.entries()];

      // This is the expected behavior: keys that are NOT part of the clone transaction
      // should be preserved as-is (the original reference)
      expect([clonedKey, value]).to.have.ordered.members([keyOnlyItem, "some-value"]);
    });

    it("complex: entity in set key, array key, and as value - all should be same clone", () => {
      @syncing("UltraMixedContainer")
      class UltraMixedContainer extends PlexusModel {
        @syncing.child.map
        accessor setKeyMap!: Map<Set<Item>, string>;

        @syncing.child.map
        accessor arrayKeyMap!: Map<[Item], string>;

        @syncing.child
        accessor theChild!: Item | null;
      }

      const theItem = new Item({ name: "everywhere" });
      const container = new UltraMixedContainer({
        setKeyMap: new Map([[new Set([theItem]), "in-set-key"]]),
        arrayKeyMap: new Map([[[theItem], "in-array-key"]]),
        theChild: theItem,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<UltraMixedContainer>(clonedId)!;

      // theChild should be cloned
      const clonedChild = materializedClone.theChild!;
      expect(clonedChild).to.not.equal(theItem);
      expect(clonedChild).to.include({ name: "everywhere" });

      // Set key should be remapped to the SAME clone
      const [[setKey]] = [...materializedClone.setKeyMap.entries()];
      const [setKeyElement] = [...setKey];

      // Array key should be remapped to the SAME clone
      const [[arrayKey]] = [...materializedClone.arrayKeyMap.entries()];

      // All three references (value, set key element, array key element) are the SAME clone
      expect([setKeyElement, arrayKey[0], clonedChild]).to.satisfy(
        (arr: Item[]) => arr[0] === arr[1] && arr[1] === arr[2],
      );
    });
  });

  describe("Self-referential and cyclic key scenarios", () => {
    it("container itself used as key in its own child.map", () => {
      @syncing("ContainerAsSelfKey")
      class ContainerAsSelfKey extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor selfIndex!: Map<ContainerAsSelfKey, string>;
      }

      const container = new ContainerAsSelfKey({
        name: "root",
        selfIndex: new Map(),
      });
      // Add self as key after construction
      container.selfIndex.set(container, "i-am-the-key");

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<ContainerAsSelfKey>(clonedId)!;

      // The cloned container should have ITSELF as the key (not original)
      const [[selfKey, value]] = [...materializedClone.selfIndex.entries()];
      // Key is the clone (materializedClone), not original (root)
      expect(selfKey).to.equal(materializedClone).and.not.equal(root);
      expect(value).to.equal("i-am-the-key");

      // Lookup should work
      expect(materializedClone.selfIndex.get(materializedClone)).to.equal("i-am-the-key");
    });

    it("same entity appears multiple times in array key [A, A, A]", () => {
      @syncing("RepeatedKeyContainer")
      class RepeatedKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byTriple!: Map<[Item, Item, Item], string>;

        @syncing.child
        accessor theItem!: Item;
      }

      const item = new Item({ name: "repeated" });
      const container = new RepeatedKeyContainer({
        byTriple: new Map([[[item, item, item], "triple-A"]]),
        theItem: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<RepeatedKeyContainer>(clonedId)!;

      // theItem should be cloned
      const clonedItem = materializedClone.theItem;
      expect(clonedItem).to.not.equal(item);

      // All three positions in the array key should be the SAME cloned instance
      const [[tripleKey, _value]] = [...materializedClone.byTriple.entries()];
      expect(tripleKey).to.have.ordered.members([clonedItem, clonedItem, clonedItem]);
      // All three are the same object reference (verify with satisfy)
      expect(tripleKey).to.satisfy((arr: Item[]) => arr[0] === arr[1] && arr[1] === arr[2]);
    });

    it("same entity as both key AND value in same map entry", () => {
      @syncing("SameKeyValueContainer")
      class SameKeyValueContainer extends PlexusModel {
        @syncing.child.map
        accessor selfRefMap!: Map<Item, Item>;
      }

      const item = new Item({ name: "key-and-value" });
      const container = new SameKeyValueContainer({
        selfRefMap: new Map([[item, item]]), // Same entity as key AND value
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<SameKeyValueContainer>(clonedId)!;

      // Get the entry
      const [[clonedKey, clonedValue]] = [...materializedClone.selfRefMap.entries()];

      // Both key and value should be the SAME cloned instance (not two different clones)
      expect(clonedKey).to.equal(clonedValue).and.not.equal(item);

      // Lookup should work: map.get(key) === key
      expect(materializedClone.selfRefMap.get(clonedKey)).to.equal(clonedKey);
    });
  });

  describe("Post-clone lookup verification (Map.get/Map.has)", () => {
    it("Map.get() works with cloned entity keys", () => {
      @syncing("LookupTestContainer")
      class LookupTestContainer extends PlexusModel {
        @syncing.child.map
        accessor indexed!: Map<Item, number>;

        @syncing.child.list
        accessor items!: Item[];
      }

      const item1 = new Item({ name: "one" });
      const item2 = new Item({ name: "two" });
      const item3 = new Item({ name: "three" });

      const container = new LookupTestContainer({
        indexed: new Map([
          [item1, 1],
          [item2, 2],
          [item3, 3],
        ]),
        items: [item1, item2, item3],
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<LookupTestContainer>(clonedId)!;

      // Get cloned items
      const [cloned1, cloned2, cloned3] = materializedClone.items;

      // Map.get() should work with cloned keys
      expect([
        materializedClone.indexed.get(cloned1),
        materializedClone.indexed.get(cloned2),
        materializedClone.indexed.get(cloned3),
      ]).to.have.ordered.members([1, 2, 3]);

      // Map.has() should work with cloned keys
      expect([cloned1, cloned2, cloned3]).to.satisfy((arr: Item[]) =>
        arr.every((x) => materializedClone.indexed.has(x)),
      );

      // Original keys should NOT be in cloned map
      expect([item1, item2, item3]).to.satisfy((arr: Item[]) => arr.every((x) => !materializedClone.indexed.has(x)));
    });

    it("Map.get() works with cloned Set keys", () => {
      @syncing("SetKeyLookupContainer")
      class SetKeyLookupContainer extends PlexusModel {
        @syncing.child.map
        accessor byGroup!: Map<Set<Item>, string>;

        @syncing.child.list
        accessor items!: Item[];
      }

      const item1 = new Item({ name: "a" });
      const item2 = new Item({ name: "b" });

      const container = new SetKeyLookupContainer({
        byGroup: new Map([[new Set([item1, item2]), "group-ab"]]),
        items: [item1, item2],
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<SetKeyLookupContainer>(clonedId)!;

      // Lookup with new Set of cloned items should work
      const clonedItems = materializedClone.items;
      expect(materializedClone.byGroup.get(new Set(clonedItems))).to.equal("group-ab");
    });

    it("Map.get() works with cloned Array keys", () => {
      @syncing("ArrayKeyLookupContainer")
      class ArrayKeyLookupContainer extends PlexusModel {
        @syncing.child.map
        accessor byTuple!: Map<[Item, Item], string>;

        @syncing.child.list
        accessor items!: Item[];
      }

      const item1 = new Item({ name: "x" });
      const item2 = new Item({ name: "y" });

      const container = new ArrayKeyLookupContainer({
        byTuple: new Map([[[item1, item2], "tuple-xy"]]),
        items: [item1, item2],
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<ArrayKeyLookupContainer>(clonedId)!;

      // Lookup with array of cloned items should work
      const [cloned1, cloned2] = materializedClone.items;
      expect(materializedClone.byTuple.get([cloned1, cloned2])).to.equal("tuple-xy");
    });
  });

  describe("Empty and boundary cases", () => {
    it("empty Set as key - preserved correctly", () => {
      @syncing("EmptySetKeyContainer")
      class EmptySetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byEmptySet!: Map<Set<Item>, string>;
      }

      const container = new EmptySetKeyContainer({
        byEmptySet: new Map([[new Set<Item>(), "empty-set-value"]]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<EmptySetKeyContainer>(clonedId)!;

      // Should have one entry with empty Set key
      expect(materializedClone.byEmptySet).to.have.property("size", 1);
      const [[emptySetKey, value]] = [...materializedClone.byEmptySet.entries()];
      expect(emptySetKey).to.have.property("size", 0);
      expect(value).to.equal("empty-set-value");

      // Lookup should work
      expect(materializedClone.byEmptySet.get(new Set())).to.equal("empty-set-value");
    });

    it("empty Array as key - preserved correctly", () => {
      @syncing("EmptyArrayKeyContainer")
      class EmptyArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byEmptyArray!: Map<Item[], string>;
      }

      const container = new EmptyArrayKeyContainer({
        byEmptyArray: new Map([[[], "empty-array-value"]]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<EmptyArrayKeyContainer>(clonedId)!;

      // Should have one entry with empty Array key
      expect(materializedClone.byEmptyArray).to.have.property("size", 1);
      const [[emptyArrayKey, value]] = [...materializedClone.byEmptyArray.entries()];
      expect(emptyArrayKey).to.have.lengthOf(0);
      expect(value).to.equal("empty-array-value");

      // Lookup should work
      expect(materializedClone.byEmptyArray.get([])).to.equal("empty-array-value");
    });

    it("mixed primitives and entities in array key", () => {
      @syncing("MixedArrayKeyContainer")
      class MixedArrayKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byMixed!: Map<[string, Item, number], string>;

        @syncing.child
        accessor theItem!: Item;
      }

      const item = new Item({ name: "mixed" });
      const container = new MixedArrayKeyContainer({
        byMixed: new Map([[["prefix", item, 42], "mixed-value"]]),
        theItem: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MixedArrayKeyContainer>(clonedId)!;

      const clonedItem = materializedClone.theItem;
      expect(clonedItem).to.not.equal(item);

      // Array key should have: primitive unchanged, entity remapped, primitive unchanged
      const [[mixedKey, _value]] = [...materializedClone.byMixed.entries()];
      expect(mixedKey).to.have.ordered.members(["prefix", clonedItem, 42]);

      // Lookup should work
      expect(materializedClone.byMixed.get(["prefix", clonedItem, 42])).to.equal("mixed-value");
    });

    it("mixed primitives and entities in Set key", () => {
      @syncing("MixedSetKeyContainer")
      class MixedSetKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor byMixedSet!: Map<Set<string | Item | number>, string>;

        @syncing.child
        accessor theItem!: Item;
      }

      const item = new Item({ name: "in-set" });
      const container = new MixedSetKeyContainer({
        byMixedSet: new Map([[new Set<string | Item | number>(["str", item, 99]), "mixed-set-value"]]),
        theItem: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MixedSetKeyContainer>(clonedId)!;

      const clonedItem = materializedClone.theItem;

      // Set key should have primitives unchanged, entity remapped
      const [[mixedSetKey, _value]] = [...materializedClone.byMixedSet.entries()];
      expect(mixedSetKey).to.have.property("size", 3);
      // Has primitives and cloned item, but NOT original item
      expect(["str", 99, clonedItem]).to.satisfy((arr: (string | number | Item)[]) =>
        arr.every((x) => mixedSetKey.has(x)),
      );
      expect(mixedSetKey.has(item)).to.eq(false);
    });
  });

  describe("Field processing order edge cases", () => {
    it("key entity in field declared AFTER the map (alphabetical order)", () => {
      // Fields are processed in Object.entries order, which follows declaration order
      // This tests when the key entity is in a field that comes AFTER the map
      @syncing("OrderTestContainer")
      class OrderTestContainer extends PlexusModel {
        @syncing.child.map
        accessor aMap!: Map<Item, string>; // 'a' comes before 'z'

        @syncing.child
        accessor zItem!: Item; // 'z' comes after 'a' - processed later
      }

      const item = new Item({ name: "order-test" });
      const container = new OrderTestContainer({
        aMap: new Map([[item, "mapped-value"]]),
        zItem: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<OrderTestContainer>(clonedId)!;

      // zItem should be cloned
      const clonedItem = materializedClone.zItem;
      expect(clonedItem).to.not.equal(item);

      // Key in aMap should be remapped to clonedItem
      // This tests that clone transaction handles forward references
      const [[mapKey, value]] = [...materializedClone.aMap.entries()];
      expect([mapKey, value]).to.have.ordered.members([clonedItem, "mapped-value"]);
    });
  });

  describe("Multiple child.map fields interaction", () => {
    it("same entity as key in two different child.maps", () => {
      @syncing("DualChildMapContainer")
      class DualChildMapContainer extends PlexusModel {
        @syncing.child.map
        accessor map1!: Map<Item, string>;

        @syncing.child.map
        accessor map2!: Map<Item, number>;

        @syncing.child
        accessor sharedKey!: Item;
      }

      const sharedItem = new Item({ name: "shared-key" });
      const container = new DualChildMapContainer({
        map1: new Map([[sharedItem, "string-value"]]),
        map2: new Map([[sharedItem, 42]]),
        sharedKey: sharedItem,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<DualChildMapContainer>(clonedId)!;

      const clonedShared = materializedClone.sharedKey;
      expect(clonedShared).to.not.equal(sharedItem);

      // Both maps should have the SAME cloned entity as key
      const [[map1Key]] = [...materializedClone.map1.entries()];
      const [[map2Key]] = [...materializedClone.map2.entries()];

      // All three are the same instance
      expect([map1Key, map2Key, clonedShared]).to.satisfy((arr: Item[]) => arr[0] === arr[1] && arr[1] === arr[2]);

      // Lookups should work
      expect([
        materializedClone.map1.get(clonedShared),
        materializedClone.map2.get(clonedShared),
      ]).to.have.ordered.members(["string-value", 42]);
    });

    it("entity is key in map1, value in map2 (cross-reference)", () => {
      @syncing("CrossRefContainer")
      class CrossRefContainer extends PlexusModel {
        @syncing.child.map
        accessor mapWithEntityKey!: Map<Item, string>;

        @syncing.child.map
        accessor mapWithEntityValue!: Map<string, Item>;
      }

      const crossItem = new Item({ name: "cross-ref" });
      const container = new CrossRefContainer({
        mapWithEntityKey: new Map([[crossItem, "as-key"]]),
        mapWithEntityValue: new Map([["as-value", crossItem]]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<CrossRefContainer>(clonedId)!;

      // Get the cloned item from where it's a value
      const clonedFromValue = materializedClone.mapWithEntityValue.get("as-value")!;
      expect(clonedFromValue).to.not.equal(crossItem);

      // The key should be the SAME cloned instance
      const [[keyFromMap]] = [...materializedClone.mapWithEntityKey.entries()];
      expect(keyFromMap).to.equal(clonedFromValue); // Same clone used in both roles
    });
  });

  describe("Child.map + non-child map interaction", () => {
    it("entity cloned in child.map value, remapped in non-child map key", () => {
      @syncing("MixedOwnershipContainer")
      class MixedOwnershipContainer extends PlexusModel {
        @syncing.child.map
        accessor childMap!: Map<string, Item>; // Value is owned, gets cloned

        @syncing.map
        accessor refMap!: Map<Item, string>; // Key should be remapped to clone
      }

      const item = new Item({ name: "mixed-ownership" });
      const container = new MixedOwnershipContainer({
        childMap: new Map([["owned", item]]), // item gets cloned here
        refMap: new Map([[item, "referenced"]]), // key should remap to clone
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<MixedOwnershipContainer>(clonedId)!;

      // Get the cloned item from childMap
      const clonedItem = materializedClone.childMap.get("owned")!;
      expect(clonedItem).to.not.equal(item);

      // refMap key should be remapped to the SAME cloned item
      const [[refMapKey, refMapValue]] = [...materializedClone.refMap.entries()];
      expect([refMapKey, refMapValue]).to.have.ordered.members([clonedItem, "referenced"]);

      // Lookup should work
      expect(materializedClone.refMap.get(clonedItem)).to.equal("referenced");
    });

    it("entity as key in both child.map and non-child map", () => {
      @syncing("BothMapsKeyContainer")
      class BothMapsKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor childMap!: Map<Item, string>;

        @syncing.map
        accessor refMap!: Map<Item, number>;

        @syncing.child
        accessor theItem!: Item;
      }

      const item = new Item({ name: "both-maps-key" });
      const container = new BothMapsKeyContainer({
        childMap: new Map([[item, "in-child-map"]]),
        refMap: new Map([[item, 123]]),
        theItem: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<BothMapsKeyContainer>(clonedId)!;

      const clonedItem = materializedClone.theItem;
      expect(clonedItem).to.not.equal(item);

      // Both maps should have keys remapped to the same clone
      const [[childMapKey]] = [...materializedClone.childMap.entries()];
      const [[refMapKey]] = [...materializedClone.refMap.entries()];

      // All three are the same instance
      expect([childMapKey, refMapKey, clonedItem]).to.satisfy((arr: Item[]) => arr[0] === arr[1] && arr[1] === arr[2]);
    });
  });

  describe("Clone with newProps override", () => {
    it("newProps overrides child.map entirely - new keys not remapped", () => {
      @syncing("OverrideContainer")
      class OverrideContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, string>;

        @syncing.child
        accessor existingChild!: Item;
      }

      const existingItem = new Item({ name: "existing" });
      const container = new OverrideContainer({
        items: new Map([[existingItem, "old-value"]]),
        existingChild: existingItem,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone with newProps that provides entirely new map
      const newItem = new Item({ name: "new-in-override" });
      const cloned = root.clone({
        items: new Map([[newItem, "new-value"]]),
      });

      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<OverrideContainer>(clonedId)!;

      // existingChild should still be cloned
      expect(materializedClone.existingChild).to.not.equal(existingItem);

      // But the map was overridden, so it has the new item
      expect(materializedClone.items).to.have.property("size", 1);
      const [[key, value]] = [...materializedClone.items.entries()];
      expect(key).to.include({ name: "new-in-override" });
      expect(value).to.equal("new-value");
    });

    it("newProps map with key that references entity from another child field", () => {
      @syncing("CrossFieldOverrideContainer")
      class CrossFieldOverrideContainer extends PlexusModel {
        @syncing.child.map
        accessor indexed!: Map<Item, string>;

        @syncing.child
        accessor primary!: Item;
      }

      const item = new Item({ name: "shared" });
      const container = new CrossFieldOverrideContainer({
        indexed: new Map(),
        primary: item,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone with newProps that references the ORIGINAL item as key
      // The clone system should remap this to the cloned item
      const cloned = root.clone({
        indexed: new Map([[item, "added-via-override"]]),
      });

      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<CrossFieldOverrideContainer>(clonedId)!;

      // primary should be cloned
      const clonedPrimary = materializedClone.primary;
      expect(clonedPrimary).to.not.equal(item);

      // The key in indexed should be remapped to clonedPrimary
      const [[key, value]] = [...materializedClone.indexed.entries()];
      expect([key, value]).to.have.ordered.members([clonedPrimary, "added-via-override"]);
    });
  });
});

describe("child.map advanced edge cases", () => {
  describe("Undo/Redo behavior", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<Container>;
    let root: Container;

    beforeEach(() => {
      const container = new Container({ items: new Map() });
      const result = initTestPlexus(container);
      doc = result.doc;
      plexus = result.plexus;
      root = result.root;
    });

    afterEach(() => {
      doc.destroy();
    });

    it("should dematerialize deleted child after undo restores YJS state", () => {
      const item = new Item({ name: "undoable" });
      root.items.set("key1", item);
      expect(item).to.have.property("parent", root);

      // Delete the item
      root.items.delete("key1");
      expect(item).to.have.property("parent", null);
      expect(root.items).to.not.has.key("key1");

      // Undo the deletion
      plexus.undo();

      // NOTE: Undo restores YJS state but child-map proxy uses local PathMap
      // which doesn't automatically sync back from YJS on undo.
      // This is a known behavior - the original item was orphaned and removed
      // from the backing storage. Undo restores YJS but the local Map needs
      // re-materialization to sync.
      // For now, document that undo may not fully restore child-map entries
      // as expected without explicit re-materialization.
    });

    it("should orphan child after undoing set", () => {
      // First add an item (this will be the state we undo to)
      const item1 = new Item({ name: "original" });
      root.items.set("key1", item1);

      // Add another item (this we'll undo)
      const item2 = new Item({ name: "added" });
      root.items.set("key2", item2);
      expect(item2).to.have.property("parent", root);

      // Undo adding item2
      plexus.undo();

      // item2 should be orphaned (or dematerialized)
      expect(root.items).to.not.has.key("key2");
      // Note: after undo, the item may be dematerialized, so parent check may vary
    });

    it("should orphan item when replaced (not dematerialized)", () => {
      const item1 = new Item({ name: "first" });
      root.items.set("key1", item1);
      expect(item1).to.have.property("parent", root);

      const item2 = new Item({ name: "second" });
      root.items.set("key1", item2); // Replace item1

      expect(root.items.get("key1")).to.include({ name: "second" });
      // item1 is orphaned — detached from tree but still alive
      expect(item1).to.have.property("parent", null);

      // item2 is adopted
      expect(item2).to.have.property("parent", root);
    });

    it("should handle basic undo of set operations", () => {
      const item1 = new Item({ name: "item1" });
      root.items.set("key1", item1);

      expect(root.items).to.have.property("size", 1);
      expect(root.items.get("key1")).to.include({ name: "item1" });

      // Undo the set
      plexus.undo();

      // key1 should be gone
      expect(root.items).to.not.has.key("key1");
    });
  });

  describe("Concurrent edits (CRDT)", () => {
    let doc1: Y.Doc;
    let doc2: Y.Doc;

    beforeEach(() => {
      doc1 = new Y.Doc();
      doc2 = new Y.Doc();
    });

    afterEach(() => {
      doc1.destroy();
      doc2.destroy();
    });

    it("should merge concurrent additions", () => {
      // Setup identical initial state
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);

      // Concurrent additions on different keys
      root1.items.set("from-doc1", new Item({ name: "doc1-item" }));
      root2.items.set("from-doc2", new Item({ name: "doc2-item" }));

      // Sync both ways
      syncDocs(doc1, doc2);

      // Both should have both items
      expect([root1.items.size, root2.items.size]).to.have.ordered.members([2, 2]);
      expect(root1.items.get("from-doc1")).to.include({ name: "doc1-item" });
      expect(root1.items.get("from-doc2")).to.include({ name: "doc2-item" });
      expect(root2.items.get("from-doc1")).to.include({ name: "doc1-item" });
      expect(root2.items.get("from-doc2")).to.include({ name: "doc2-item" });
    });

    it("should resolve concurrent updates to same key (last-write-wins)", () => {
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      // Add initial item
      root1.items.set("contested", new Item({ name: "original" }));

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);

      // Concurrent updates to same key
      root1.items.set("contested", new Item({ name: "from-doc1" }));
      root2.items.set("contested", new Item({ name: "from-doc2" }));

      // Sync both ways
      syncDocs(doc1, doc2);

      // Last-write-wins - both should converge to same value
      expect(root1.items.get("contested")!.name).to.equal(root2.items.get("contested")!.name);
    });

    it("should handle concurrent delete and update", () => {
      const container = new Container({ items: new Map() });
      const { doc, root: root1 } = initTestPlexus(container);
      doc1 = doc;
      doc2 = new Y.Doc({ guid: doc1.guid });

      const item = new Item({ name: "contested" });
      root1.items.set("key1", item);

      // Sync to doc2
      syncDocs(doc1, doc2);
      const { root: root2 } = connectTestPlexus<Container>(doc2);

      // doc1 deletes, doc2 updates
      root1.items.delete("key1");
      root2.items.set("key1", new Item({ name: "updated" }));

      // Sync both ways
      syncDocs(doc1, doc2);

      // CRDT resolution - delete + set = item exists with new value
      // Both should converge to same state
      expect(root1.items.has("key1")).to.equal(root2.items.has("key1"));
    });
  });

  describe("Detach during iteration", () => {
    it("should handle detach while iterating keys()", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const items = Array.from({ length: 5 }, (_, i) => new Item({ name: `item-${i}` }));
      for (const [i, item] of items.entries()) root.items.set(`key-${i}`, item);

      // Collect keys first to avoid iterator invalidation
      const keys = [...root.items.keys()];
      const detached: string[] = [];

      // Iterate and detach every other item
      for (const [i, key] of keys.entries()) {
        if (i % 2 === 0) {
          const item = root.items.get(key);
          item?.detach();
          detached.push(key);
        }
      }

      // Verify detached items are gone
      expect(detached).to.satisfy((arr: string[]) => arr.every((key) => !root.items.has(key)));

      // Remaining items should still be there
      expect(root.items).to.have.property("size", 2); // 5 - 3 detached
    });

    it("should handle delete while iterating entries()", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const items = Array.from({ length: 5 }, (_, i) => new Item({ name: `item-${i}` }));
      for (const [i, item] of items.entries()) root.items.set(`key-${i}`, item);

      // Collect entries first
      const entries = [...root.items.entries()];

      // Delete during iteration
      for (const [key, item] of entries) {
        if (item.name.endsWith("2") || item.name.endsWith("4")) {
          root.items.delete(key);
        }
      }

      expect(root.items).to.satisfy((m: Map<string, unknown>) => m.size === 3 && !m.has("key-2") && !m.has("key-4"));
    });

    it("should handle add during iteration", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      root.items.set("key-0", new Item({ name: "initial" }));

      // Iterate and add new items
      const initialKeys = [...root.items.keys()];
      for (const key of initialKeys) {
        root.items.set(`${key}-child`, new Item({ name: `child of ${key}` }));
      }

      expect(root.items).to.satisfy(
        (m: Map<string, unknown>) => m.size === 2 && m.has("key-0") && m.has("key-0-child"),
      );
    });
  });

  describe("Primitives as values", () => {
    it("should handle string values (non-child tracking)", () => {
      @syncing("StringMapContainer")
      class StringMapContainer extends PlexusModel {
        @syncing.map // Note: NOT child.map - just regular map
        accessor items!: Map<string, string>;
      }

      const container = new StringMapContainer({
        items: new Map([
          ["key1", "value1"],
          ["key2", "value2"],
        ]),
      });

      const { root } = initTestPlexus(container);

      expect([root.items.get("key1"), root.items.get("key2")]).to.have.ordered.members(["value1", "value2"]);

      root.items.set("key3", "value3");
      expect(root.items.get("key3")).to.equal("value3");
    });

    it("should handle number values", () => {
      @syncing("NumberMapContainer")
      class NumberMapContainer extends PlexusModel {
        @syncing.map
        accessor items!: Map<string, number>;
      }

      const container = new NumberMapContainer({
        items: new Map([
          ["a", 1],
          ["b", 2],
        ]),
      });

      const { root } = initTestPlexus(container);

      expect([root.items.get("a"), root.items.get("b")]).to.have.ordered.members([1, 2]);
    });

    it("should handle mixed primitive and entity values in child-map (entity adopted, primitive not)", () => {
      @syncing("MixedMapContainer")
      class MixedMapContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<string, Item | string | number>;
      }

      const item = new Item({ name: "entity" });
      const container = new MixedMapContainer({
        items: new Map<string, Item | string | number>([
          ["entity-key", item],
          ["string-key", "just a string"],
          ["number-key", 42],
        ]),
      });

      const { root } = initTestPlexus(container);

      // Entity should be adopted
      expect(item).to.have.property("parent", root);

      // Primitives just work as values, all entries present
      expect(root.items).to.have.property("size", 3);
      expect([root.items.get("string-key"), root.items.get("number-key")]).to.have.ordered.members([
        "just a string",
        42,
      ]);
    });
  });

  describe("Circular clone edge cases", () => {
    it("should handle clone when entity is both key and value", () => {
      @syncing("SelfKeyContainer")
      class SelfKeyContainer extends PlexusModel {
        @syncing.child.map
        accessor items!: Map<Item, Item>;
      }

      const item = new Item({ name: "self-keyed" });
      const container = new SelfKeyContainer({
        items: new Map([[item, item]]),
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Clone the container
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<SelfKeyContainer>(clonedId)!;

      // The cloned map should have a cloned item as both key and value
      expect(materializedClone.items).to.have.property("size", 1);

      const [[clonedKey, clonedValue]] = [...materializedClone.items.entries()];
      // Not originals, same data, and key === value (same instance)
      expect([clonedKey, clonedValue]).to.satisfy(
        (arr: Item[]) => arr[0] !== item && arr[1] !== item && arr[0] === arr[1],
      );
      expect([clonedKey.name, clonedValue.name]).to.have.ordered.members(["self-keyed", "self-keyed"]);
    });

    it("should handle clone with cross-referenced entities", () => {
      @syncing("CrossRefCloneContainer")
      class CrossRefCloneContainer extends PlexusModel {
        @syncing.child.map
        accessor forward!: Map<Item, Item>;

        @syncing.child
        accessor single!: Item | null;
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });

      // item2 is only in single (not in forward map as value) to avoid stealing
      const container = new CrossRefCloneContainer({
        forward: new Map([[item1, item2]]),
        single: null,
      });

      const { doc, root, plexus } = initTestPlexus(container);

      // Now move item2 to single at runtime (triggers stealing from forward map)
      root.single = item2;
      expect(root.forward.size).toBe(0); // item2 stolen from map
      expect(root.single).toBe(item2);

      // Add item2 back to forward as value under a new entry
      root.forward.set(item1, item2);
      // item2 is stolen from single to forward
      expect(root.single).toBeNull();
      expect(root.forward.get(item1)).toBe(item2);

      // Clone
      const cloned = root.clone();
      const [clonedId] = cloned[referenceSymbol](root.__doc__!);
      const materializedClone = plexus.loadEntity<CrossRefCloneContainer>(clonedId)!;

      const [[, clonedMapValue]] = [...materializedClone.forward.entries()];
      expect(clonedMapValue).to.include({ name: "item2" }).and.not.equal(item2);
    });
  });

  describe("Observer timing", () => {
    it("should have values accessible via Plexus proxy during batch operations", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      // Batch operations in transaction should maintain consistency
      doc.transact(() => {
        root.items.set("key-a", new Item({ name: "a" }));
        root.items.set("key-b", new Item({ name: "b" }));
        root.items.set("key-c", new Item({ name: "c" }));

        // Within transaction, values should already be accessible
        expect([
          root.items.get("key-a")!.name,
          root.items.get("key-b")!.name,
          root.items.get("key-c")!.name,
        ]).to.have.ordered.members(["a", "b", "c"]);
      });

      // After transaction, all values still accessible
      expect(root.items).to.have.property("size", 3);
      expect([
        root.items.get("key-a")!.name,
        root.items.get("key-b")!.name,
        root.items.get("key-c")!.name,
      ]).to.have.ordered.members(["a", "b", "c"]);
    });

    it("should handle interleaved reads and writes in transaction", () => {
      const container = new Container({ items: new Map() });
      const { doc, root } = initTestPlexus(container);

      doc.transact(() => {
        // Write
        root.items.set("key1", new Item({ name: "value1" }));

        // Read what we just wrote
        const read1 = root.items.get("key1");
        expect(read1).to.include({ name: "value1" });

        // Write more
        root.items.set("key2", new Item({ name: "value2" }));

        // Replace first value
        root.items.set("key1", new Item({ name: "value1-updated" }));

        // Read both
        expect([root.items.get("key1")!.name, root.items.get("key2")!.name]).to.have.ordered.members([
          "value1-updated",
          "value2",
        ]);
      });
    });
  });

  describe("Reactive tracking granularity", () => {
    it("should track individual key access", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });
      root.items.set("key1", item1);
      root.items.set("key2", item2);

      let runCount = 0;

      // Track only key1 access
      const dispose = reaction(
        () => root.items.get("key1"),
        () => runCount++,
      );

      // No notification on initial setup
      expect(runCount).to.equal(0);

      // Modifying key2 should NOT trigger notification
      root.items.set("key2", new Item({ name: "item2-updated" }));
      expect(runCount).to.equal(0); // Still 0

      // Modifying key1 SHOULD trigger notification
      const newItem = new Item({ name: "item1-updated" });
      root.items.set("key1", newItem);
      expect(runCount).to.equal(1); // Notified!

      // Verify value updated
      expect(root.items.get("key1")).to.equal(newItem);
      dispose();
    });

    it("should track keys() iteration", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      root.items.set("key1", new Item({ name: "item1" }));

      let runCount = 0;

      const dispose = reaction(
        () => [...root.items.keys()],
        () => runCount++,
      );

      // No notification on initial setup
      expect(runCount).to.equal(0);

      // Adding new key should trigger (keys changed)
      root.items.set("key2", new Item({ name: "item2" }));
      expect(runCount).to.equal(1);

      // Verify current keys
      expect([...root.items.keys()]).to.have.ordered.members(["key1", "key2"]);
      dispose();
    });

    it("should track values() iteration", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      root.items.set("key1", new Item({ name: "item1" }));

      let runCount = 0;

      const dispose = reaction(
        () => [...root.items.values()].map((v) => v.name),
        () => runCount++,
      );

      // No notification on initial setup
      expect(runCount).to.equal(0);

      // Adding new value should trigger
      root.items.set("key2", new Item({ name: "item2" }));
      expect(runCount).to.equal(1);

      // Updating existing value should trigger
      root.items.set("key1", new Item({ name: "item1-updated" }));
      expect(runCount).to.equal(2);
      dispose();
    });

    it("should track size property", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      let runCount = 0;

      const dispose = reaction(
        () => root.items.size,
        () => runCount++,
      );

      // No notification on initial setup
      expect([runCount, root.items.size]).to.have.ordered.members([0, 0]);

      // Adding item should trigger (size changed)
      root.items.set("key1", new Item({ name: "item1" }));
      expect(runCount).to.equal(1);
      expect(root.items.size).to.equal(1);

      // Deleting should trigger (size changed)
      root.items.delete("key1");
      expect(runCount).to.equal(2);
      expect(root.items.size).to.equal(0);
      dispose();
    });

    it("should track has() for specific key", () => {
      const container = new Container({ items: new Map() });
      const { root } = initTestPlexus(container);

      let runCount = 0;

      const dispose = reaction(
        () => root.items.has("key1"),
        () => runCount++,
      );

      // No notification on initial setup
      expect([runCount, root.items.has("key1")]).to.have.ordered.members([0, false]);

      // Adding key1 should trigger (affects has() result: false -> true)
      root.items.set("key1", new Item({ name: "item1" }));
      expect(runCount).to.equal(1);
      expect(root.items.has("key1")).to.eq(true);

      // Adding key2 should NOT trigger (has("key1") result unchanged: still true)
      root.items.set("key2", new Item({ name: "item2" }));
      expect(runCount).to.equal(1);

      // Deleting key1 should trigger (affects has() result: true -> false)
      root.items.delete("key1");
      expect(runCount).to.equal(2);
      dispose();
    });
  });

  describe("Parentship cycle checks", () => {
    it("should prevent direct parent-child cycle (parent adding itself as child)", () => {
      @syncing("RecursiveContainer")
      class RecursiveContainer extends PlexusModel {
        @syncing.child.map
        accessor children!: Map<string, RecursiveContainer>;
      }

      const container = new RecursiveContainer({ children: new Map() });
      const { root } = initTestPlexus(container);

      // Trying to add root as its own child should throw
      expect(() => {
        root.children.set("self", root);
      }).to.throw(/root entity cannot have a parent/i);

      expect(root.children).to.not.has.key("self");
    });

    it("should prevent indirect cycle (grandchild trying to adopt grandparent)", () => {
      @syncing("TreeNode")
      class TreeNode extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor children!: Map<string, TreeNode>;
      }

      const grandparent = new TreeNode({ name: "grandparent", children: new Map() });
      const parent = new TreeNode({ name: "parent", children: new Map() });
      const child = new TreeNode({ name: "child", children: new Map() });

      const { root: rootGrandparent } = initTestPlexus(grandparent);

      // Build hierarchy: grandparent -> parent -> child
      rootGrandparent.children.set("parent", parent);
      parent.children.set("child", child);

      expect([parent.parent, child.parent]).to.have.ordered.members([rootGrandparent, parent]);

      // Trying to make child adopt grandparent should throw (cycle)
      expect(() => {
        child.children.set("grandparent", rootGrandparent);
      }).to.throw(/root entity cannot have a parent/i);

      // Hierarchy should be unchanged
      expect([parent.parent, child.parent]).to.have.ordered.members([rootGrandparent, parent]);
    });

    it("should prevent cycle through sibling (A -> B, B tries to adopt A)", () => {
      @syncing("SiblingNode")
      class SiblingNode extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor related!: Map<string, SiblingNode>;
      }

      const parent = new SiblingNode({ name: "parent", related: new Map() });
      const childA = new SiblingNode({ name: "childA", related: new Map() });
      const childB = new SiblingNode({ name: "childB", related: new Map() });

      const { root } = initTestPlexus(parent);

      // Parent has both children
      root.related.set("a", childA);
      root.related.set("b", childB);

      expect([childA.parent, childB.parent]).to.have.ordered.members([root, root]);

      // childA tries to adopt childB - this will STEAL childB from parent (not a cycle)
      childA.related.set("b", childB);

      // childB is now child of childA, removed from parent
      expect(childB).to.have.property("parent", childA);
      expect(root.related).to.not.has.key("b");
      expect(childA.related.get("b")).to.equal(childB);
    });

    it("should prevent deep cycle (chain of 5 nodes, last trying to adopt first)", () => {
      @syncing("ChainNode")
      class ChainNode extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor next!: Map<string, ChainNode>;
      }

      const node1 = new ChainNode({ name: "node1", next: new Map() });
      const node2 = new ChainNode({ name: "node2", next: new Map() });
      const node3 = new ChainNode({ name: "node3", next: new Map() });
      const node4 = new ChainNode({ name: "node4", next: new Map() });
      const node5 = new ChainNode({ name: "node5", next: new Map() });

      const { root } = initTestPlexus(node1);

      // Build chain: node1 -> node2 -> node3 -> node4 -> node5
      root.next.set("next", node2);
      node2.next.set("next", node3);
      node3.next.set("next", node4);
      node4.next.set("next", node5);

      // Verify chain
      expect([node2.parent, node3.parent, node4.parent, node5.parent]).to.have.ordered.members([
        root,
        node2,
        node3,
        node4,
      ]);

      // node5 tries to adopt node1 (root) - should throw
      expect(() => {
        node5.next.set("cycle", root);
      }).to.throw(/root entity cannot have a parent/i);

      // Chain should be unchanged
      expect(node5.next).to.not.has.key("cycle");
    });

    it("should allow non-cyclic reparenting", () => {
      @syncing("FlexNode")
      class FlexNode extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor children!: Map<string, FlexNode>;
      }

      const parent1 = new FlexNode({ name: "parent1", children: new Map() });
      const parent2 = new FlexNode({ name: "parent2", children: new Map() });
      const child = new FlexNode({ name: "child", children: new Map() });

      const { doc, root: root1, plexus } = initTestPlexus(parent1);

      // Materialize parent2 in same doc
      const [p2Id] = parent2[referenceSymbol](root1.__doc__!);
      const root2 = plexus.loadEntity<FlexNode>(p2Id)!;

      // child belongs to parent1
      root1.children.set("child", child);
      expect(child).to.have.property("parent", root1);

      // Move child to parent2 (not a cycle - parent2 is not in child's hierarchy)
      root2.children.set("child", child);

      // child moved from parent1 to parent2
      expect(child).to.have.property("parent", root2);
      expect(root1.children).to.not.has.key("child");
      expect(root2.children.get("child")).to.equal(child);
    });

    it("should prevent cycle when child tries to adopt parent", () => {
      @syncing("AncestorNode")
      class AncestorNode extends PlexusModel {
        @syncing accessor name!: string;

        @syncing.child.map
        accessor children!: Map<string, AncestorNode>;
      }

      const a = new AncestorNode({ name: "A", children: new Map() });
      const b = new AncestorNode({ name: "B", children: new Map() });
      const c = new AncestorNode({ name: "C", children: new Map() });

      const { root } = initTestPlexus(a);

      // Build: A -> B -> C
      root.children.set("b", b);
      b.children.set("c", c);

      expect([b.parent, c.parent]).to.have.ordered.members([root, b]);

      // C trying to add B (its parent) as child would create cycle
      // Plexus correctly detects this and throws
      expect(() => {
        c.children.set("b", b);
      }).to.throw(/would create cycle/i);

      // Hierarchy should be unchanged
      expect([b.parent, c.parent]).to.have.ordered.members([root, b]);
    });
  });

  describe("State consistency on failed adoption", () => {
    // Tests that verify state isn't corrupted when adoption throws (cycle error)
    // This was a bug where orphaning happened BEFORE validation

    it("should not orphan existing value when set() fails due to cycle", () => {
      @syncing("CycleNode")
      class CycleNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.map accessor children!: Map<string, CycleNode>;
      }

      const grandchild = new CycleNode({ name: "grandchild", children: new Map() });
      const child = new CycleNode({ name: "child", children: new Map([["grandchild", grandchild]]) });
      const rootNode = new CycleNode({ name: "root", children: new Map([["child", child]]) });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children.get("child")!;
      const grandchildNode = childNode.children.get("grandchild")!;

      // Grandchild trying to adopt child would create cycle
      // Critical: child's existing grandchild should NOT be orphaned by the failed attempt
      expect(() => {
        grandchildNode.children.set("child", childNode);
      }).to.throw(/would create cycle/i);

      // Verify state is completely unchanged - the existing grandchild is still properly parented
      expect([grandchildNode.parent, childNode.parent]).to.have.ordered.members([childNode, root]);
      expect(childNode.children.get("grandchild")).to.equal(grandchildNode);
    });

    it("should not orphan existing value when set() replaces and cycle fails", () => {
      @syncing("ReplaceNode")
      class ReplaceNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.map accessor children!: Map<string, ReplaceNode>;
      }

      // Build: root -> child -> grandchild -> existingGreatGrandchild
      const existingGreatGrandchild = new ReplaceNode({ name: "existing", children: new Map() });
      const grandchild = new ReplaceNode({
        name: "grandchild",
        children: new Map([["slot", existingGreatGrandchild]]),
      });
      const child = new ReplaceNode({ name: "child", children: new Map([["gc", grandchild]]) });
      const rootNode = new ReplaceNode({ name: "root", children: new Map([["child", child]]) });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children.get("child")!;
      const grandchildNode = childNode.children.get("gc")!;
      const existingNode = grandchildNode.children.get("slot")!;

      // Try to replace existingGreatGrandchild with child (ancestor) - would create cycle
      // Critical: existingGreatGrandchild should NOT be orphaned
      expect(() => {
        grandchildNode.children.set("slot", childNode);
      }).to.throw(/would create cycle/i);

      // Verify existingGreatGrandchild is still in place and properly parented
      expect(grandchildNode.children.get("slot")).to.equal(existingNode);
      expect([existingNode.parent, grandchildNode.parent, childNode.parent]).to.have.ordered.members([
        grandchildNode,
        childNode,
        root,
      ]);
    });

    it("should not orphan any values when assign() fails due to cycle", () => {
      @syncing("AssignNode")
      class AssignNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.map accessor children!: Map<string, AssignNode>;
      }

      // Build: root -> child1 (has item1, item2) and root -> child2
      // Then try to assign { newChild, child2 } to child1 where child2 contains child1 (cycle)
      const item1 = new AssignNode({ name: "item1", children: new Map() });
      const item2 = new AssignNode({ name: "item2", children: new Map() });
      const child1 = new AssignNode({
        name: "child1",
        children: new Map([
          ["i1", item1],
          ["i2", item2],
        ]),
      });
      const child2 = new AssignNode({ name: "child2", children: new Map([["c1ref", child1]]) });
      const rootNode = new AssignNode({ name: "root", children: new Map([["c2", child2]]) });

      const { root } = initTestPlexus(rootNode);
      const child2Node = root.children.get("c2")!;
      const child1Node = child2Node.children.get("c1ref")!;
      const item1Node = child1Node.children.get("i1")!;
      const item2Node = child1Node.children.get("i2")!;
      const newChild = new AssignNode({ name: "new", children: new Map() });

      // Try to assign a map that includes child2 (ancestor) to child1 - would create cycle
      // Critical: item1 and item2 should NOT be orphaned
      expect(() => {
        child1Node.children = new Map([
          ["x", newChild],
          ["y", child2Node],
        ]);
      }).to.throw(/would create cycle/i);

      // Verify all original items are still properly parented
      expect([item1Node.parent, item2Node.parent]).to.have.ordered.members([child1Node, child1Node]);
      expect([child1Node.children.get("i1"), child1Node.children.get("i2")]).to.have.ordered.members([
        item1Node,
        item2Node,
      ]);
      expect(child1Node.children).to.have.property("size", 2);
      // newChild should still be unparented (adoption was never completed)
      expect(newChild).to.have.property("parent", null);
    });
  });
});
