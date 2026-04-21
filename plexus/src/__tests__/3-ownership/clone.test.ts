/**
 * Comprehensive tests for clone semantics, assign behavior, and clear behavior
 *
 * This file combines tests for:
 * - Ownership-aware cloning with child-list, child-set, child-record schema types
 * - clone(), assign(), clear() methods
 */

import { reaction } from "mobx";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";

beforeAll(() => { enableMobXIntegration(); });

// =============================================================================
// Test Models
// =============================================================================

// Basic test component for simple scenarios
@syncing("TestComponent")
class TestComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;
}

// Extended test model with various collection types
@syncing("TestModel")
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;

  @syncing
  accessor component!: TestComponent | null;

  @syncing.list
  accessor items!: string[];

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.record
  accessor metadata!: Record<string, string>;

  @syncing.set
  accessor references!: Set<TestComponent>;
}

// Edge case models for nested ownership
@syncing("EdgeCaseParent")
class EdgeCaseParent extends PlexusModel {
  @syncing.child
  accessor value!: EdgeCaseChild;
  @syncing.child
  accessor field!: TestComponent;
}

@syncing("EdgeCaseChild")
class EdgeCaseChild extends PlexusModel {
  @syncing
  accessor field!: TestComponent;
}

// Ownership-aware models
@syncing("ChildComponent")
class ChildComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;
}

@syncing("ParentWithChildVal")
class ParentWithChildVal extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor child!: ChildComponent | null; // Ownership: clone child recursively

  @syncing
  accessor participatingReference!: ChildComponent | null; // No ownership but updated as new entity of that was cloned

  @syncing
  accessor reference!: ChildComponent | null; // No ownership: preserve reference
}

@syncing("ParentWithChildList")
class ParentWithChildList extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.list
  accessor children!: Array<ChildComponent>; // Ownership: clone children recursively

  @syncing.list
  accessor references!: Array<ChildComponent>; // No ownership: preserve references
}

@syncing("ParentWithChildSet")
class ParentWithChildSet extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.set
  accessor childSet!: Set<ChildComponent>; // Ownership: clone children recursively

  @syncing.set
  accessor refSet!: Set<ChildComponent>; // No ownership: preserve references
}

@syncing("ParentWithChildRecord")
class ParentWithChildRecord extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.record
  accessor childMap!: Record<string, ChildComponent>; // Ownership: clone children recursively

  @syncing.record
  accessor refMap!: Record<string, ChildComponent>; // No ownership: preserve references
}

// Circular reference models
@syncing("NodeA")
class NodeA extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor nodeB!: NodeB | null; // Owns NodeB - will clone recursively
}

@syncing("NodeB")
class NodeB extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor nodeA!: NodeA | null; // Owns NodeA - creates circular ownership
}

// =============================================================================
// Clone Semantics Tests
// =============================================================================

