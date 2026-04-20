/**
 * Tests for dependency system - loading external packages as read-only snapshots.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("Container")
class Container extends PlexusModel {
  @syncing accessor name: string = "";

  @syncing.child accessor item: Item | null = null;

  @syncing.child.list accessor items: Item[] = [];
}

/** A container that holds a REFERENCE (not child) to an Item — can point cross-doc */
@syncing("RefHolder")
class RefHolder extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor ref: Item | null = null;
  @syncing.list accessor refs: Item[] = [];
}

@syncing("Root")
class Root extends PlexusModel<null> {
  dependencies?: Record<string, Root>;

  @syncing.child.list accessor containers: Container[] = [];

  @syncing.child.list accessor items: Item[] = [];

  @syncing.child.list accessor holders: RefHolder[] = [];
}

function createDependencyDoc(
  documentId: string,
  setup: (plexus: ReturnType<typeof initTestPlexus<Root>>) => void,
  existingDeps?: Record<string, Uint8Array>,
) {
  const { doc, plexus, root } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }), {}, documentId);

  // Load any pre-existing dependencies this package needs
  if (existingDeps) {
    for (const [depId, depVector] of Object.entries(existingDeps)) {
      plexus.addDependency(depId, depVector);
    }
  }

  plexus.transact(() => {
    setup({ doc, plexus, root });
  });

  return [documentId, Y.encodeStateAsUpdate(doc)] as const;
}

