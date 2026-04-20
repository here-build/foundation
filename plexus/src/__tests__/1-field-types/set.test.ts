/**
 * Comprehensive tests for Set proxy implementation in plexus
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { getModelsMap } from "../getModelsMap.js";

// Test model with a set field
@syncing("TestComponent")
class TestComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;
}

@syncing("TestModelWithSet")
class TestModelWithSet extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.set
  accessor components!: Set<TestComponent>;
}

describe("Set Proxy Implementation", () => {
  let doc: Y.Doc;

  beforeEach(async () => {
    // Just create a basic doc for the non-materialized tests
    doc = new Y.Doc();
  });

  describe("Ephemeral Sets", () => {
    it("should create empty sets", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set(),
      });

      expect(model.tags).to.be.instanceOf(Set).and.have.property("size", 0);
      expect(model.components).to.be.instanceOf(Set).and.have.property("size", 0);
    });

    it("should support basic Set operations", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      // Basic set operations
      expect([model.tags.has("tag1"), model.tags.has("tag3"), model.tags.size]).to.have.ordered.members([
        true,
        false,
        2,
      ]);

      // Add operation
      model.tags.add("tag3");
      expect([model.tags.has("tag3"), model.tags.size]).to.have.ordered.members([true, 3]);

      // Delete operation
      expect([model.tags.delete("tag1"), model.tags.has("tag1"), model.tags.size]).to.have.ordered.members([
        true,
        false,
        2,
      ]);

      // Delete non-existent
      expect(model.tags.delete("nonexistent")).to.eq(false);
    });

    it("should support Set iteration methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set(),
      });

      // Test values()
      const values = [...model.tags.values()];
      expect(values).to.include.members(["tag1", "tag2", "tag3"]);

      // Test forEach
      const collected: string[] = [];
      for (const value of model.tags) collected.push(value);
      expect(collected).to.include.members(["tag1", "tag2", "tag3"]);

      // Test entries()
      const entries = [...model.tags.entries()];
      expect(entries).to.deep.include.members([
        ["tag1", "tag1"],
        ["tag2", "tag2"],
        ["tag3", "tag3"],
      ]);
    });

    const hasSetComparators =
      typeof (new Set() as any).isDisjointFrom === "function" &&
      typeof (new Set() as any).isSubsetOf === "function" &&
      typeof (new Set() as any).isSupersetOf === "function";

    it.skipIf(!hasSetComparators)("should support Set comparison methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      const otherSet = new Set(["tag2", "tag3"]);
      const subSet = new Set(["tag1"]);
      const superSet = new Set(["tag1", "tag2", "tag3"]);

      // Test set relationship methods
      expect([
        model.tags.isDisjointFrom(new Set(["tag3", "tag4"])),
        model.tags.isDisjointFrom(otherSet),
        model.tags.isSubsetOf(superSet),
        model.tags.isSubsetOf(subSet),
        model.tags.isSupersetOf(subSet),
        model.tags.isSupersetOf(superSet),
      ]).to.have.ordered.members([true, false, true, false, true, false]);
    });

    it("should support clear operation", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set(),
      });

      expect(model.tags).to.have.property("size", 3);
      model.tags.clear();
      expect([model.tags.size, model.tags.has("tag1")]).to.have.ordered.members([0, false]);
    });

    it("should work with entity sets", () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1, comp2]),
      });

      expect([model.components.size, model.components.has(comp1), model.components.has(comp2)]).to.have.ordered.members(
        [2, true, true],
      );

      // Add another component
      const comp3 = new TestComponent({ name: "Component 3", version: 3 });
      model.components.add(comp3);
      expect([model.components.size, model.components.has(comp3)]).to.have.ordered.members([3, true]);

      // Remove a component
      expect([
        model.components.delete(comp1),
        model.components.has(comp1),
        model.components.size,
      ]).to.have.ordered.members([true, false, 2]);
    });
  });

  describe("Materialized Sets (YJS-backed)", () => {
    it("should materialize sets to YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = initTestPlexus<TestModelWithSet>(model);

      // Verify the loaded root has correct data
      expect([root.name, root.tags.size, root.tags.has("tag1"), root.tags.has("tag2")]).to.have.ordered.members([
        "Test Model",
        2,
        true,
        true,
      ]);

      // Check that YJS arrays were created
      const yprojectFields = getModelsMap(plexusDoc);
      const entityId = root.uuid;
      const tagsMap = yprojectFields.get(entityId)?.getAttribute("tags") as Y.Map<any>;

      expect(tagsMap).to.be.instanceOf(Y.Map);
      expect(tagsMap.size).to.equal(2);
      expect([...tagsMap.values()]).to.include.members(["tag1", "tag2"]);
    });

    it("should sync set changes through YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set(),
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = initTestPlexus<TestModelWithSet>(model);

      // Verify initial state
      expect([root.tags.has("tag1"), root.tags.size]).to.have.ordered.members([true, 1]);

      // Changes should sync through YJS
      root.tags.add("tag2");
      expect([root.tags.has("tag2"), root.tags.size]).to.have.ordered.members([true, 2]);

      // Check YJS backing
      const yprojectFields = getModelsMap(plexusDoc);
      const entityId = root.uuid;
      const tagsMap = yprojectFields.get(entityId)?.getAttribute("tags") as Y.Map<any> | undefined;
      expect(tagsMap).to.be.instanceOf(Y.Map);
      expect(tagsMap?.size).to.equal(2);
      expect([...tagsMap!.values()]).to.include.members(["tag1", "tag2"]);
    });

    it("should handle entity sets in materialized state", async () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1]),
      });

      // Materialize via Plexus
      const { root } = initTestPlexus<TestModelWithSet>(model);

      // Verify initial component set
      expect([root.components.size, root.components.has(comp1)]).to.have.ordered.members([1, true]);

      // Add component to materialized set
      root.components.add(comp2);
      expect([root.components.size, root.components.has(comp1), root.components.has(comp2)]).to.have.ordered.members([
        2,
        true,
        true,
      ]);

      // Remove component
      expect([
        root.components.delete(comp1),
        root.components.size,
        root.components.has(comp1),
        root.components.has(comp2),
      ]).to.have.ordered.members([true, 1, false, true]);
    });
  });

  describe("Set Edge Cases", () => {
    it("should handle empty sets properly", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set(),
      });

      expect([
        model.tags.size,
        model.tags.clear(),
        model.tags.delete("nonexistent"),
        model.tags.has("anything"),
      ]).to.have.ordered.members([0, undefined, false, false]);

      // Iteration should work on empty sets
      const values = [...model.tags.values()];
      expect(values).to.deep.equal([]);

      const collected: string[] = [];
      for (const value of model.tags) collected.push(value);
      expect(collected).to.deep.equal([]);
    });

    it("should maintain Set uniqueness", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set(),
      });

      // Adding duplicate should not increase size
      model.tags.add("tag1");
      expect([model.tags.size, model.tags.has("tag1")]).to.have.ordered.members([1, true]);

      // Should work with entities too
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      model.components.add(comp1);
      model.components.add(comp1); // Adding same entity
      expect([model.components.size, model.components.has(comp1)]).to.have.ordered.members([1, true]);
    });
  });

  describe("Child Set (@syncing.child.set)", () => {
    @syncing("SetTreeNode")
    class SetTreeNode extends PlexusModel {
      @syncing accessor name!: string;
      @syncing.child.set accessor children!: Set<SetTreeNode>;
    }

    describe("Basic operations", () => {
      it("should add and track children", () => {
        const child1 = new SetTreeNode({ name: "child1", children: new Set() });
        const child2 = new SetTreeNode({ name: "child2", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child1, child2]) });

        const { root } = initTestPlexus(rootNode);
        expect([root.children.size, root.children.has(child1), root.children.has(child2)]).to.have.ordered.members([
          2,
          true,
          true,
        ]);

        // Children should know their parent
        expect([child1.parent, child2.parent]).to.have.ordered.members([root, root]);
      });

      it("should orphan children on delete", () => {
        const child = new SetTreeNode({ name: "child", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        expect(child.parent).to.equal(root);

        root.children.delete(child);
        expect([child.parent, root.children.size]).to.have.ordered.members([null, 0]);
      });

      it("should orphan all children on clear", () => {
        const child1 = new SetTreeNode({ name: "child1", children: new Set() });
        const child2 = new SetTreeNode({ name: "child2", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child1, child2]) });

        const { root } = initTestPlexus(rootNode);
        root.children.clear();

        expect([child1.parent, child2.parent, root.children.size]).to.have.ordered.members([null, null, 0]);
      });

      it("should detect cycles on add", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];

        // grandchild tries to add child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children.add(childNode);
        }).to.throw(/would create cycle/i);
      });
    });

    describe("State consistency on failed adoption", () => {
      it("add: should not corrupt state when adoption fails", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];

        // grandchild tries to add child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children.add(childNode);
        }).to.throw(/would create cycle/i);

        // State should be unchanged
        expect([grandchildNode.children.size, childNode.parent, grandchildNode.parent]).to.have.ordered.members([
          0,
          root,
          childNode,
        ]);
      });

      it("assign: should not orphan existing items when new items adoption fails", () => {
        const item1 = new SetTreeNode({ name: "item1", children: new Set() });
        const item2 = new SetTreeNode({ name: "item2", children: new Set() });
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set([item1, item2]) });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];
        const item1Node = [...grandchildNode.children].find((c) => c.name === "item1")!;
        const item2Node = [...grandchildNode.children].find((c) => c.name === "item2")!;
        const newItem = new SetTreeNode({ name: "new", children: new Set() });

        // grandchild tries to assign including child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children = new Set([newItem, childNode]);
        }).to.throw(/would create cycle/i);

        // Original items should still be properly parented
        expect([
          item1Node.parent,
          item2Node.parent,
          grandchildNode.children.size,
          grandchildNode.children.has(item1Node),
          grandchildNode.children.has(item2Node),
          newItem.parent,
          childNode.parent,
        ]).to.have.ordered.members([grandchildNode, grandchildNode, 2, true, true, null, root]);
      });

      it("assign: should preserve state when valid item in batch but invalid item throws", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];
        const validItem = new SetTreeNode({ name: "valid", children: new Set() });

        // Try to assign one valid item and one invalid (ancestor)
        expect(() => {
          grandchildNode.children = new Set([validItem, childNode]);
        }).to.throw(/would create cycle/i);

        // Neither item should have been added
        expect([grandchildNode.children.size, validItem.parent, childNode.parent]).to.have.ordered.members([
          0,
          null,
          root,
        ]);
      });
    });
  });
});