describe("Clone semantics", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("basic clone behavior", () => {
    it("should create a new entity with same primitive values", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const cloned = original.clone();

      // Different entities
      expect(cloned).to.not.equal(original);

      // Same primitive values
      expect({ ...cloned }).to.deep.include({
        name: "test",
        value: 42,
        component: null,
        items: [],
        metadata: {},
      });
      expect([...cloned.tags]).to.deep.equal([]);
      expect([...cloned.references]).to.deep.equal([]);
    });

    it("should shallow clone collections (new collection, same elements)", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp1,
        items: ["a", "b", "c"],
        tags: new Set(["tag1", "tag2"]),
        metadata: { key1: "value1", key2: "value2" },
        references: new Set([comp1, comp2]),
      });

      const cloned = original.clone();

      // Collections are different instances
      expect(cloned.items).to.not.equal(original.items);
      expect(cloned.tags).to.not.equal(original.tags);
      expect(cloned.metadata).to.not.equal(original.metadata);
      expect(cloned.references).to.not.equal(original.references);

      // But contain same elements
      expect(cloned).to.deep.include({
        items: ["a", "b", "c"],
        metadata: { key1: "value1", key2: "value2" },
      });
      expect([...cloned.tags]).to.include.members(["tag1", "tag2"]);
      expect([...cloned.references]).to.include.members([comp1, comp2]);
    });

    it("should preserve entity references (not clone referenced entities)", () => {
      const comp = new TestComponent({ name: "referenced", version: 1 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp]),
      });

      const cloned = original.clone();

      // Referenced entity should be the same instance
      expect(cloned.component).to.equal(comp);
      expect(cloned.component).to.equal(comp);
      expect([...cloned.references]).to.include(comp);

      // Verify it's actually the same reference
      cloned.component!.name = "modified";
      expect(comp.name).to.equal("modified");
    });

    it("should trigger access tracking when reading fields during clone", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["a", "b"],
        tags: new Set(["tag1"]),
        metadata: { key: "value" },
        references: new Set(),
      });

      const notifyChanges = vi.fn();
      let cloned!: TestModel;

      const dispose = reaction(
        () => original.clone(),
        (value) => { cloned = value; notifyChanges(); },
        { fireImmediately: true },
      );

      expect(cloned.name).to.equal("test");

      // Modifying fields that were accessed during clone should notify
      original.name = "changed";
      expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf.above(0);
      dispose();
    });

    it("should properly handle edge case with shared references across child fields", () => {
      const field = new TestComponent({});
      const parent = new EdgeCaseParent({
        value: new EdgeCaseChild({
          field,
        }),
        field,
      }).clone();
      expect(parent.field).to.equal(parent.value.field).and.not.equal(field);
    });
  });

  describe("child-val ownership", () => {
    it("should deep clone child-val but preserve val references", () => {
      const child = new ChildComponent({ name: "child", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 1 });

      const parent = new ParentWithChildVal({
        name: "parent",
        child, // Will be cloned
        participatingReference: child, // Will be updated as new entity of that was spawned
        reference: child2, // Will be preserved as reference
      });

      const cloned = parent.clone();

      // Parent should be different
      expect(cloned).to.not.equal(parent);
      expect(cloned.name).to.equal("parent");

      // child-val: child should be cloned (different object)
      expect(cloned.child).to.not.equal(child);
      expect(cloned.child!.name).to.equal("child"); // But same values
      expect(cloned.child!.value).to.equal(1);

      // val: participatingReference should be remapped to the cloned child
      expect(cloned.participatingReference).to.not.equal(child);
      expect(cloned.participatingReference).to.equal(cloned.child); // Same object reference
      // val: reference should be preserved (same object)
      expect(cloned.reference).to.equal(child2); // Same object reference
    });

    it("should handle null child-val gracefully", () => {
      const parent = new ParentWithChildVal({
        name: "parent",
        child: null,
        reference: null,
      });

      const cloned = parent.clone();

      expect(cloned.child).to.eq(null);
      expect(cloned.reference).to.eq(null);
    });
  });

  describe("child-list ownership", () => {
    it("should deep clone child-list elements and remap references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1, child2], // Will be cloned
        references: [child1, child2, child3], // child1 and child2 will be remapped to clones, child3 preserved
      });

      const cloned = parent.clone();

      // Parent should be different
      expect(cloned).to.not.equal(parent);
      expect(cloned.name).to.equal("parent");

      // child-list: children should be cloned (different objects but same values)
      expect(cloned.children)
        .to.have.lengthOf(2)
        .and.satisfy(
          (arr: typeof cloned.children) =>
            arr[0] !== child1 && arr[1] !== child2 && arr[0].name === "child1" && arr[1].name === "child2",
        );

      // list: references to cloned entities should be remapped, non-cloned preserved
      expect(cloned.references)
        .to.have.lengthOf(3)
        .and.have.ordered.members([cloned.children[0], cloned.children[1], child3]);
    });

    it("should handle modifications to cloned children independently", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1],
        references: [child1, child2], // child1 will be remapped, child2 preserved
      });

      const cloned = parent.clone();

      // Modify the cloned child
      cloned.children[0].name = "modified";

      // Original child should be unchanged
      expect(child1.name).to.equal("child1");
      expect(parent.children[0].name).to.equal("child1");

      // Cloned child should be changed
      expect(cloned.children[0].name).to.equal("modified");

      // Reference to cloned child should also see the modification (same object)
      expect(cloned.references[0].name).to.equal("modified");
      expect(cloned.references[0]).to.equal(cloned.children[0]); // Remapped to clone

      // Reference to non-cloned child should be unchanged
      expect(cloned.references[1]).to.equal(child2);
      expect(cloned.references[1].name).to.equal("child2");
    });
  });

  describe("child-set ownership", () => {
    it("should deep clone child-set elements and remap set references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildSet({
        name: "parent",
        childSet: new Set([child1, child2]), // Will be cloned
        refSet: new Set([child1, child2, child3]), // child1 and child2 remapped, child3 preserved
      });

      const cloned = parent.clone();

      // child-set: children should be cloned
      expect(cloned.childSet.size).to.equal(2);
      const clonedChildren = [...cloned.childSet];
      expect(clonedChildren[0]).to.not.equal(child1);
      expect(clonedChildren[1]).to.not.equal(child2);

      // set: references to cloned entities should be remapped
      expect(cloned.refSet).to.satisfy(
        (s: Set<unknown>) =>
          s.size === 3 &&
          s.has(clonedChildren[0]) &&
          s.has(clonedChildren[1]) &&
          s.has(child3) &&
          !s.has(child1) &&
          !s.has(child2),
      );
    });
  });

  describe("child-record ownership", () => {
    it("should deep clone child-record values and remap record references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildRecord({
        name: "parent",
        childMap: { first: child1, second: child2 }, // Will be cloned
        refMap: { first: child1, second: child2, third: child3 }, // first and second remapped, third preserved
      });

      const cloned = parent.clone();

      // child-record: values should be cloned
      expect(Object.keys(cloned.childMap)).to.deep.equal(["first", "second"]);
      expect(cloned.childMap.first).to.not.equal(child1);
      expect(cloned.childMap.second).to.not.equal(child2);
      expect(cloned.childMap.first.name).to.equal("child1"); // Same values
      expect(cloned.childMap.second.name).to.equal("child2");

      // record: references to cloned entities should be remapped
      expect(Object.keys(cloned.refMap)).to.deep.equal(["first", "second", "third"]);
      expect(cloned.refMap.first).to.equal(cloned.childMap.first); // Remapped to clone
      expect(cloned.refMap.second).to.equal(cloned.childMap.second); // Remapped to clone
      expect(cloned.refMap.third).to.equal(child3); // Not cloned, preserved
    });
  });
});

