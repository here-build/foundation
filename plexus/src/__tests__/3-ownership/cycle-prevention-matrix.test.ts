/**
 * Cycle Prevention Matrix Tests
 *
 * Tests cycle prevention across all combinations of child container types.
 * Matrix: source (val/list/record/set) × target (val/list/record/set) = 16 combinations
 *
 * Each test creates: root -> A -> B, then tries B -> A (cycle)
 * where A holds B in one container type and B tries to adopt A in another.
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

type ContainerType = "val" | "list" | "record" | "set";

const containerTypes: ContainerType[] = ["val", "list", "record", "set"];

// Helper to add child to parent via specified container type
function addChild(parent: Node, child: Node, via: ContainerType): void {
  switch (via) {
    case "val":
      parent.childVal = child;
      break;
    case "list":
      parent.childList.push(child);
      break;
    case "record":
      parent.childRecord["key"] = child;
      break;
    case "set":
      parent.childSet.add(child);
      break;
  }
}

// Helper to attempt adding child (returns error or null)
function tryAddChild(parent: Node, child: Node, via: ContainerType): Error | null {
  try {
    addChild(parent, child, via);
    return null;
  } catch (error) {
    return error as Error;
  }
}

// Helper to verify child is NOT in parent's container
function verifyChildNotIn(parent: Node, child: Node, via: ContainerType): void {
  switch (via) {
    case "val":
      expect(parent.childVal !== child).to.eq(true);
      break;
    case "list":
      expect(parent.childList.includes(child)).to.eq(false);
      break;
    case "record":
      expect(Object.values(parent.childRecord).includes(child)).to.eq(false);
      break;
    case "set":
      expect(parent.childSet.has(child)).to.eq(false);
      break;
  }
}

// Helper to verify child IS in parent's container
function verifyChildIn(parent: Node, child: Node, via: ContainerType): void {
  switch (via) {
    case "val":
      expect(parent.childVal === child).to.eq(true);
      break;
    case "list":
      expect(parent.childList.includes(child)).to.eq(true);
      break;
    case "record":
      expect(Object.values(parent.childRecord).includes(child)).to.eq(true);
      break;
    case "set":
      expect(parent.childSet.has(child)).to.eq(true);
      break;
  }
}

describe("Cycle Prevention Matrix", () => {
  describe("direct cycles (A -> B, then B -> A)", () => {
    // Generate all 16 combinations
    for (const sourceType of containerTypes) {
      for (const targetType of containerTypes) {
        it(`prevents cycle: A.${sourceType} -> B, B.${targetType} -> A`, () => {
          const { root } = initTestPlexus(new Root());

          const A = new Node({ name: "A" });
          const B = new Node({ name: "B" });

          // Setup: root -> A -> B (via sourceType)
          root.primary = A;
          addChild(A, B, sourceType);

          // Verify setup
          expect([A.parent === root, B.parent === A]).to.have.ordered.members([true, true]);
          verifyChildIn(A, B, sourceType);

          // Attempt cycle: B -> A (via targetType)
          const error = tryAddChild(B, A, targetType);

          // Should throw cycle error
          expect(error).to.not.eq(null);
          expect(error!.message).to.match(/cycle/i);

          // Verify no cycle was created
          expect([A.parent === root, B.parent === A]).to.have.ordered.members([true, true]);
          verifyChildIn(A, B, sourceType);
          verifyChildNotIn(B, A, targetType);
        });
      }
    }
  });

  describe("transitive cycles (A -> B -> C, then C -> A)", () => {
    // Test representative combinations for transitive cycles
    const representativeCombos: [ContainerType, ContainerType, ContainerType][] = [
      ["val", "val", "val"],
      ["list", "list", "list"],
      ["record", "record", "record"],
      ["set", "set", "set"],
      ["val", "list", "record"],
      ["list", "record", "set"],
      ["record", "set", "val"],
      ["set", "val", "list"],
    ];

    for (const [abType, bcType, caType] of representativeCombos) {
      it(`prevents transitive cycle: A.${abType} -> B.${bcType} -> C, C.${caType} -> A`, () => {
        const { root } = initTestPlexus(new Root());

        const A = new Node({ name: "A" });
        const B = new Node({ name: "B" });
        const C = new Node({ name: "C" });

        // Setup: root -> A -> B -> C
        root.primary = A;
        addChild(A, B, abType);
        addChild(B, C, bcType);

        // Verify setup
        expect([A.parent === root, B.parent === A, C.parent === B]).to.have.ordered.members([true, true, true]);

        // Attempt transitive cycle: C -> A
        const error = tryAddChild(C, A, caType);

        // Should throw cycle error
        expect(error).to.not.eq(null);
        expect(error!.message).to.match(/cycle/i);

        // Verify no cycle was created
        expect([A.parent === root, B.parent === A, C.parent === B]).to.have.ordered.members([true, true, true]);
        verifyChildNotIn(C, A, caType);
      });
    }
  });

  describe("self-adoption via each container type", () => {
    for (const containerType of containerTypes) {
      it(`prevents self-adoption via ${containerType}`, () => {
        const { root } = initTestPlexus(new Root());

        const A = new Node({ name: "A" });
        root.primary = A;

        // Attempt self-adoption
        const error = tryAddChild(A, A, containerType);

        // Should throw self/cycle error
        expect(error).to.not.eq(null);
        expect(error!.message).to.match(/self|cycle/i);

        // Verify no self-reference
        verifyChildNotIn(A, A, containerType);
        expect(A.parent === root).to.eq(true);
      });
    }
  });

  describe("valid moves (no cycle)", () => {
    // Verify that non-cyclic moves still work
    for (const containerType of containerTypes) {
      it(`allows valid child move via ${containerType}`, () => {
        const { root } = initTestPlexus(new Root());

        const A = new Node({ name: "A" });
        const B = new Node({ name: "B" });
        const C = new Node({ name: "C" });

        // Setup: root -> A, root has B as sibling via primary change
        root.primary = A;
        addChild(A, B, containerType);

        // C is not in the parent chain of A, so A can adopt C
        const error = tryAddChild(A, C, containerType === "val" ? "list" : "val");

        expect(error).to.eq(null);
      });
    }
  });
});
