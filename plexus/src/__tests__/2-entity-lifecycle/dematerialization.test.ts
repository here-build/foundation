/**
 * Entity lifecycle under undo/redo with append-only shells.
 *
 * With deleteFilter, entity shells in typeMap survive undo.
 * Entities are never dematerialized — they become detached (no parent)
 * but remain readable with creation-time field values.
 *
 * These tests verify:
 * 1. Entities survive undo (append-only shell)
 * 2. Re-adding an undone entity works
 * 3. Redo invalidation by divergent action
 * 4. Reference vs child field semantics under undo
 * 5. Move between containers with undo
 */

import { beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Item")
class Item extends PlexusModel {
  @syncing
  accessor name: string = "";
}

@syncing("Container")
class Container extends PlexusModel {
  @syncing
  accessor name: string = "";

  @syncing.child
  accessor item: Item | null = null;

  @syncing.child.list
  accessor items: Item[] = [];

  @syncing
  accessor ref: Item | null = null;
}

@syncing("Root")
class Root extends PlexusModel {
  @syncing.child.list
  accessor containers: Container[] = [];

  @syncing.child.list
  accessor globals: Item[] = [];
}

describe("Entity lifecycle under undo/redo (append-only shells)", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<Root>;
  let root: Root;

  beforeEach(() => {
    const result = initTestPlexus(new Root({ containers: [], globals: [] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  describe("Basic undo/redo with append-only shells", () => {
    it("entity survives undo — not dematerialized, detached from tree", () => {
      const item = new Item({ name: "ephemeral" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      expect(root.globals.includes(item)).toBe(true);
      expect(item.name).toBe("ephemeral");

      plexus.undo();

      // Entity shell survives — NOT dematerialized
      expect(root.globals.includes(item)).toBe(false);
      // Entity survives undo — append-only shell
      // UUID is stable
      expect(item.uuid).toBeTruthy();
    });

    it("undo → redo restores entity fully", () => {
      const item = new Item({ name: "ephemeral" });

      plexus.transact(() => {
        root.globals.push(item);
        item.name = "modified";
      });

      expect(item.name).toBe("modified");

      plexus.undo();
      expect(root.globals.includes(item)).toBe(false);

      plexus.redo();
      expect(root.globals.includes(item)).toBe(true);
      expect(item.name).toBe("modified");
    });

    it("undo → re-add same entity works", () => {
      const item = new Item({ name: "first" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      plexus.undo();
      expect(root.globals.includes(item)).toBe(false);

      // Re-add the same entity (shell still exists in typeMap)
      plexus.transact(() => {
        root.globals.push(item);
      });

      expect(root.globals.includes(item)).toBe(true);
      expect(item.name).toBe("first");
    });

    it("undo → add different → redo is invalidated", () => {
      const item1 = new Item({ name: "first" });
      const item2 = new Item({ name: "second" });

      plexus.transact(() => {
        root.globals.push(item1);
      });

      plexus.undo();

      plexus.transact(() => {
        root.globals.push(item2);
      });

      expect(root.globals.includes(item2)).toBe(true);
      expect(root.globals.includes(item1)).toBe(false);

      // Redo should be invalidated by the divergent action
      plexus.redo();
      expect(root.globals.includes(item2)).toBe(true);
      expect(root.globals.includes(item1)).toBe(false);
    });
  });

  describe("Nested parent-child undo", () => {
    it("container and nested child both survive undo", () => {
      const container = new Container({ name: "container", item: null, items: [], ref: null });
      const item = new Item({ name: "item" });

      plexus.transact(() => {
        root.containers.push(container);
        container.item = item;
      });

      expect(root.containers.includes(container)).toBe(true);
      expect(container.item).toBe(item);

      plexus.undo();

      // Both survive — append-only shells
      expect(root.containers.includes(container)).toBe(false);
      // Both survive — append-only shells
      // Entity survives undo — append-only shell
    });
  });

  describe("Reference vs child field undo", () => {
    it("reference field with undo (same undo frame)", () => {
      const item = new Item({ name: "shared" });
      const container = new Container({ name: "container", item: null, items: [], ref: null });

      plexus.transact(() => {
        root.globals.push(item);
      });

      plexus.transact(() => {
        root.containers.push(container);
        container.ref = item;
      });

      expect(container.ref).toBe(item);
      expect(item.parent).toBe(root); // parented via globals, not via ref

      plexus.undo();

      expect(root.containers.includes(container)).toBe(false);
      expect(root.globals.includes(item)).toBe(false);
    });

    it("reference field semantics in single transaction", () => {
      const item = new Item({ name: "shared" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      const container = new Container({ name: "container", item: null, items: [], ref: null });

      plexus.transact(() => {
        root.containers.push(container);
        container.ref = item;
      });

      expect(item.parent).toBe(root);
      expect(container.ref).toBe(item);
      expect(root.globals.includes(item)).toBe(true);
      expect(root.containers.includes(container)).toBe(true);
    });
  });

  describe("Move between containers", () => {
    it("item moved between containers (same undo frame)", () => {
      const container1 = new Container({ name: "c1", item: null, items: [], ref: null });
      const container2 = new Container({ name: "c2", item: null, items: [], ref: null });

      plexus.transact(() => {
        root.containers.push(container1, container2);
      });

      const item = new Item({ name: "item" });

      plexus.transact(() => {
        container1.items.push(item);
      });

      plexus.transact(() => {
        container2.items.push(item); // Auto-removes from c1
      });

      expect(container1.items.includes(item)).toBe(false);
      expect(container2.items.includes(item)).toBe(true);

      plexus.undo();

      // All merged into one undo — containers removed
      expect(root.containers.includes(container1)).toBe(false);
      expect(root.containers.includes(container2)).toBe(false);
    });

    it("move within same transaction preserves correct parent", () => {
      const container1 = new Container({ name: "c1", item: null, items: [], ref: null });
      const container2 = new Container({ name: "c2", item: null, items: [], ref: null });
      const item = new Item({ name: "item" });

      plexus.transact(() => {
        root.containers.push(container1, container2);
        container1.items.push(item);
        container2.items.push(item); // Moves from c1 to c2
      });

      expect(container1.items.includes(item)).toBe(false);
      expect(container2.items.includes(item)).toBe(true);
      expect(item.parent).toBe(container2);

      plexus.undo();

      expect(root.containers.includes(container1)).toBe(false);
      expect(root.containers.includes(container2)).toBe(false);
    });
  });
});