// =============================================================================
// Circular and Edge Case Tests
// =============================================================================

describe("Circular ownership edge cases", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should handle shared references without cycles", () => {
    // Test the transaction mapping with shared references (no true cycles due to runtime constraints)
    const nodeB = new NodeB({ name: "B", nodeA: null });
    const nodeA = new NodeA({ name: "A", nodeB });

    const clonedA = nodeA.clone();

    // Cloned A should be different from original
    expect(clonedA).to.not.equal(nodeA);
    expect(clonedA.name).to.equal("A");

    // Cloned A should have a cloned B
    expect(clonedA.nodeB).to.not.equal(null);
    expect(clonedA.nodeB).to.not.equal(nodeB);
    expect(clonedA.nodeB!.name).to.equal("B");

    // The cloned B should have null nodeA (as constructed)
    expect(clonedA.nodeB!.nodeA).to.eq(null);
  });

  it("should handle shared references in collections (single parent constraint)", () => {
    const sharedChild = new ChildComponent({ name: "shared", value: 42 });

    const parent1 = new ParentWithChildList({
      name: "parent1",
      children: [sharedChild], // sharedChild's parent is now parent1
      references: [],
    });

    // At this point, sharedChild belongs to parent1
    expect(parent1.children).to.have.ordered.members([sharedChild]);

    const parent2 = new ParentWithChildList({
      name: "parent2",
      children: [sharedChild, parent1], // sharedChild moves to parent2, removed from parent1
      references: [],
    });

    // Parent tracking should have moved sharedChild from parent1 to parent2
    expect(parent1.children).to.have.lengthOf(0); // Empty - sharedChild was removed
    expect(parent2.children).to.have.ordered.members([sharedChild, parent1]);

    const clonedParent2 = parent2.clone();

    // Should have 2 children: sharedChild and parent1
    expect(clonedParent2.children).to.have.lengthOf(2);

    // First child should be a clone of sharedChild
    expect(clonedParent2.children[0]).to.not.equal(sharedChild);
    expect(clonedParent2.children[0].name).to.equal("shared");

    // Second child should be a clone of parent1 (which now has no children)
    expect(clonedParent2.children[1]).to.not.equal(parent1);
    expect((clonedParent2.children[1] as unknown as ParentWithChildList).name).to.equal("parent1");
    expect((clonedParent2.children[1] as unknown as ParentWithChildList).children).to.have.lengthOf(0); // Empty because sharedChild was moved
  });

  it("should handle deeply nested shared references (single parent constraint)", () => {
    const leafChild = new ChildComponent({ name: "leaf", value: 1 });

    const level2a = new ParentWithChildList({
      name: "level2a",
      children: [leafChild], // leafChild's parent is now level2a
      references: [],
    });

    // leafChild belongs to level2a
    expect(level2a.children).to.have.ordered.members([leafChild]);

    const level2b = new ParentWithChildList({
      name: "level2b",
      children: [leafChild], // leafChild moves from level2a to level2b
      references: [],
    });

    // Parent tracking should have moved leafChild from level2a to level2b
    expect(level2a.children).to.have.lengthOf(0); // Empty - leafChild was moved
    expect(level2b.children).to.have.ordered.members([leafChild]);

    const root = new ParentWithChildList({
      name: "root",
      children: [level2a, level2b], // level2a has no children, level2b has leafChild
      references: [],
    });

    const clonedRoot = root.clone();

    // Extract cloned references
    const clonedLevel2a = clonedRoot.children[0] as any;
    const clonedLevel2b = clonedRoot.children[1] as any;

    // Both levels should be cloned
    expect(clonedLevel2a).to.not.equal(level2a);
    expect(clonedLevel2b).to.not.equal(level2b);
    expect(clonedLevel2a.name).to.equal("level2a");
    expect(clonedLevel2b.name).to.equal("level2b");

    // level2a should have no children (leafChild was moved)
    expect(clonedLevel2a.children).to.have.lengthOf(0);

    // level2b should have the cloned leafChild
    expect(clonedLevel2b.children).to.have.lengthOf(1);
    const clonedLeafFromB = clonedLevel2b.children[0];
    expect(clonedLeafFromB).to.not.equal(leafChild);
    expect(clonedLeafFromB.name).to.equal("leaf");
  });

  it("should prevent self-referential collections", () => {
    // Plexus now prevents self-referential ownership (would create cycle)
    // Attempting to add an entity to its own child collection throws an error

    // Test a parent that tries to contain itself in its children list
    const selfRef = new ParentWithChildList({
      name: "selfRef",
      children: [], // Start empty, will try to add self via push
      references: [],
    });

    // Attempting to add itself to its own children list should throw
    expect(() => {
      selfRef.children.push(selfRef as any);
    }).to.throw(/self|cycle/i);

    // Verify no self-reference was created
    expect(selfRef.children).to.have.lengthOf(0);
  });

  it("should handle complex diamond-shaped shared references (single parent constraint)", () => {
    //     root
    //    /    \
    //  left   right
    //   |      |
    //  empty  shared (moved here)
    //
    const shared = new ChildComponent({ name: "shared", value: 42 });

    const left = new ParentWithChildList({
      name: "left",
      children: [shared], // shared's parent is now left
      references: [],
    });

    // shared belongs to left
    expect(left.children).to.have.ordered.members([shared]);

    const right = new ParentWithChildList({
      name: "right",
      children: [shared], // shared moves from left to right
      references: [],
    });

    // Parent tracking should have moved shared from left to right
    expect(left.children).to.have.lengthOf(0); // Empty - shared was moved
    expect(right.children).to.have.ordered.members([shared]);

    const root = new ParentWithChildList({
      name: "root",
      children: [left, right], // left has no children, right has shared
      references: [],
    });

    const clonedRoot = root.clone();

    // Extract all cloned references
    const clonedLeft = clonedRoot.children[0] as any;
    const clonedRight = clonedRoot.children[1] as any;

    // Everything should be cloned
    expect(clonedRoot).to.not.equal(root);
    expect(clonedLeft).to.not.equal(left);
    expect(clonedRight).to.not.equal(right);

    // Left should have no children (shared was moved)
    expect(clonedLeft.children).to.have.lengthOf(0);

    // Right should have the cloned shared
    expect(clonedRight.children).to.have.lengthOf(1);
    const sharedFromRight = clonedRight.children[0];
    expect(sharedFromRight).to.not.equal(shared);
    expect(sharedFromRight.name).to.equal("shared");
    expect(sharedFromRight.value).to.equal(42);
  });

  it("should handle mixed ownership and reference semantics with remapping", () => {
    const sharedChild = new ChildComponent({ name: "shared", value: 100 });
    const otherChild = new ChildComponent({ name: "other", value: 200 });

    const mixedParent = new ParentWithChildList({
      name: "mixed",
      children: [sharedChild], // child-list: will clone
      references: [sharedChild, otherChild], // list: sharedChild remapped, otherChild preserved
    });

    const cloned = mixedParent.clone();

    // The child in children should be cloned
    expect(cloned.children[0]).to.not.equal(sharedChild);
    expect(cloned.children[0].name).to.equal("shared");
    expect(cloned.children[0].value).to.equal(100);

    // The child in references should be remapped to the clone
    expect(cloned.references[0]).to.equal(cloned.children[0]); // Remapped to clone

    // The other reference should be preserved
    expect(cloned.references[1]).to.equal(otherChild);
  });

  it("should handle empty collections properly", () => {
    const parent = new ParentWithChildList({
      name: "empty",
      children: [],
      references: [],
    });

    const cloned = parent.clone();

    expect(cloned).to.not.equal(parent);
    expect(cloned.name).to.equal("empty");
    expect(cloned.children).to.deep.equal([]);
    expect(cloned.references).to.deep.equal([]);

    // Collections should be different instances
    expect(cloned.children).to.not.equal(parent.children);
    expect(cloned.references).to.not.equal(parent.references);
  });

  it("should handle null and undefined child values", () => {
    const parentWithNulls = new ParentWithChildVal({
      name: "nulls",
      child: null,
      reference: null,
    });

    const cloned = parentWithNulls.clone();

    expect(cloned).to.not.equal(parentWithNulls);
    expect(cloned.name).to.equal("nulls");
    expect(cloned.child).to.eq(null);
    expect(cloned.reference).to.eq(null);
  });

  it("should handle transaction cleanup properly", () => {
    // Test that the global transaction mapping is cleaned up between operations
    const child1 = new ChildComponent({ name: "child1", value: 1 });
    const parent1 = new ParentWithChildList({
      name: "parent1",
      children: [child1],
      references: [],
    });

    // First clone
    const cloned1 = parent1.clone();
    expect(cloned1.children[0]).to.not.equal(child1);

    // Second clone should start fresh (not reuse previous mapping)
    const child2 = new ChildComponent({ name: "child2", value: 2 });
    const parent2 = new ParentWithChildList({
      name: "parent2",
      children: [child2],
      references: [],
    });

    const cloned2 = parent2.clone();
    expect(cloned2.children[0]).to.not.equal(child2);
    expect(cloned2.children[0]).to.not.equal(cloned1.children[0]); // Different clones
  });

  it("should handle very large shared reference networks (single parent constraint)", () => {
    // Create a large network where parent tracking moves the child
    const centralChild = new ChildComponent({ name: "central", value: 999 });

    // Create 50 parents that all try to own the same child
    const parents: any[] = [];
    for (let i = 0; i < 50; i++) {
      parents.push(
        new ParentWithChildList({
          name: `parent${i}`,
          children: [centralChild], // Each assignment moves centralChild to the new parent
          references: [],
        }),
      );
    }

    // Parent tracking should have moved centralChild to the last parent
    for (let i = 0; i < 49; i++) {
      expect(parents[i].children).to.have.lengthOf(0); // All previous parents lost the child
    }
    expect(parents[49].children).to.have.lengthOf(1); // Only the last parent has it
    expect(parents[49].children[0]).to.equal(centralChild);

    // Create a root that contains all parents
    const megaRoot = new ParentWithChildList({
      name: "megaRoot",
      children: parents,
      references: [],
    });

    // This should complete without hanging or crashing
    const clonedMegaRoot = megaRoot.clone();

    // Verify structure is preserved
    expect(clonedMegaRoot.children).to.have.lengthOf(50);

    // All parents should be cloned
    for (let i = 0; i < 50; i++) {
      const clonedParent = clonedMegaRoot.children[i] as any;
      expect(clonedParent).to.not.equal(parents[i]);
      expect(clonedParent.name).to.equal(`parent${i}`);

      if (i < 49) {
        // First 49 parents should have no children
        expect(clonedParent.children).to.have.lengthOf(0);
      } else {
        // Only the last parent should have the cloned central child
        expect(clonedParent.children).to.have.lengthOf(1);
        const clonedCentral = clonedParent.children[0];
        expect(clonedCentral).to.not.equal(centralChild);
        expect(clonedCentral.name).to.equal("central");
        expect(clonedCentral.value).to.equal(999);
      }
    }
  });
});

