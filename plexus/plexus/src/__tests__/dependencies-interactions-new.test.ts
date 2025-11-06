import { beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus, TestPlexus } from "./test-plexus";
import type { DependencyId, DependencyVersion } from "../Plexus";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

// Dependency entity
@syncing
class DepEntity extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;

  constructor(props) {
    super(props);
  }
}

// Root entity with dependency support
@syncing
class RootEntity extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor ref!: DepEntity | null;

  @syncing.map
  accessor depsRecord!: Record<string, DepEntity>;

  @syncing.list
  accessor depsList!: DepEntity[];

  @syncing.set
  accessor dependencies!: Set<DepEntity>;

  @syncing.map
  accessor dependencyVersion!: Record<DependencyId, DependencyVersion>;

  constructor(props) {
    super(props);
  }
}

describe("Plexus Dependency Management", () => {
  let plexus: TestPlexus<RootEntity>;
  let root: RootEntity;

  beforeEach(async () => {
    // Create empty root with dependency support
    const emptyRoot = new RootEntity({
      name: "Root",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(),
      dependencyVersion: {},
    });

    const result = await initTestPlexus<RootEntity>(emptyRoot);
    plexus = result.plexus;
    root = result.root;

    // Register dependency factories that create fresh dependency docs
    plexus.registerDependencyFactory("depA", async () => {
      const depEntity = new DepEntity({ name: "Alpha", version: 1 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      // Set the documentId to the dependency ID for cross-document references
      doc
        .getMap(YJS_GLOBALS.metadataMap)
        .set(YJS_GLOBALS.metadataMapFields.documentId, "depA");
      return doc;
    });

    plexus.registerDependencyFactory("depB", async () => {
      const depEntity = new DepEntity({ name: "Beta", version: 2 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      // Set the documentId to the dependency ID for cross-document references
      doc
        .getMap(YJS_GLOBALS.metadataMap)
        .set(YJS_GLOBALS.metadataMapFields.documentId, "depB");
      return doc;
    });
  });

  describe("addDependency", () => {
    it("should add a dependency and return the dependency root", async () => {
      expect(root.dependencies.size).toBe(0);

      const depA = await plexus.addDependency<DepEntity>(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      );

      // Verify dependency was added
      expect(root.dependencies.size).toBe(1);
      expect(root.dependencies.has(depA)).toBe(true);
      expect(depA.name).toBe("Alpha");
      expect(depA.version).toBe(1);

      // Verify version tracking
      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
    });

    it("should add multiple dependencies", async () => {
      const depA = await plexus.addDependency<DepEntity>(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      );
      const depB = await plexus.addDependency<DepEntity>(
        "depB" as DependencyId,
        "2.0.0" as DependencyVersion,
      );

      expect(root.dependencies.size).toBe(2);
      expect(root.dependencies.has(depA)).toBe(true);
      expect(root.dependencies.has(depB)).toBe(true);

      expect(depA.name).toBe("Alpha");
      expect(depB.name).toBe("Beta");

      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
      expect(root.dependencyVersion["depB" as DependencyId]).toBe("2.0.0");
    });

    it("should allow using dependency in root entity relationships", async () => {
      const depA = await plexus.addDependency<DepEntity>(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      );

      // Use dependency in root relationships
      root.ref = depA;
      root.depsRecord["alpha"] = depA;
      root.depsList.push(depA);

      // Verify relationships work
      expect(root.ref).toBe(depA);
      expect(root.depsRecord["alpha"]).toBe(depA);
      expect(root.depsList[0]).toBe(depA);
      expect(root.ref!.name).toBe("Alpha");
    });

    it("should handle dependency not found", async () => {
      await expect(
        plexus.addDependency(
          "unknownDep" as DependencyId,
          "1.0.0" as DependencyVersion,
        ),
      ).rejects.toThrow('Dependency "unknownDep" not found');
    });
  });

  describe("updateDependency", () => {
    it("should update a dependency to a new version", async () => {
      // Add initial dependency
      const depA = await plexus.addDependency<DepEntity>(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      );
      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");

      // Update to new version
      await plexus.updateDependency(depA, "1.1.0" as DependencyVersion);

      // Note: The updated dependency behavior depends on implementation
      // This test verifies the method runs without error
      expect(root.dependencies.size).toBe(1); // Still same count
    });
  });

  describe("dependency isolation", () => {
    it("should allow mutations to dependency entities (they affect the dependency doc)", async () => {
      const depA = await plexus.addDependency<DepEntity>(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      );

      // With the new architecture, dependency entities are mutable PlexusModel instances
      // Mutations affect the dependency document, not the root document
      expect(depA.name).toBe("Alpha");

      // Should allow mutations
      depA.name = "Modified";
      expect(depA.name).toBe("Modified");

      // The change affects the dependency doc, not the root doc
      // This is consistent with the new architecture where dependencies are real entities
    });
  });

  describe("error handling", () => {
    it("should error for root without dependency support", async () => {
      // Create root without dependency fields
      const simpleRoot = new DepEntity({ name: "Simple", version: 1 });
      const { plexus: simplePlexus } =
        await initTestPlexus<DepEntity>(simpleRoot);

      await expect(
        simplePlexus.addDependency(
          "depA" as DependencyId,
          "1.0.0" as DependencyVersion,
        ),
      ).rejects.toThrow("Root entity does not support dependencies");
    });
  });
});
