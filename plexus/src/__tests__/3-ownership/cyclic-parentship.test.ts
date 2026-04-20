/**
 * Cyclic parentship tests
 *
 * Tests for circular ownership detection/prevention.
 * Unlike cycles.test.ts which tests circular REFERENCES (@syncing.list),
 * this tests circular OWNERSHIP (@syncing.child.list).
 *
 * Plexus prevents cyclic parentship by checking the parent chain
 * before allowing adoption.
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Node")
class Node extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor child: Node | null = null;
}

@syncing("Root")
class Root extends PlexusModel<null> {
  @syncing.child accessor primary: Node | null = null;
  @syncing.child accessor secondary: Node | null = null;
}

describe("Cyclic Parentship", () => {
  describe("direct cycle A -> B -> A", () => {
    it("should prevent B from adopting its parent A as child", () => {
      const { root } = initTestPlexus(new Root());

      // Create A -> B chain
      const A = new Node({ name: "A" });
      const B = new Node({ name: "B" });
      root.primary = A;
      A.child = B;

      expect([A.child === B, B.parent === A]).to.have.ordered.members([true, true]);

      // Try to make B adopt A (would create cycle)
      // Expected: Should throw to prevent the cycle
      expect(() => {
        B.child = A;
      }).to.throw(/cycle/i);

      // A should still be B's parent (cycle prevented)
      expect([A.child === B, B.child, A.parent === root, B.parent === A]).to.have.ordered.members([
        true,
        null,
        true,
        true,
      ]);
    });
  });

  describe("indirect cycle A -> B -> C -> A", () => {
    it("should prevent transitive cycles through chain", () => {
      const { root } = initTestPlexus(new Root());

      // Create A -> B -> C chain
      const A = new Node({ name: "A" });
      const B = new Node({ name: "B" });
      const C = new Node({ name: "C" });

      root.primary = A;
      A.child = B;
      B.child = C;

      expect([C.parent === B, B.parent === A, A.parent === root]).to.have.ordered.members([true, true, true]);

      // Try to make C adopt A (would create cycle through chain)
      expect(() => {
        C.child = A;
      }).to.throw(/cycle/i);

      // Cycle should be prevented
      expect([C.child, A.parent === root]).to.have.ordered.members([null, true]);
    });
  });

  describe("self-adoption", () => {
    it("should prevent node from adopting itself", () => {
      const { root } = initTestPlexus(new Root());

      const A = new Node({ name: "A" });
      root.primary = A;

      // Try self-adoption
      expect(() => {
        A.child = A;
      }).to.throw(/self/i);

      // Self-adoption should be prevented
      expect([A.child, A.parent === root]).to.have.ordered.members([null, true]);
    });
  });

  describe("orphaned cycles are now impossible", () => {
    it("prevents cycles before they can become orphaned", () => {
      const { root } = initTestPlexus(new Root());

      // Setup: root -> A -> B
      const A = new Node({ name: "A" });
      const B = new Node({ name: "B" });
      root.primary = A;
      A.child = B;

      // Try to create cycle - should throw
      expect(() => {
        B.child = A;
      }).to.throw(/cycle/i);

      // Everything remains connected to root
      expect([root.primary === A, A.parent === root, A.child === B, B.parent === A, B.child]).to.have.ordered.members([
        true,
        true,
        true,
        true,
        null,
      ]);
    });
  });
});