// =============================================================================
// Mixed Scenarios Tests
// =============================================================================

describe("Mixed clone scenarios", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should handle non-cloneable items gracefully", () => {
    const parent = new ParentWithChildList({
      name: "parent",
      children: [
        new ChildComponent({ name: "cloneable", value: 1 }),
        "string value" as any, // Non-cloneable
        42 as any, // Non-cloneable
        null as any, // Non-cloneable
      ],
      references: [],
    });

    const cloned = parent.clone();

    expect(cloned.children).to.have.lengthOf(4);
    expect(cloned.children[0]).to.not.equal(parent.children[0]); // Cloned
    expect(cloned.children[1]).to.equal("string value"); // Copied as-is
    expect(cloned.children[2]).to.equal(42); // Copied as-is
    expect(cloned.children[3]).to.eq(null); // Copied as-is
  });

  it("should handle objects with broken clone methods", () => {
    // With the new implementation, objects need [isProxyEntity] symbol to be cloned
    // Objects without this symbol are copied as-is, avoiding the broken clone method
    const brokenCloneable = {
      name: "broken",
      clone: () => {
        throw new Error("Clone failed!");
      },
    };

    const parent = new ParentWithChildList({
      name: "parent",
      children: [brokenCloneable as any],
      references: [],
    });

    // Should not throw - objects without isProxyEntity symbol are copied as-is
    const cloned = parent.clone();
    expect(cloned.children[0]).to.equal(brokenCloneable); // Same reference, not cloned
  });

  it("should handle objects that return invalid clones", () => {
    // With the new implementation using isModelType guard,
    // objects without isProxyEntity symbol are not cloned at all
    const invalidCloneable = {
      name: "invalid",
      clone: () => "not an object", // This won't be called
    };

    const parent = new ParentWithChildList({
      name: "parent",
      children: [invalidCloneable as any],
      references: [],
    });

    // Object is copied as-is since it doesn't have isProxyEntity symbol
    const cloned = parent.clone();
    expect(cloned.children[0]).to.equal(invalidCloneable); // Same reference
  });

  it("should handle extremely deep nesting without stack overflow", () => {
    // Create a deeply nested structure
    let current = new ChildComponent({ name: "leaf", value: 0 });

    // Build 100 levels deep
    for (let i = 1; i <= 100; i++) {
      current = new ParentWithChildList({
        name: `level${i}`,
        children: [current],
        references: [],
      }) as any;
    }

    // Should not stack overflow
    const cloned = (current as any).clone();

    // Verify deep structure is preserved
    let currentCloned = cloned;
    for (let i = 100; i >= 1; i--) {
      expect(currentCloned.name).to.equal(`level${i}`);
      expect(currentCloned.children).to.have.lengthOf(1);
      currentCloned = currentCloned.children[0];
    }

    // Should reach the leaf
    expect(currentCloned.name).to.equal("leaf");
    expect(currentCloned.value).to.equal(0);
  });

  it("should handle concurrent clone operations (single parent constraint)", async () => {
    // Test that multiple clone operations don't interfere with each other's transactions
    const sharedChild = new ChildComponent({ name: "shared", value: 1 });

    const parents = Array.from(
      { length: 10 },
      (_, i) =>
        new ParentWithChildList({
          name: `parent${i}`,
          children: [sharedChild], // Each assignment moves sharedChild to the new parent
          references: [],
        }),
    );

    // Parent tracking should have moved sharedChild to the last parent
    for (let i = 0; i < 9; i++) {
      expect(parents[i].children).to.have.lengthOf(0); // All previous parents lost the child
    }
    expect(parents[9].children).to.have.lengthOf(1); // Only the last parent has it
    expect(parents[9].children[0]).to.equal(sharedChild);

    // Clone all parents concurrently
    const clonePromises = parents.map((parent) => Promise.resolve().then(() => parent.clone()));

    const clonedParents = await Promise.all(clonePromises);

    // Each clone should be independent
    for (let i = 0; i < 10; i++) {
      expect(clonedParents[i]).to.not.equal(parents[i]);
      expect(clonedParents[i].name).to.equal(`parent${i}`);

      if (i < 9) {
        // First 9 parents should have no children
        expect(clonedParents[i].children).to.have.lengthOf(0);
      } else {
        // Only the last parent should have the cloned child
        expect(clonedParents[i].children).to.have.lengthOf(1);
        expect(clonedParents[i].children[0]).to.not.equal(sharedChild);
        expect(clonedParents[i].children[0].name).to.equal("shared");
      }
    }
  });
});