describe("Dependency system", () => {
  describe("Basic dependency loading", () => {
    it("should load a simple dependency with flat items", () => {
      const [depId, depVector] = createDependencyDoc("pkg-1", ({ root }) => {
        root.items.push(new Item({ name: "item-a" }));
        root.items.push(new Item({ name: "item-b" }));
      });

      const { plexus, root } = initTestPlexus(new Root({ containers: [], items: [] }));

      const depRoot = plexus.addDependency(depId, depVector);

      expect(depRoot).to.not.eq(undefined);
      expect(depRoot.items).to.have.lengthOf(2);
      expect([depRoot.items[0].name, depRoot.items[1].name]).to.have.ordered.members(["item-a", "item-b"]);
    });

    it("should make dependency models read-only", () => {
      const [depId, depVector] = createDependencyDoc("pkg-2", ({ root }) => {
        root.items.push(new Item({ name: "original" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      // Dependency models should be read-only
      const item = depRoot.items[0];
      expect(item.name).to.equal("original");

      // Writing to dependency models should throw
      expect(() => {
        (item as any).name = "modified";
      }).to.throw("dependencies are handled via special flow");

      expect(item.name).to.equal("original"); // Value unchanged
    });

    it("should mark dependency models with isDependency flag", () => {
      const [depId, depVector] = createDependencyDoc("pkg-3", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      expect([getInternals(depRoot).isDependency, getInternals(depRoot.items[0]).isDependency]).to.have.ordered.members(
        [true, true],
      );
    });

    it("should prevent adding duplicate dependencies", () => {
      const [depId, depVector] = createDependencyDoc("pkg-dup", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId, depVector);

      expect(() => plexus.addDependency(depId, depVector)).to.throw("already exists");
    });
  });

  describe("Nested dependencies", () => {
    it("should resolve parent-child relationships within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-nested", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        const item = new Item({ name: "child" });
        container.item = item;
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      expect(depRoot.containers).to.have.lengthOf(1);
      const container = depRoot.containers[0];
      expect(container.name).to.equal("parent");
      expect(container.item).to.not.eq(null);
      expect(container.item!.name).to.equal("child");
    });

    it("should resolve child lists within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-list", ({ root }) => {
        const container = new Container({ name: "holder", item: null, items: [] });
        container.items.push(new Item({ name: "first" }));
        container.items.push(new Item({ name: "second" }));
        container.items.push(new Item({ name: "third" }));
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const container = depRoot.containers[0];
      expect(container.items).to.have.lengthOf(3);
      expect([container.items[0].name, container.items[1].name, container.items[2].name]).to.have.ordered.members([
        "first",
        "second",
        "third",
      ]);
    });

    it("should track parent references within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-parent", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        container.item = new Item({ name: "child" });
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const container = depRoot.containers[0];
      const item = container.item!;

      // Parent tracking should work within dependency
      expect([item.parent === container, container.parent === depRoot]).to.have.ordered.members([true, true]);
    });

    it("should handle deeply nested structures", () => {
      const [depId, depVector] = createDependencyDoc("pkg-deep", ({ root }) => {
        const outer = new Container({ name: "outer", item: null, items: [] });
        // Note: Container can't nest Containers in this schema, so we test with items
        outer.items.push(new Item({ name: "deep-1" }));
        outer.items.push(new Item({ name: "deep-2" }));
        outer.item = new Item({ name: "single-child" });
        root.containers.push(outer);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const outer = depRoot.containers[0];
      expect([outer.name, outer.item!.name, outer.items[0].name, outer.items[1].name]).to.have.ordered.members([
        "outer",
        "single-child",
        "deep-1",
        "deep-2",
      ]);
    });
  });

  describe("rootDependenciesRepresentation", () => {
    it("should expose dependencies via proxy", () => {
      const [depId1, depVector1] = createDependencyDoc("dep-a", ({ root }) => {
        root.items.push(new Item({ name: "from-a" }));
      });
      const [depId2, depVector2] = createDependencyDoc("dep-b", ({ root }) => {
        root.items.push(new Item({ name: "from-b" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId1, depVector1);
      plexus.addDependency(depId2, depVector2);

      const deps = plexus.rootDependenciesRepresentation;

      expect(deps["dep-a"]).to.not.eq(undefined);
      expect(deps["dep-b"]).to.not.eq(undefined);
      expect([deps["dep-a"].items[0].name, deps["dep-b"].items[0].name]).to.have.ordered.members(["from-a", "from-b"]);
    });

    it("should list dependency keys via ownKeys", () => {
      const [depId1, depVector1] = createDependencyDoc("pkg-x", ({ root }) => {
        root.items.push(new Item({ name: "x" }));
      });
      const [depId2, depVector2] = createDependencyDoc("pkg-y", ({ root }) => {
        root.items.push(new Item({ name: "y" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId1, depVector1);
      plexus.addDependency(depId2, depVector2);

      const keys = Reflect.ownKeys(plexus.rootDependenciesRepresentation);
      expect(keys).to.include("pkg-x").and.include("pkg-y");
    });
  });

  describe("getDependencyNode", () => {
    it("should retrieve specific nodes by id", () => {
      const [depId, depVector] = createDependencyDoc("pkg-get", ({ root }) => {
        root.items.push(new Item({ name: "findme" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      // Get the item's uuid from the dependency
      const item = depRoot.items[0];
      const itemUuid = getInternals(item).uuid!;

      // Should be able to retrieve via getDependencyNode
      const retrieved = plexus.getDependencyEntity("pkg-get", itemUuid);
      expect(retrieved === item).to.eq(true); // Same cached instance
    });

    it("should throw for unknown dependency", () => {
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));

      expect(() => plexus.getDependencyEntity("unknown-pkg", "some-uuid")).to.throw("not loaded");
    });
  });

  describe("Transitive dependencies (deps-of-deps)", () => {
    it("should resolve cross-doc references when both deps are loaded flat", () => {
      // Package B: has an item
      const [depBId, depBVector] = createDependencyDoc("pkg-B", ({ root }) => {
        root.items.push(new Item({ name: "shared-token" }));
      });

      // Package A: depends on B, holds a reference to B's item
      const [depAId, depAVector] = createDependencyDoc(
        "pkg-A",
        ({ plexus, root }) => {
          // Get B's item via the loaded dependency
          const depBRoot = plexus.rootDependenciesRepresentation["pkg-B"];
          const bItem = depBRoot.items[0];

          // Create a holder in A that references B's item
          const holder = new RefHolder({ name: "uses-b-token", ref: null, refs: [] });
          holder.ref = bItem as Item;
          root.holders.push(holder);
        },
        { "pkg-B": depBVector },
      );

      // Our project: load both A and B as flat dependencies
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      plexus.addDependency(depBId, depBVector);
      plexus.addDependency(depAId, depAVector);

      const depARoot = plexus.rootDependenciesRepresentation["pkg-A"];
      const depBRoot = plexus.rootDependenciesRepresentation["pkg-B"];

      // A's holder should reference B's item
      const holder = depARoot.holders[0];
      expect(holder.name).to.equal("uses-b-token");
      expect(holder.ref).to.not.eq(null);
      expect(holder.ref!.name).to.equal("shared-token");

      // The resolved item should be the same instance as B's item
      expect(holder.ref === depBRoot.items[0]).to.eq(true);
    });

    it("should fail gracefully when transitive dep is not loaded", () => {
      // Package B: has an item
      const [depBId, depBVector] = createDependencyDoc("pkg-B-missing", ({ root }) => {
        root.items.push(new Item({ name: "orphan-token" }));
      });

      // Package A: depends on B
      const [depAId, depAVector] = createDependencyDoc(
        "pkg-A-missing",
        ({ plexus, root }) => {
          const depBRoot = plexus.rootDependenciesRepresentation["pkg-B-missing"];
          const holder = new RefHolder({ name: "broken-ref", ref: null, refs: [] });
          holder.ref = depBRoot.items[0] as Item;
          root.holders.push(holder);
        },
        { "pkg-B-missing": depBVector },
      );

      // Our project: load A but NOT B
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      plexus.addDependency(depAId, depAVector);

      const depARoot = plexus.rootDependenciesRepresentation["pkg-A-missing"];
      const holder = depARoot.holders[0];

      // Accessing the cross-doc reference should throw because B is not loaded
      expect(() => holder.ref).to.throw("not loaded");
    });
  });

  describe("replaceDependency", () => {
    it("should replace blob and resolve new entities", () => {
      const [depId, depVector1] = createDependencyDoc("pkg-replace", ({ root }) => {
        root.items.push(new Item({ name: "v1-item" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      const v1Root = plexus.addDependency(depId, depVector1);
      expect(v1Root.items[0].name).to.equal("v1-item");

      // Create v2 with different content
      const [, depVector2] = createDependencyDoc("pkg-replace", ({ root }) => {
        root.items.push(new Item({ name: "v2-item" }));
        root.items.push(new Item({ name: "v2-extra" }));
      });

      const v2Root = plexus.replaceDependency(depId, depVector2);
      expect(v2Root.items).to.have.lengthOf(2);
      expect(v2Root.items[0].name).to.equal("v2-item");
      expect(v2Root.items[1].name).to.equal("v2-extra");
    });

    it("should invalidate cache — old instances no longer returned", () => {
      const [depId, depVector1] = createDependencyDoc("pkg-cache-inv", ({ root }) => {
        root.items.push(new Item({ name: "original" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      const v1Root = plexus.addDependency(depId, depVector1);
      const oldItem = v1Root.items[0];
      expect(oldItem.name).to.equal("original");

      const [, depVector2] = createDependencyDoc("pkg-cache-inv", ({ root }) => {
        root.items.push(new Item({ name: "replaced" }));
      });

      const v2Root = plexus.replaceDependency(depId, depVector2);
      // New root is a different instance
      expect(v2Root).to.not.eq(v1Root);
      expect(v2Root.items[0].name).to.equal("replaced");
    });

    it("should throw for non-existent dependency", () => {
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      expect(() => plexus.replaceDependency("nonexistent", new Uint8Array())).to.throw("not found");
    });
  });

  describe("removeDependency", () => {
    it("should remove dependency and make references dangling", () => {
      const [depId, depVector] = createDependencyDoc("pkg-remove", ({ root }) => {
        root.items.push(new Item({ name: "doomed" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      plexus.addDependency(depId, depVector);

      const deps = plexus.rootDependenciesRepresentation;
      expect(deps["pkg-remove"]).to.not.eq(undefined);

      plexus.removeDependency(depId);

      // Dependency no longer accessible
      expect(deps["pkg-remove"]).to.eq(undefined);
      expect(() => plexus.getDependencyEntity(depId, "any-uuid")).to.throw("not loaded");
    });

    it("should throw for non-existent dependency", () => {
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      expect(() => plexus.removeDependency("nonexistent")).to.throw("not found");
    });
  });

  describe("Multiple dependencies", () => {
    it("should load and resolve across A, B, C independently", () => {
      const [idA, vecA] = createDependencyDoc("pkg-multi-A", ({ root }) => {
        root.items.push(new Item({ name: "from-A" }));
      });
      const [idB, vecB] = createDependencyDoc("pkg-multi-B", ({ root }) => {
        root.items.push(new Item({ name: "from-B" }));
      });
      const [idC, vecC] = createDependencyDoc("pkg-multi-C", ({ root }) => {
        root.items.push(new Item({ name: "from-C" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      plexus.addDependency(idA, vecA);
      plexus.addDependency(idB, vecB);
      plexus.addDependency(idC, vecC);

      const deps = plexus.rootDependenciesRepresentation;
      expect(deps["pkg-multi-A"].items[0].name).to.equal("from-A");
      expect(deps["pkg-multi-B"].items[0].name).to.equal("from-B");
      expect(deps["pkg-multi-C"].items[0].name).to.equal("from-C");
    });
  });

  describe("Blob format", () => {
    it("should round-trip: createBlobFromDoc → decodeBlob → entities match", () => {
      const [depId, depVector] = createDependencyDoc("pkg-roundtrip", ({ root }) => {
        root.items.push(new Item({ name: "alpha" }));
        root.items.push(new Item({ name: "beta" }));
        const container = new Container({ name: "wrapper", item: null, items: [] });
        container.item = new Item({ name: "nested" });
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [], holders: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      // Verify all entities materialized correctly from the blob
      expect(depRoot.items).to.have.lengthOf(2);
      expect(depRoot.items[0].name).to.equal("alpha");
      expect(depRoot.items[1].name).to.equal("beta");
      expect(depRoot.containers).to.have.lengthOf(1);
      expect(depRoot.containers[0].name).to.equal("wrapper");
      expect(depRoot.containers[0].item!.name).to.equal("nested");
    });
  });
});
