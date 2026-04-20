/**
 * Runtime error handling tests
 *
 * Tests behavior when things go wrong at runtime:
 * - Accessing dematerialized models
 * - Invalid operations on collections
 * - Document lifecycle edge cases
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor count: number = 0;
}

@syncing("Container")
class Container extends PlexusModel<null> {
  @syncing accessor val: string = "";
  @syncing.child accessor child: Item | null = null;
  @syncing.child.list accessor children: Item[] = [];
  @syncing.child.record accessor childRecord: Record<string, Item> = {};
}

describe("Runtime Error Handling", () => {
  describe("orphaned model behavior", () => {
    // Note: Orphaned models (removed from parent) don't throw on access.
    // They become "detached" but still readable. This is intentional -
    // it allows for operations like moving items between containers.

    it("orphaned model remains readable after removal from parent", () => {
      const { root } = initTestPlexus(new Container());
      const child = new Item({ name: "test" });
      root.child = child;

      // Get reference to the materialized child
      const materializedChild = root.child!;
      expect(materializedChild.name).to.equal("test");

      // Remove child (orphans it)
      root.child = null;

      // Orphaned model is still readable
      expect(materializedChild.name).to.equal("test");
    });

    it("orphaned model can still be modified", () => {
      const { root } = initTestPlexus(new Container());
      const child = new Item({ name: "test" });
      root.child = child;

      const materializedChild = root.child!;
      root.child = null;

      // Orphaned model can be modified
      materializedChild.name = "changed";
      expect(materializedChild.name).to.equal("changed");
    });

    it("orphaned model from list remains accessible", () => {
      const { root } = initTestPlexus(new Container());
      root.children.push(new Item({ name: "item1" }));

      const item = root.children[0];
      expect(item.name).to.equal("item1");

      // Remove from list
      root.children.pop();

      // Orphaned model is still accessible
      expect(item.name).to.equal("item1");
    });

    it("orphaned model can be re-adopted by another parent", () => {
      const { root } = initTestPlexus(new Container());
      const item = new Item({ name: "movable" });
      root.children.push(item);

      const orphan = root.children[0];
      root.children.pop();

      // Re-adopt into different field
      root.child = orphan;
      expect(root.child!.name).to.equal("movable");
    });
  });

  describe("collection operation edge cases", () => {
    it("handles removing non-existent item from set gracefully", () => {
      const { root } = initTestPlexus(new Container());

      // Create a set field for testing
      @syncing("SetContainer")
      class SetContainer extends PlexusModel<null> {
        @syncing.set accessor items: Set<string> = new Set();
      }

      const { root: setRoot } = initTestPlexus(new SetContainer());
      setRoot.items.add("a");

      // Removing non-existent item should return false, not throw
      expect([setRoot.items.delete("nonexistent"), setRoot.items.size]).to.have.ordered.members([false, 1]);
    });

    it("handles clearing empty collection gracefully", () => {
      const { root } = initTestPlexus(new Container());

      // Clear empty list - should not throw
      expect(() => (root.children.length = 0)).to.not.throw();
      expect(root.children).to.have.lengthOf(0);

      // Clear empty record - should work via assign
      expect(() => {
        for (const key of Object.keys(root.childRecord)) {
          delete root.childRecord[key];
        }
      }).to.not.throw();
    });

    it("handles pop on empty array gracefully", () => {
      const { root } = initTestPlexus(new Container());

      // Pop on empty array should return undefined, not throw
      const result = root.children.pop();
      expect(result).to.eq(undefined);
    });

    it("handles shift on empty array gracefully", () => {
      const { root } = initTestPlexus(new Container());

      const result = root.children.shift();
      expect(result).to.eq(undefined);
    });
  });

  describe("duplicate child prevention", () => {
    it("throws when pushing same child twice in single call", () => {
      const { root } = initTestPlexus(new Container());
      const item = new Item({ name: "item" });

      expect(() => {
        root.children.push(item, item);
      }).to.throw();
    });

    it("throws when splicing same child twice", () => {
      const { root } = initTestPlexus(new Container());
      const item = new Item({ name: "item" });

      expect(() => {
        root.children.splice(0, 0, item, item);
      }).to.throw();
    });

    it("throws when unshifting same child twice", () => {
      const { root } = initTestPlexus(new Container());
      const item = new Item({ name: "item" });

      expect(() => {
        root.children.unshift(item, item);
      }).to.throw();
    });

    it("throws when assign contains duplicates", () => {
      const { root } = initTestPlexus(new Container());
      const item = new Item({ name: "item" });

      expect(() => {
        (root.children as any).assign([item, item]);
      }).to.throw();
    });
  });

  describe("document lifecycle", () => {
    it("handles operations after doc destroy gracefully", () => {
      const container = new Container();
      const { root, plexus } = initTestPlexus(container);

      root.val = "before";
      expect(root.val).to.equal("before");

      // Destroy the underlying doc
      plexus.doc.destroy();

      expect(() => {
        // Operations after destroy - behavior depends on implementation
        // At minimum, should not cause unhandled exceptions
        root.val = "after";
      }).to.not.throw();
    });
  });

  describe("index bounds", () => {
    it("throws on negative array index assignment", () => {
      const { root } = initTestPlexus(new Container());
      root.children.push(new Item({ name: "item" }));

      // Negative index throws (proxy returns false from set trap)
      expect(() => {
        (root.children as any)[-1] = new Item({ name: "negative" });
      }).to.throw();

      // Array should be unchanged
      expect(root.children).to.have.lengthOf(1);
    });

    it("handles out-of-bounds read gracefully", () => {
      const { root } = initTestPlexus(new Container());
      root.children.push(new Item({ name: "item" }));

      // Out of bounds read should return undefined
      expect([root.children[100], root.children[-1]]).to.have.ordered.members([undefined, undefined]);
    });

    it("handles sparse array creation via index assignment", () => {
      const { root } = initTestPlexus(new Container());

      // Setting index 4 on empty array creates sparse array with nulls
      root.children[4] = new Item({ name: "sparse" });

      expect([root.children.length, root.children[0], root.children[3], root.children[4].name]).to.have.ordered.members(
        [5, null, null, "sparse"],
      );
    });

    it("fills holes with null when extending array", () => {
      const { root } = initTestPlexus(new Container());
      root.children.push(new Item({ name: "first" }));

      // Setting index 2 creates hole at 1
      root.children[2] = new Item({ name: "third" });

      expect([
        root.children.length,
        root.children[0].name,
        root.children[1],
        root.children[2].name,
      ]).to.have.ordered.members([3, "first", null, "third"]);
    });
  });
});