// =============================================================================
// Ephemeral Entity Reference Tests
// =============================================================================

describe("Ephemeral entity reference behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should keep ephemeral entity ephemeral when referencing stored entity", () => {
    // Create a stored (materialized) entity
    const storedChild = new ChildComponent({ name: "stored", value: 100 });

    // Create ephemeral entity that references the stored one
    const ephemeralParent = new ParentWithChildVal({
      name: "ephemeral",
      child: null,
      reference: storedChild, // Ephemeral entity referencing stored entity
    });

    // The ephemeral entity should remain ephemeral despite referencing stored entity
    expect(ephemeralParent.reference).to.equal(storedChild);
    expect(ephemeralParent.reference!.name).to.equal("stored");

    // Clone the ephemeral parent
    const cloned = ephemeralParent.clone();

    // The cloned ephemeral should still reference the original stored entity
    expect(cloned.reference).to.equal(storedChild); // Same reference to stored
    expect(cloned.reference).to.equal(storedChild);
  });

  it("should handle mixed ephemeral/materialized in lists - clone child-list and remap references", () => {
    const materializedChild1 = new ChildComponent({ name: "materialized1", value: 1 });
    const materializedChild2 = new ChildComponent({ name: "materialized2", value: 2 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 3 });

    const parent = new ParentWithChildList({
      name: "mixed",
      children: [ephemeralChild, materializedChild1], // child-list: should clone both
      references: [ephemeralChild, materializedChild2], // list: ephemeralChild remapped, materializedChild2 preserved
    });

    const cloned = parent.clone();

    // child-list: both items should be cloned (even if original was ephemeral)
    expect(cloned.children).to.have.lengthOf(2);
    expect(cloned.children[0]).to.not.equal(ephemeralChild);
    expect(cloned.children[1]).to.not.equal(materializedChild1);
    expect(cloned.children[0].name).to.equal("ephemeral");
    expect(cloned.children[1].name).to.equal("materialized1");

    // list: ephemeralChild should be remapped, materializedChild2 preserved
    expect(cloned.references).to.have.lengthOf(2);
    expect(cloned.references[0]).to.equal(cloned.children[0]); // Remapped to clone
    expect(cloned.references[1]).to.equal(materializedChild2); // Not cloned, preserved
  });

  it("should handle mixed ephemeral/materialized in records - clone child-record and remap references", () => {
    const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });
    const otherChild = new ChildComponent({ name: "other", value: 3 });

    const parent = new ParentWithChildRecord({
      name: "mixed",
      childMap: {
        mat: materializedChild,
        eph: ephemeralChild,
      }, // child-record: should clone both
      refMap: {
        mat: materializedChild,
        eph: ephemeralChild,
        other: otherChild,
      }, // record: mat and eph remapped, other preserved
    });

    const cloned = parent.clone();

    // child-record: both values should be cloned
    expect(Object.keys(cloned.childMap)).to.deep.equal(["mat", "eph"]);
    expect(cloned.childMap.mat).to.not.equal(materializedChild);
    expect(cloned.childMap.eph).to.not.equal(ephemeralChild);
    expect(cloned.childMap.mat.name).to.equal("materialized");
    expect(cloned.childMap.eph.name).to.equal("ephemeral");

    // record: cloned values should be remapped, other preserved
    expect(Object.keys(cloned.refMap)).to.deep.equal(["mat", "eph", "other"]);
    expect(cloned.refMap.mat).to.equal(cloned.childMap.mat); // Remapped to clone
    expect(cloned.refMap.eph).to.equal(cloned.childMap.eph); // Remapped to clone
    expect(cloned.refMap.other).to.equal(otherChild); // Not cloned, preserved
  });

  it("should handle mixed ephemeral/materialized in sets - clone child-set and remap references", () => {
    const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });
    const otherChild = new ChildComponent({ name: "other", value: 3 });

    const parent = new ParentWithChildSet({
      name: "mixed",
      childSet: new Set([materializedChild, ephemeralChild]), // child-set: should clone both
      refSet: new Set([materializedChild, ephemeralChild, otherChild]), // set: mat and eph remapped, other preserved
    });

    const cloned = parent.clone();

    // child-set: both items should be cloned
    expect(cloned.childSet.size).to.equal(2);
    const clonedChildren = [...cloned.childSet];
    expect(clonedChildren.every((child) => child !== materializedChild && child !== ephemeralChild)).to.eq(true);
    expect(clonedChildren.some((child) => child.name === "materialized")).to.eq(true);
    expect(clonedChildren.some((child) => child.name === "ephemeral")).to.eq(true);

    // set: cloned items should be remapped, other preserved
    expect(cloned.refSet).to.satisfy(
      (s: Set<unknown>) =>
        s.size === 3 &&
        s.has(clonedChildren[0]) &&
        s.has(clonedChildren[1]) &&
        s.has(otherChild) &&
        !s.has(materializedChild) &&
        !s.has(ephemeralChild),
    );
  });
});

