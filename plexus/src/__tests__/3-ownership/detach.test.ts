/**
 * Detach Method Tests
 *
 * Tests the explicit detach() method for disconnecting entities from their parents.
 * The detach() method is useful for operations like node swapping that need to
 * temporarily disconnect entities.
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Node")
class Node extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor childVal: Node | null = null;
  @syncing.child.list accessor childList: Node[] = [];
  @syncing.child.record accessor childRecord: Record<string, Node> = {};
  @syncing.child.set accessor childSet: Set<Node> = new Set();
}

@syncing("Root")
class Root extends PlexusModel<null> {
  @syncing.child accessor primary: Node | null = null;
}

describe("Detach Method", () => {
  describe("return value", () => {
    it("returns true when entity was attached", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      root.primary = node;
      expect(node.parent).to.equal(root);

      const wasAttached = node.detach();

      expect(wasAttached).to.eq(true);
      expect(node.parent).to.eq(null);
    });

    it("returns false when entity was already detached", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      // Node created but never attached
      expect(node.parent).to.eq(null);

      const wasAttached = node.detach();

      expect(wasAttached).to.eq(false);
      expect(node.parent).to.eq(null);
    });

    it("returns false on second detach call", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      root.primary = node;

      // First detach
      const firstResult = node.detach();
      expect(firstResult).to.eq(true);

      // Second detach on already detached node
      const secondResult = node.detach();
      expect(secondResult).to.eq(false);
    });
  });

  describe("parent removal from containers", () => {
    it("removes from child-val field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      expect(parent.childVal).to.equal(child);
      expect(child.parent).to.equal(parent);

      child.detach();

      expect(parent.childVal).to.eq(null);
      expect(child.parent).to.eq(null);
    });

    it("removes from child-list field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childList.push(child);

      expect(parent.childList).to.include(child);
      expect(child.parent).to.equal(parent);

      child.detach();

      expect(parent.childList).to.have.lengthOf(0).and.not.include(child);
      expect(child.parent).to.eq(null);
    });

    it("removes from child-record field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childRecord["key"] = child;

      expect(parent.childRecord["key"]).to.equal(child);
      expect(child.parent).to.equal(parent);

      child.detach();

      expect(parent.childRecord["key"]).to.eq(undefined);
      expect(Object.keys(parent.childRecord)).to.have.lengthOf(0);
      expect(child.parent).to.eq(null);
    });

    it("removes from child-set field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childSet.add(child);

      expect(parent.childSet.has(child)).to.eq(true);
      expect(child.parent).to.equal(parent);

      child.detach();

      expect(parent.childSet.has(child)).to.eq(false);
      expect(parent.childSet.size).to.equal(0);
      expect(child.parent).to.eq(null);
    });
  });

  describe("use cases", () => {
    it("enables node swapping", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const nodeA = new Node({ name: "A" });
      const nodeB = new Node({ name: "B" });

      root.primary = parent;
      parent.childVal = nodeA;

      // Swap: detach A, set B, verify A is detached
      nodeA.detach();
      parent.childVal = nodeB;

      expect(parent.childVal).to.equal(nodeB);
      expect(nodeA.parent).to.eq(null);
      expect(nodeB.parent).to.equal(parent);

      // Can now attach A elsewhere or to same parent
      parent.childList.push(nodeA);
      expect(nodeA.parent).to.equal(parent);
    });

    it("enables safe node relocation", () => {
      const { root } = initTestPlexus(new Root());
      const parentA = new Node({ name: "ParentA" });
      const parentB = new Node({ name: "ParentB" });
      const child = new Node({ name: "Child" });

      root.primary = parentA;
      parentA.childList.push(parentB, child);

      // Move child from parentA.childList to parentB.childList
      // Without detach, this would remove from parentA's list automatically
      // But detach makes the operation explicit
      const wasInList = child.detach();
      expect(wasInList).to.eq(true);
      expect(parentA.childList).to.not.include(child);

      parentB.childList.push(child);
      expect(child.parent).to.equal(parentB);
      expect(parentB.childList).to.include(child);
    });

    it("can be used for conditional detachment", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;

      // Helper function that detaches only if needed
      function ensureDetached(node: Node): boolean {
        return node.detach(); // Returns true only if was attached
      }

      // First call - not attached yet
      expect(ensureDetached(child)).to.eq(false);

      // Attach it
      parent.childVal = child;

      // Second call - attached, will detach
      expect(ensureDetached(child)).to.eq(true);
      expect(child.parent).to.eq(null);

      // Third call - already detached
      expect(ensureDetached(child)).to.eq(false);
    });
  });

  describe("deeply nested detachment", () => {
    it("detaches from deeply nested parent", () => {
      const { root } = initTestPlexus(new Root());
      const level1 = new Node({ name: "Level1" });
      const level2 = new Node({ name: "Level2" });
      const level3 = new Node({ name: "Level3" });
      const level4 = new Node({ name: "Level4" });

      root.primary = level1;
      level1.childVal = level2;
      level2.childVal = level3;
      level3.childVal = level4;

      // Verify deep nesting
      expect(level4.parent).to.equal(level3);
      expect(level3.parent).to.equal(level2);
      expect(level2.parent).to.equal(level1);
      expect(level1.parent).to.equal(root);

      // Detach from middle
      const wasAttached = level3.detach();

      expect(wasAttached).to.eq(true);
      expect(level2.childVal).to.eq(null);
      expect(level3.parent).to.eq(null);

      // Upper levels unchanged
      expect(level2.parent).to.equal(level1);
      expect(level1.parent).to.equal(root);

      // Lower level still attached to level3
      expect(level4.parent).to.equal(level3);
    });
  });

  describe("multiple children detachment", () => {
    it("detaches multiple children from list", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child1 = new Node({ name: "Child1" });
      const child2 = new Node({ name: "Child2" });
      const child3 = new Node({ name: "Child3" });

      root.primary = parent;
      parent.childList.push(child1, child2, child3);

      expect(parent.childList).to.have.lengthOf(3);

      // Detach middle child
      child2.detach();

      expect(parent.childList).to.have.lengthOf(2).and.include(child1).and.include(child3).and.not.include(child2);

      // Detach all remaining
      child1.detach();
      child3.detach();

      expect(parent.childList).to.have.lengthOf(0);
    });
  });

  describe("edge cases", () => {
    it("can detach and reattach to same parent", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      child.detach();
      expect(parent.childVal).to.eq(null);

      // Reattach to same parent
      parent.childVal = child;
      expect(parent.childVal).to.equal(child);
      expect(child.parent).to.equal(parent);
    });

    it("can detach and attach to different field of same parent", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      child.detach();

      // Attach to different field of same parent
      parent.childList.push(child);
      expect(child.parent).to.equal(parent);
      expect(parent.childVal).to.eq(null);
      expect(parent.childList).to.include(child);
    });

    it("no-op on root entity", () => {
      const { root } = initTestPlexus(new Root());

      // Root has null parent (special case)
      expect(root.parent).to.eq(null);

      const wasAttached = root.detach();

      // Returns false because root has no parent
      expect(wasAttached).to.eq(false);
      expect(root.parent).to.eq(null);
    });
  });
});
