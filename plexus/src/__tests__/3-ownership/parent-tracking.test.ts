import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusRootParentError } from "../../errors.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { YPlexusNode } from "../../proxy-runtime-types.js";
import { referenceSymbol } from "../../proxy-runtime-types.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";
import { getModelsMap } from "../getModelsMap.js";

function getParentRef(element: YPlexusNode | undefined): string[] | undefined {
  if (!element) return undefined;
  return element.getAttribute("\0") as string[] | undefined;
}

// Helper to sync two YJS docs bidirectionally
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// Test models with various child-* field configurations
@syncing("Child")
class Child extends PlexusModel {
  @syncing
  accessor name!: string;
}

@syncing("Parent")
class Parent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor child!: Child | null;

  @syncing.child.list
  accessor children!: Child[];

  @syncing.child.set
  accessor childSet!: Set<Child>;

  @syncing.child.record
  accessor childMap!: Record<string, Child>;
}

@syncing("MultiParent")
class MultiParent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.list
  accessor leftChildren!: Child[];

  @syncing.child.list
  accessor rightChildren!: Child[];
}

describe("Parent Tracking", () => {
  describe("Basic parent assignment", () => {
    it("tracks parent when child assigned to child-val field", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.child = child;

      const models = getModelsMap(doc);
      const childFields = models.get(child.uuid);
      console.log("Child UUID:", child.uuid);
      console.log("Parent UUID:", materializedParent.uuid);
      console.log("Child fields:", childFields);
      console.log("Child fields entries:", childFields ? childFields.getAttributes() : "none");
      const parentRef = getParentRef(childFields);
      console.log("Parent ref:", parentRef);

      expect(parentRef).to.deep.equal([materializedParent.uuid, `child`]);
    });

    it("tracks parent when child added to child-list", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.children.push(child);

      const models = getModelsMap(doc);

      expect(getParentRef(models.get(child.uuid))).to.deep.equal([materializedParent.uuid, "children"]);
    });

    it("tracks parent when child added to child-set", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.childSet.add(child);

      const models = getModelsMap(doc);
      const childFields = models.get(child.uuid);
      const parentRef = getParentRef(childFields);

      expect(parentRef).to.deep.equal([materializedParent.uuid, "childSet"]);
    });

    it("tracks parent when child added to child-record", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.childMap["key1"] = child;

      const models = getModelsMap(doc);
      const childFields = models.get(child.uuid);

      expect(getParentRef(childFields)).to.deep.equal([materializedParent.uuid, "childMap", "key1"]);
    });
  });

  describe("Reparenting", () => {
    it("removes from old parent when assigned to new parent", () => {
      const parent1 = new Parent({
        name: "parent1",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const parent2 = new Parent({
        name: "parent2",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      // For cross-parent operations, we need to materialize both parents in the same document
      const { doc, plexus, root: materializedParent1 } = initTestPlexus<Parent>(parent1);

      // Materialize the second parent in the same document
      const [parent2Id] = (parent2 as any)[referenceSymbol](doc);
      const materializedParent2 = plexus.loadEntity<Parent>(parent2Id)!;

      // First assignment
      materializedParent1.children.push(child);
      expect(materializedParent1.children).to.include(child);

      // Reparent - this should work now as they're in the same doc context
      materializedParent2.child = child;

      // Should be removed from parent1.children
      expect(materializedParent1.children).to.not.include(child);
      expect(materializedParent2.child).to.equal(child);

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));

      expect(parentRef).to.deep.equal([materializedParent2.uuid, `child`]);
    });

    it("handles moving between different collection types", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);

      // list → set
      materializedParent.children.push(child);
      expect(materializedParent.children).to.include(child);

      materializedParent.childSet.add(child);
      expect(materializedParent.children).to.not.include(child);
      expect(materializedParent.childSet.has(child)).to.eq(true);

      // set → record
      materializedParent.childMap["key"] = child;
      expect(materializedParent.childSet.has(child)).to.eq(false);
      expect(materializedParent.childMap["key"]).to.equal(child);

      // record → val
      materializedParent.child = child;
      expect(materializedParent.childMap["key"]).to.eq(undefined);
      expect(materializedParent.childMap).to.not.have.property("key");
      expect(materializedParent.child).to.equal(child);
    });

    it("handles moving within same list", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });
      const other1 = new Child({ name: "other1" });
      const other2 = new Child({ name: "other2" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(other1, child, other2);
      expect(materializedParent.children.indexOf(child)).to.equal(1);

      // Move to end by pushing again
      materializedParent.children.push(child);
      expect(materializedParent.children.indexOf(child)).to.equal(2); // Should be at end now
      expect(materializedParent.children.filter((c) => c === child)).to.have.lengthOf(1); // Only one instance
    });

    it("handles moving between record keys", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.childMap["key1"] = child;
      expect(materializedParent.childMap["key1"]).to.equal(child);

      materializedParent.childMap["key2"] = child;
      expect(materializedParent.childMap["key1"]).to.eq(undefined);
      expect(materializedParent.childMap).to.not.have.property("key1");
      expect(materializedParent.childMap["key2"]).to.equal(child);
    });
  });

  describe("Null and clear operations", () => {
    it("clears parent ref when child-val set to null", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.child = child;

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child.uuid))).to.not.eq(undefined);

      materializedParent.child = null;
      expect(getParentRef(models.get(child.uuid))).to.eq(undefined);
    });

    it("clears parent refs when list cleared", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child1.uuid))).to.not.eq(undefined);
      expect(getParentRef(models.get(child2.uuid))).to.not.eq(undefined);

      materializedParent.children = [];

      expect(getParentRef(models.get(child1.uuid))).to.eq(undefined);
      expect(getParentRef(models.get(child2.uuid))).to.eq(undefined);
    });

    it("clears parent refs when record reassigned", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.childMap["a"] = child1;
      materializedParent.childMap["b"] = child2;

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child1.uuid))).to.not.eq(undefined);
      expect(getParentRef(models.get(child2.uuid))).to.not.eq(undefined);

      materializedParent.childMap = {};

      expect(getParentRef(models.get(child1.uuid))).to.eq(undefined);
      expect(getParentRef(models.get(child2.uuid))).to.eq(undefined);
    });
  });

  describe("Cycles (Prevention)", () => {
    it("prevents direct cycle (A.child = B, B.child = A)", () => {
      const root = new Parent({
        name: "root",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Parent({
        name: "a",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const b = new Parent({
        name: "b",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });

      // Create plexus with root
      const { plexus } = initTestPlexus<Parent>(root);

      // Materialize A and B in the same document
      const [aId] = a[referenceSymbol](plexus.doc);
      const [bId] = b[referenceSymbol](plexus.doc);
      const materializedA = plexus.loadEntity<Parent>(aId)!;
      const materializedB = plexus.loadEntity<Parent>(bId)!;

      materializedA.child = materializedB;

      // Should throw when attempting to create cycle
      expect(() => {
        materializedB.child = materializedA;
      }).to.throw(/cycle/i);

      // Verify A is still parent of B, not the other way around
      expect(materializedA.child).to.equal(materializedB);
      expect(materializedB.child).to.eq(null);
    });

    it("prevents self-reference", () => {
      const self = new Parent({
        name: "self",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });

      const { root: materializedSelf } = initTestPlexus<Parent>(self);

      // Should throw when attempting self-adoption
      expect(() => {
        materializedSelf.child = materializedSelf;
      }).to.throw(PlexusRootParentError);

      // Verify no self-reference was created
      expect(materializedSelf.child).to.eq(null);
    });

    it("prevents cycle through collections", () => {
      const root = new Parent({
        name: "root",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Parent({
        name: "a",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const b = new Parent({
        name: "b",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });

      // Create plexus with root
      const { plexus } = initTestPlexus<Parent>(root);

      // Materialize A and B in the same document
      const [aId] = (a as any)[referenceSymbol](plexus.doc);
      const [bId] = (b as any)[referenceSymbol](plexus.doc);
      const materializedA = plexus.loadEntity<Parent>(aId)!;
      const materializedB = plexus.loadEntity<Parent>(bId)!;

      materializedA.children.push(materializedB);

      // Should throw when attempting to create cycle through collections
      expect(() => {
        materializedB.childSet.add(materializedA);
      }).to.throw(/cycle/i);

      // Verify A is still parent of B via children, no cycle
      expect(materializedA.children).to.include(materializedB);
      expect(materializedB.childSet.has(materializedA)).to.eq(false);
    });
  });

  describe("Field names with dots", () => {
    it("handles field names containing dots correctly", () => {
      @syncing("WeirdParent")
      class WeirdParent extends PlexusModel {
        @syncing.child
        accessor "field.with.dots"!: Child | null;
      }

      const parent = new WeirdParent({ "field.with.dots": null });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<WeirdParent>(parent);
      materializedParent["field.with.dots"] = child;

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));

      // Parent ref should preserve dots in field name
      expect(parentRef).to.deep.equal([materializedParent.uuid, `field.with.dots`]);
    });
  });

  describe("Ephemeral to materialized transitions", () => {
    it("preserves parent tracking through materialization", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      // Set up parent-child relationship while ephemeral
      parent.child = child;

      // Materialize parent (child materializes via contagion)
      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));

      expect(parentRef).to.deep.equal([materializedParent.uuid, `child`]);
    });

    it("handles ephemeral child added to materialized parent", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent); // Materialize parent first

      const child = new Child({ name: "child" }); // Ephemeral child
      materializedParent.children.push(child); // Should trigger contagion

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));

      expect(parentRef).to.deep.equal([materializedParent.uuid, `children`]);
    });
  });

  describe("Clone operations", () => {
    it("cloned parent gets new children with correct parent refs", () => {
      const original = new Parent({
        name: "original",
        child: new Child({ name: "originalChild" }),
        children: [new Child({ name: "child1" }), new Child({ name: "child2" })],
        childSet: new Set([new Child({ name: "setChild" })]),
        childMap: { key: new Child({ name: "mapChild" }) },
      });

      const { doc, root: materializedOriginal, plexus } = initTestPlexus<Parent>(original);

      const cloned = materializedOriginal.clone();
      // Materialize the cloned entity in the same document
      const [clonedId] = cloned[referenceSymbol](doc);
      const materializedCloned = plexus.loadEntity<Parent>(clonedId)!;

      // Cloned should have different children instances
      expect(materializedCloned.child).to.not.equal(materializedOriginal.child);
      expect(materializedCloned.children[0]).to.not.equal(materializedOriginal.children[0]);
      materializedCloned.name = "cloned";
      materializedCloned.child!.name = "cloned child";
      materializedCloned.children[0].name = "cloned child1";
      materializedCloned.children[1].name = "cloned child2";

      // Check parent refs point to cloned parent
      const models = getModelsMap(doc);

      const clonedChildRef = getParentRef(models.get(materializedCloned.child!.uuid));
      expect(clonedChildRef).to.deep.equal([materializedCloned.uuid, `child`]);

      const clonedListChildRef = getParentRef(models.get(materializedCloned.children[0].uuid));
      expect(clonedListChildRef).to.deep.equal([materializedCloned.uuid, `children`]);

      // Original children should still point to original parent
      const originalChildRef = getParentRef(models.get(materializedOriginal.child!.uuid));
      expect(originalChildRef).to.deep.equal([materializedOriginal.uuid, `child`]);
    });
  });

  describe("Collection operations", () => {
    it("updates parent refs on splice", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });
      const child3 = new Child({ name: "child3" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      // Splice in child3, removing child1
      materializedParent.children.splice(0, 1, child3);

      const models = getModelsMap(doc);

      // child1 should have no parent
      expect(getParentRef(models.get(child1.uuid))).to.eq(undefined);

      // child3 should have parent ref
      expect(getParentRef(models.get(child3.uuid))).to.deep.equal([materializedParent.uuid, `children`]);

      // child2 should still have parent ref
      expect(getParentRef(models.get(child2.uuid))).to.deep.equal([materializedParent.uuid, `children`]);
    });

    it("clears parent ref on pop/shift", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      const popped = materializedParent.children.pop();
      expect(popped).to.equal(child2);

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child2.uuid))).to.eq(undefined);
      expect(getParentRef(models.get(child1.uuid))).to.deep.equal([materializedParent.uuid, `children`]);

      const shifted = materializedParent.children.shift();
      expect(shifted).to.equal(child1);
      expect(getParentRef(models.get(child1.uuid))).to.eq(undefined);
    });

    it("updates parent refs on set delete", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.childSet.add(child);

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child.uuid))).to.deep.equal([materializedParent.uuid, `childSet`]);

      materializedParent.childSet.delete(child);
      expect(getParentRef(models.get(child.uuid))).to.eq(undefined);
    });

    it("updates parent refs on record delete", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);
      materializedParent.childMap["key"] = child;

      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child.uuid))).to.deep.equal([materializedParent.uuid, `childMap`, `key`]);

      delete materializedParent.childMap["key"];
      expect(getParentRef(models.get(child.uuid))).to.eq(undefined);
    });
  });

  describe("Multiple parent fields", () => {
    it("correctly tracks when moving between fields of same parent", () => {
      const parent = new MultiParent({
        name: "parent",
        leftChildren: [],
        rightChildren: [],
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<MultiParent>(parent);

      materializedParent.leftChildren.push(child);
      const models = getModelsMap(doc);
      expect(getParentRef(models.get(child.uuid))).to.deep.equal([materializedParent.uuid, `leftChildren`]);

      materializedParent.rightChildren.push(child);
      expect(materializedParent.leftChildren).to.not.include(child);
      expect(materializedParent.rightChildren).to.include(child);
      expect(getParentRef(models.get(child.uuid))).to.deep.equal([materializedParent.uuid, `rightChildren`]);
    });
  });

  describe("Dependency entities", () => {
    it("can't directly assign entities from different docs", () => {
      // Create dependency doc with a child
      const depChild = new Child({ name: "depChild" });
      const { doc: depDoc } = initTestPlexus<Child>(depChild);

      // Create root doc with parent
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const { plexus, root: materializedParent } = initTestPlexus<Parent>(parent);

      // This should fail - can't assign entity from different doc directly
      expect(() => {
        materializedParent.child = depChild; // Trying to set dependency entity as child
      }).to.throw(); // Or might silently fail depending on implementation
    });
  });

  describe("Transaction boundaries", () => {
    it("handles multiple parent changes in single transaction correctly", () => {
      const parent1 = new Parent({
        name: "parent1",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const parent2 = new Parent({
        name: "parent2",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const child = new Child({ name: "child" });

      // For cross-parent operations, both entities need to be in the same document
      const { doc, plexus, root: materializedParent1 } = initTestPlexus<Parent>(parent1);

      // Materialize parent2 in the same document
      const [parent2Id] = (parent2 as any)[referenceSymbol](doc);
      const materializedParent2 = plexus.loadEntity<Parent>(parent2Id) as Parent;

      doc.transact(() => {
        materializedParent1.children.push(child); // First parent assignment
        materializedParent2.childSet.add(child); // Second parent assignment (should remove from first)
        materializedParent1.child = child; // Third parent assignment (should remove from second)
      });

      // After transaction, child should only be in parent1.child
      expect(materializedParent1.child).to.equal(child);
      expect(materializedParent1.children).to.not.include(child);
      expect(materializedParent2.childSet.has(child)).to.eq(false);

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));
      expect(parentRef).to.deep.equal([materializedParent1.uuid, `child`]);
    });
  });

  describe("Edge case: primitives in child collections", () => {
    it("ignores primitive values when tracking parents", () => {
      @syncing("Mixed")
      class Mixed extends PlexusModel {
        @syncing.child.list
        accessor mixed!: (Child | string)[];
      }

      const parent = new Mixed({ mixed: [] });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = initTestPlexus<Mixed>(parent);
      materializedParent.mixed.push("string", child, "another");

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(child.uuid));

      // Only the Child entity should have parent ref
      expect(parentRef).to.deep.equal([materializedParent.uuid, `mixed`]);
      expect(materializedParent.mixed).to.deep.equal(["string", child, "another"]);
    });
  });

  describe("Performance edge case", () => {
    it("efficiently handles large collections", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });

      const { doc, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Add many children
      const children: Child[] = [];
      for (let i = 0; i < 1000; i++) {
        children.push(new Child({ name: `child${i}` }));
      }

      materializedParent.children.push(...children);

      // Move first child to end
      const first = children[0];
      materializedParent.children.push(first);

      // Should be removed from beginning and added to end
      expect(materializedParent.children.indexOf(first)).to.equal(999);
      expect(materializedParent.children.filter((c) => c === first)).to.have.lengthOf(1);

      const models = getModelsMap(doc);
      const parentRef = getParentRef(models.get(first.uuid));
      expect(parentRef).to.deep.equal([materializedParent.uuid, `children`]);
    });

    it("should handle splice to move element within same array", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const first = new Child({ name: "first" });
      const second = new Child({ name: "second" });
      const third = new Child({ name: "third" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [first, second, third]
      materializedParent.children.push(first, second, third);
      expect(materializedParent.children).to.have.ordered.members([first, second, third]);

      // Move first element to end by splicing it at index 3
      // Expected: [second, third, first] (length 3)
      materializedParent.children.splice(3, 0, first);

      expect(materializedParent.children).to.have.ordered.members([second, third, first]);

      // Should only appear once
      expect(materializedParent.children.filter((c) => c === first)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((c) => c.uuid)).to.deep.equal(syncedParent.children.map((c) => c.uuid));
    });

    it("should handle splice with item from left of splice zone", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d]
      materializedParent.children.push(a, b, c, d);

      // splice(1, 1, a, b) - delete b, insert a and b
      // a is from left of splice zone (index 0)
      // b is IN the delete zone (index 1)
      // Expected: [a, b, c, d] (b stays, a moves right)
      materializedParent.children.splice(1, 1, a, b);

      expect(materializedParent.children).to.have.ordered.members([a, b, c, d]);

      // Each item should appear exactly once (implied by ordered.members, but verify filter)
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === b)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((c) => c.uuid)).to.deep.equal(syncedParent.children.map((c) => c.uuid));
    });

    it("should handle splice with item from right of splice zone", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d]
      materializedParent.children.push(a, b, c, d);

      // splice(1, 1, d) - delete b, insert d
      // d is from right of splice zone (index 3)
      // Expected: [a, d, c] (b removed, d moved left)
      materializedParent.children.splice(1, 1, d);

      expect(materializedParent.children).to.have.ordered.members([a, d, c]);

      // d should appear exactly once (implied by ordered.members, but verify filter)
      expect(materializedParent.children.filter((ch) => ch === d)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((c) => c.uuid)).to.deep.equal(syncedParent.children.map((c) => c.uuid));
    });

    it("should handle splice(1, 0, a) where 'a' exists at index 0 (move operation, not error)", () => {
      // This test verifies the documentation case that incorrectly states it throws.
      // arr = [a, b]; splice(1, 0, a) should work as a valid move operation.
      //
      // Process:
      // 1. Initial: [a, b]
      // 2. Detect 'a' is being reused from index 0
      // 3. Remove 'a' from index 0: [b]
      // 4. Adjust insertion index: 1 - 1 = 0
      // 5. Insert 'a' at index 0: [a, b]
      //
      // Result: Array returns to original state (no-op), but doesn't throw.
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b]
      materializedParent.children.push(a, b);

      // splice(1, 0, a) - should not throw
      materializedParent.children.splice(1, 0, a);

      // Verify it works without throwing and results in correct state
      expect(materializedParent.children).to.have.ordered.members([a, b]);

      // Each item should appear exactly once (no duplicates) - implied by ordered.members
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === b)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((c) => c.uuid)).to.deep.equal(syncedParent.children.map((c) => c.uuid));
    });

    it("should handle splice with mixed items: left, right, inside, and new", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });
      const e = new Child({ name: "e" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d]
      materializedParent.children.push(a, b, c, d);

      // splice(1, 2, a, b, e) - delete b and c, insert a, b, e
      // a is from left (index 0)
      // b is in delete zone (index 1)
      // c is in delete zone (index 2) - will be removed
      // e is new
      // Expected: [a, b, e, d]
      materializedParent.children.splice(1, 2, a, b, e);

      expect(materializedParent.children).to.have.ordered.members([a, b, e, d]);

      // Each item should appear exactly once (implied by ordered.members)
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === b)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === e)).to.have.lengthOf(1);

      // c should be orphaned (removed)
      expect(materializedParent.children.includes(c)).to.eq(false);
      expect(c.parent).to.eq(null);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle splice reversing a section", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d]
      materializedParent.children.push(a, b, c, d);

      // splice(1, 2, c, b) - delete b and c, re-insert in reverse order
      // Expected: [a, c, b, d]
      materializedParent.children.splice(1, 2, c, b);

      expect(materializedParent.children).to.have.ordered.members([a, c, b, d]);

      // Each item should appear exactly once (implied by ordered.members)
      expect(materializedParent.children.filter((ch) => ch === b)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === c)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle splice with overlapping from both sides", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });
      const e = new Child({ name: "e" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d, e]
      materializedParent.children.push(a, b, c, d, e);

      // splice(2, 1, a, c, e) - delete c, insert a, c, e
      // a from left (index 0)
      // c in delete zone (index 2)
      // e from right (index 4)
      // Expected: [b, a, c, e, d]
      materializedParent.children.splice(2, 1, a, c, e);

      expect(materializedParent.children).to.have.ordered.members([b, a, c, e, d]);

      // Each item should appear exactly once (implied by ordered.members)
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === c)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === e)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle complete array reversal", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      // Initial: [a, b, c, d]
      materializedParent.children.push(a, b, c, d);

      // splice(0, 4, d, c, b, a) - remove all, re-insert in reverse
      // All items are in the delete zone, so no removals needed first
      // Expected: [d, c, b, a]
      materializedParent.children.splice(0, 4, d, c, b, a);

      expect(materializedParent.children).to.have.ordered.members([d, c, b, a]);

      // All items should still have parent
      expect([a, b, c, d]).to.satisfy((items: Child[]) => items.every((item) => item.parent === materializedParent));

      // Each item should appear exactly once (implied by ordered.members)
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === b)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === c)).to.have.lengthOf(1);
      expect(materializedParent.children.filter((ch) => ch === d)).to.have.lengthOf(1);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle pop", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c);
      const popped = materializedParent.children.pop();

      expect(popped).to.equal(c);
      expect(materializedParent.children).to.have.ordered.members([a, b]);
      expect(c.parent).to.eq(null); // orphaned

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle shift", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c);
      const shifted = materializedParent.children.shift();

      expect(shifted).to.equal(a);
      expect(materializedParent.children).to.have.ordered.members([b, c]);
      expect(a.parent).to.eq(null); // orphaned

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle reverse", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c);
      materializedParent.children.reverse();

      expect(materializedParent.children).to.have.ordered.members([c, b, a]);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle sort", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "charlie" });
      const b = new Child({ name: "alice" });
      const c = new Child({ name: "bob" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c);
      materializedParent.children.sort((x, y) => x.name.localeCompare(y.name));

      expect(materializedParent.children).to.have.lengthOf(3);
      expect(materializedParent.children[0].name).to.equal("alice");
      expect(materializedParent.children[1].name).to.equal("bob");
      expect(materializedParent.children[2].name).to.equal("charlie");

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should throw error when copyWithin would create duplicate child references", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c, d);

      // Attempt to copy elements from index 2-4 to index 0
      // This would create [c, d, c, d] - duplicates!
      expect(() => {
        materializedParent.children.copyWithin(0, 2, 4);
      }).to.throw("copyWithin cannot insert the same child multiple times");

      // Array should remain unchanged
      expect(materializedParent.children).to.deep.equal([a, b, c, d]);
    });

    it("should handle copyWithin when no duplicates are created", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });
      const e = new Child({ name: "e" });
      const f = new Child({ name: "f" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c, d, e, f);
      // Copy elements from index 0-2 to index 3
      // [a, b, c, d, e, f] -> [a, b, c, a, b, c] would create duplicates
      // But copying to non-overlapping region that replaces existing items works:
      // [a, b, c, d, e, f] copy(3, 0, 3) -> [a, b, c, a, b, c] - DUPLICATES, won't work

      // Instead, let's do a swap-like operation that doesn't create duplicates
      // We need to test a case where copyWithin doesn't create duplicates
      // Example: [a, b, c, d, e, f] copy(0, 3, 6) -> [d, e, f, d, e, f] - still duplicates!

      // Actually, copyWithin by its nature often creates duplicates when source and target overlap
      // Let's test that it works when the array is all unique and stays unique
      // This is a bit contrived, but: copyWithin on empty ranges or self-copies
      materializedParent.children.copyWithin(0, 0, 3); // Copy to same position

      expect(materializedParent.children).to.have.lengthOf(6);
      expect(materializedParent.children).to.deep.equal([a, b, c, d, e, f]); // Unchanged

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should handle index setter with reuse detection (moving item within array)", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });
      const d = new Child({ name: "d" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c, d);

      // Move element from index 0 to index 2
      // Since 'a' exists at index 0, it will be removed first, then set at adjusted index
      // [a, b, c, d] → remove a from 0 → [b, c, d] → set index 2-1=1 to a → [b, a, d]
      materializedParent.children[2] = a;

      // Should be [b, a, d] - 'a' removed from index 0, 'c' replaced at adjusted index 1
      expect(materializedParent.children).to.deep.equal([b, a, d]);

      // 'a' should appear exactly once
      expect(materializedParent.children.filter((ch) => ch === a)).to.have.lengthOf(1);

      // 'c' should be orphanized (it was replaced)
      expect(c.parent).to.eq(null);

      // Other children should still have correct parent
      expect(a.parent).to.equal(materializedParent);
      expect(b.parent).to.equal(materializedParent);
      expect(d.parent).to.equal(materializedParent);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });

    it("should throw error when push tries to insert duplicate children", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(b);

      // Try to push [a, a] - same child twice
      expect(() => {
        materializedParent.children.push(a, a);
      }).to.throw("push cannot insert the same child multiple times");

      // Array should remain unchanged
      expect(materializedParent.children).to.deep.equal([b]);
    });

    it("should throw error when unshift tries to insert duplicate children", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(b);

      // Try to unshift [a, a] - same child twice
      expect(() => {
        materializedParent.children.unshift(a, a);
      }).to.throw("unshift cannot insert the same child multiple times");

      // Array should remain unchanged
      expect(materializedParent.children).to.deep.equal([b]);
    });

    it("should throw error when splice tries to insert duplicate children", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(b);

      // Try to splice in [a, a] - same child twice
      expect(() => {
        materializedParent.children.splice(0, 0, a, a);
      }).to.throw("splice cannot insert the same child multiple times");

      // Array should remain unchanged
      expect(materializedParent.children).to.deep.equal([b]);
    });

    it("should throw error when assign tries to set duplicate children", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(b);

      // Try to assign [a, a, b] - 'a' appears twice
      expect(() => {
        materializedParent.children = [a, a, b];
      }).to.throw("assign cannot insert the same child multiple times");

      // Array should remain unchanged
      expect(materializedParent.children).to.deep.equal([b]);
    });

    it("should return new length from unshift", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });

      const { root: materializedParent } = initTestPlexus<Parent>(parent);

      const len1 = materializedParent.children.unshift(a);
      expect(len1).to.equal(1);

      const len2 = materializedParent.children.unshift(b);
      expect(len2).to.equal(2);

      expect(materializedParent.children).to.deep.equal([b, a]);
    });

    it("should orphanize elements when length is decreased", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {},
      });
      const a = new Child({ name: "a" });
      const b = new Child({ name: "b" });
      const c = new Child({ name: "c" });

      const { doc: doc1, root: materializedParent } = initTestPlexus<Parent>(parent);

      materializedParent.children.push(a, b, c);

      // Truncate to length 1
      materializedParent.children.length = 1;

      expect(materializedParent.children).to.have.lengthOf(1);
      expect(materializedParent.children).to.deep.equal([a]);

      // b and c should be orphanized
      expect(a.parent).to.equal(materializedParent);
      expect(b.parent).to.eq(null);
      expect(c.parent).to.eq(null);

      // Verify YJS sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);
      const { plexus: plexus2 } = connectTestPlexus<Parent>(doc2);
      const syncedParent = plexus2.loadEntity<Parent>(materializedParent.uuid)!;

      expect(materializedParent.children.map((ch) => ch.uuid)).to.deep.equal(
        syncedParent.children.map((ch) => ch.uuid),
      );
    });
  });
});