// =============================================================================
// Assign Behavior Tests
// =============================================================================

describe("Assign behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("array.assign()", () => {
    it("should replace entire array contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old1", "old2", "old3"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const newItems = ["new1", "new2"];
      model.items = newItems;

      expect(model.items).to.deep.equal(["new1", "new2"]);
      expect(model.items).to.not.equal(newItems);
      newItems.push("new3");
      expect(model.items).to.deep.equal(["new1", "new2"]);
    });

    it("should handle empty array assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["item1", "item2"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      model.items = [];
      expect(model.items).to.be.an("array").that.is.empty;
    });

    it("should trigger modification tracking", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const notifyChanges = vi.fn();

      const dispose = reaction(
        () => model.items.length,
        notifyChanges,
      );

      expect(model.items.length).to.equal(1);

      model.items = ["new1", "new2"];
      expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf.above(0);
      dispose();
    });
  });

  describe("set.assign()", () => {
    it("should replace entire set contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old1", "old2"]),
        metadata: {},
        references: new Set(),
      });

      model.tags = new Set(["new1", "new2", "new3"]);

      expect([...model.tags]).to.include.members(["new1", "new2", "new3"]);
    });

    it("should handle duplicate values in assignment (maintains set uniqueness)", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old"]),
        metadata: {},
        references: new Set(),
      });

      model.tags = new Set(["new1", "new2", "new1", "new2"]);
      expect([...model.tags]).to.include.members(["new1", "new2"]);
      expect(model.tags.size).to.equal(2);
    });

    it("should work with entity references", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });
      const comp3 = new TestComponent({ name: "comp3", version: 3 });

      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp1]),
      });

      model.references = new Set([comp2, comp3]);
      expect([...model.references]).to.include.members([comp2, comp3]);
      expect(model.references.has(comp1)).to.eq(false);
      expect(model.references.has(comp2)).to.eq(true);
      expect(model.references.has(comp3)).to.eq(true);
    });
  });

  describe("map.assign()", () => {
    it("should replace entire map contents with Record object", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { old1: "value1", old2: "value2" },
        references: new Set(),
      });

      model.metadata = { new1: "newValue1", new2: "newValue2" };

      expect(model.metadata).to.deep.equal({ new1: "newValue1", new2: "newValue2" });
      expect(Object.keys(model.metadata)).to.deep.equal(["new1", "new2"]);
    });

    it("should handle empty assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { existing: "value" },
        references: new Set(),
      });

      model.metadata = {};
      expect(model.metadata).to.deep.equal({});
      expect(Object.keys(model.metadata)).to.deep.equal([]);
    });
  });
});

