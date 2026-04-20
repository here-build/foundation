/**
 * Lifecycle transition chain tests
 *
 * Tests for complex state transitions:
 * - Ephemeral → Materialized transitions
 * - Child adoption/orphanization chains
 * - Entity movement between parents
 * - Deep hierarchy transitions
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Node")
class Node extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor child: Node | null = null;
  @syncing.child.list accessor children: Node[] = [];
}

@syncing("Root")
class Root extends PlexusModel<null> {
  @syncing.child accessor primary: Node | null = null;
  @syncing.child accessor secondary: Node | null = null;
  @syncing.child.list accessor nodes: Node[] = [];
  @syncing.child.record accessor namedNodes: Record<string, Node> = {};
}

describe("Lifecycle Transition Chains", () => {
  describe("ephemeral to materialized", () => {
    it("materializes entire subtree when assigned to root", () => {
      const { root } = initTestPlexus(new Root());

      // Create ephemeral subtree
      const grandchild = new Node({ name: "grandchild" });
      const child = new Node({ name: "child", child: grandchild });
      const parent = new Node({ name: "parent", child });

      // Assign to root - should materialize entire subtree
      root.primary = parent;

      // All nodes should be materialized (have uuid)
      expect([root.primary!.uuid, root.primary!.child!.uuid, root.primary!.child!.child!.uuid]).to.satisfy(
        (uuids: any[]) => uuids.every((u) => u !== undefined),
      );
    });

    it("materializes array of ephemeral children", () => {
      const { root } = initTestPlexus(new Root());

      // Create ephemeral nodes
      const nodes = [new Node({ name: "a" }), new Node({ name: "b" }), new Node({ name: "c" })];

      // Assign as array
      (root.nodes as any).assign(nodes);

      // All should be materialized
      expect(root.nodes).to.have.lengthOf(3);
      expect(root.nodes.map((n) => n.name)).to.have.ordered.members(["a", "b", "c"]);
      expect(root.nodes.every((n) => n.uuid !== undefined)).to.eq(true);
    });

    it("materializes record of ephemeral children", () => {
      const { root } = initTestPlexus(new Root());

      root.namedNodes["x"] = new Node({ name: "X" });
      root.namedNodes["y"] = new Node({ name: "Y" });

      expect([
        root.namedNodes["x"].uuid !== undefined,
        root.namedNodes["y"].uuid !== undefined,
      ]).to.have.ordered.members([true, true]);
    });
  });

  describe("child movement between parents", () => {
    it("moves child from one field to another", () => {
      const { root } = initTestPlexus(new Root());

      const node = new Node({ name: "movable" });
      root.primary = node;

      const uuid = root.primary!.uuid;

      // Move to secondary
      root.secondary = root.primary;
      root.primary = null;

      // Same entity, same uuid
      expect([root.primary, root.secondary!.name, root.secondary!.uuid]).to.have.ordered.members([
        null,
        "movable",
        uuid,
      ]);
    });

    it("moves child from field to array", () => {
      const { root } = initTestPlexus(new Root());

      const node = new Node({ name: "to-array" });
      root.primary = node;

      const ref = root.primary!;
      root.nodes.push(ref);
      root.primary = null;

      expect([root.primary, root.nodes.length, root.nodes[0].name]).to.have.ordered.members([null, 1, "to-array"]);
    });

    it("moves child from array to field", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "from-array" }));

      const ref = root.nodes[0];
      root.primary = ref;
      root.nodes.pop();

      expect([root.nodes.length, root.primary!.name]).to.have.ordered.members([0, "from-array"]);
    });

    it("moves child from array to record", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "to-record" }));

      const ref = root.nodes[0];
      root.namedNodes["moved"] = ref;
      root.nodes.pop();

      expect([root.nodes.length, root.namedNodes["moved"].name]).to.have.ordered.members([0, "to-record"]);
    });
  });

  describe("deep hierarchy transitions", () => {
    it("handles moving deep nested child to root level", () => {
      const { root } = initTestPlexus(new Root());

      // Create deep hierarchy: root → primary → child → child
      root.primary = new Node({
        name: "level1",
        child: new Node({
          name: "level2",
          child: new Node({ name: "level3" }),
        }),
      });

      // Get reference to deepest node
      const deep = root.primary!.child!.child!;
      expect(deep.name).to.equal("level3");

      // Move to root level
      root.secondary = deep;

      // Original path should be cleared, node should be at new location
      expect([root.primary!.child!.child, root.secondary!.name]).to.have.ordered.members([null, "level3"]);
    });

    it("handles swapping children at different levels", () => {
      const { root } = initTestPlexus(new Root());

      root.primary = new Node({
        name: "parent",
        child: new Node({ name: "child" }),
      });

      // Create another child
      root.secondary = new Node({ name: "other" });

      // Swap: move primary's child to secondary, move secondary to primary's child
      const childRef = root.primary!.child!;
      const secondaryRef = root.secondary!;

      // Clear original locations first
      root.primary!.child = null;
      root.secondary = null;

      // Set to new locations
      root.secondary = childRef;
      root.primary!.child = secondaryRef;

      expect([root.primary!.child!.name, root.secondary!.name]).to.have.ordered.members(["other", "child"]);
    });
  });

  describe("array reordering as transitions", () => {
    it("handles sorting children in array", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "c" }));
      root.nodes.push(new Node({ name: "a" }));
      root.nodes.push(new Node({ name: "b" }));

      // Sort by name
      root.nodes.sort((a, b) => a.name.localeCompare(b.name));

      expect(root.nodes.map((n) => n.name)).to.have.ordered.members(["a", "b", "c"]);
    });

    it("handles reversing children in array", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "first" }));
      root.nodes.push(new Node({ name: "second" }));
      root.nodes.push(new Node({ name: "third" }));

      const uuids = root.nodes.map((n) => n.uuid);

      root.nodes.reverse();

      expect(root.nodes.map((n) => n.name)).to.have.ordered.members(["third", "second", "first"]);

      // Same entities, just reordered
      expect(root.nodes.map((n) => n.uuid)).to.deep.equal(uuids.reverse());
    });
  });

  describe("cross-document lifecycle", () => {
    it("entity survives document sync and maintains identity", () => {
      const { root: root1, plexus: plexus1 } = initTestPlexus(new Root());

      root1.primary = new Node({ name: "synced" });
      const originalUuid = root1.primary!.uuid;

      // Create second document and sync
      const doc2 = new Y.Doc({ guid: plexus1.doc.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));

      const { root: root2 } = connectTestPlexus<Root>(doc2);

      // Same entity should exist in both docs
      expect([root2.primary!.uuid, root2.primary!.name]).to.have.ordered.members([originalUuid, "synced"]);

      doc2.destroy();
    });

    it("modifications sync bidirectionally", () => {
      const { root: root1, plexus: plexus1 } = initTestPlexus(new Root());

      root1.primary = new Node({ name: "original" });

      // Create and sync doc2
      const doc2 = new Y.Doc({ guid: plexus1.doc.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));
      const { root: root2 } = connectTestPlexus<Root>(doc2);

      // Modify in doc1
      root1.primary!.name = "modified-in-doc1";

      // Sync to doc2
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));
      const afterDoc1Sync = root2.primary!.name;

      // Modify in doc2
      root2.primary!.name = "modified-in-doc2";

      // Sync back to doc1
      Y.applyUpdate(plexus1.doc, Y.encodeStateAsUpdate(doc2));

      expect([afterDoc1Sync, root1.primary!.name]).to.have.ordered.members(["modified-in-doc1", "modified-in-doc2"]);

      doc2.destroy();
    });
  });

  describe("orphanization chains", () => {
    it("orphaned subtree can be re-adopted", () => {
      const { root } = initTestPlexus(new Root());

      // Create subtree
      root.primary = new Node({
        name: "parent",
        child: new Node({ name: "child" }),
      });

      // Get reference and orphan
      const subtree = root.primary!;
      root.primary = null;

      // Re-adopt
      root.secondary = subtree;

      expect([root.secondary!.name, root.secondary!.child!.name]).to.have.ordered.members(["parent", "child"]);
    });

    it("orphaned child remains modifiable", () => {
      const { root } = initTestPlexus(new Root());

      root.primary = new Node({ name: "will-be-orphaned" });

      const orphan = root.primary!;
      root.primary = null;

      // Modify orphaned node
      orphan.name = "orphan-modified";

      // Re-adopt and verify modification persisted
      root.primary = orphan;
      expect(root.primary!.name).to.equal("orphan-modified");
    });
  });
});