// =============================================================================
// Clear Behavior Tests
// =============================================================================

describe("Clear behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should clear set contents", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(["tag1", "tag2", "tag3"]),
      metadata: {},
      references: new Set(),
    });

    const result = model.tags.clear();
    expect(model.tags.size).to.equal(0);
    expect([...model.tags]).to.deep.equal([]);
    expect(result).to.eq(undefined); // Native Set.clear() returns undefined
  });

  it("should clear map contents via empty assignment", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(),
      metadata: { key1: "value1", key2: "value2" },
      references: new Set(),
    });

    model.metadata = {};
    expect(model.metadata).to.deep.equal({});
    expect(Object.keys(model.metadata)).to.deep.equal([]);
  });

  it("should handle clearing empty collections", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(),
      metadata: {},
      references: new Set(),
    });

    expect(model.tags.clear()).to.eq(undefined); // Native Set.clear() returns undefined
    model.metadata = {};
    expect(model.tags.size).to.equal(0);
    expect(Object.keys(model.metadata)).to.deep.equal([]);
  });
});

// =============================================================================
// Method Combinations Tests
// =============================================================================

describe("Method combinations", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should work with clone and assign together", () => {
    const original = new TestModel({
      name: "original",
      value: 100,
      component: null,
      items: ["item1", "item2"],
      tags: new Set(["tag1"]),
      metadata: { key: "value" },
      references: new Set(),
    });

    const cloned = original.clone();

    // Modify the cloned entity collections
    cloned.items = ["new1", "new2", "new3"];
    cloned.tags = new Set(["newTag1", "newTag2"]);
    cloned.metadata = { newKey: "newValue" };

    // Original should be unchanged
    expect(original.items).to.deep.equal(["item1", "item2"]);
    expect([...original.tags]).to.deep.equal(["tag1"]);
    expect(original.metadata).to.deep.equal({ key: "value" });

    // Cloned should have new values
    expect(cloned.items).to.deep.equal(["new1", "new2", "new3"]);
    expect([...cloned.tags]).to.include.members(["newTag1", "newTag2"]);
    expect(cloned.metadata).to.deep.equal({ newKey: "newValue" });
  });

  it("should work with clear and assign together", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: ["old1", "old2"],
      tags: new Set(["oldTag1", "oldTag2"]),
      metadata: { oldKey1: "oldValue1", oldKey2: "oldValue2" },
      references: new Set(),
    });

    // Clear everything
    model.tags.clear();
    model.metadata = {};

    expect(model.tags.size).to.equal(0);
    expect(Object.keys(model.metadata)).to.deep.equal([]);

    // Then assign new values
    model.items = ["new1"];
    model.tags = new Set(["newTag"]);
    model.metadata = { newKey: "newValue" };

    expect(model.items).to.deep.equal(["new1"]);
    expect([...model.tags]).to.deep.equal(["newTag"]);
    expect(model.metadata).to.deep.equal({ newKey: "newValue" });
  });
});
