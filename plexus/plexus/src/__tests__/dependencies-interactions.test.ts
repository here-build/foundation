import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus } from "./test-plexus";
import type { DependencyId, DependencyVersion } from "../Plexus";

// Dependency entity (no collections to avoid resolver shape issues)
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

// Root entity holds references to dependency entities and manages dependency versions
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

describe("Dependencies Interactions with Plexus", () => {
  let depA: Y.Doc;
  let depB: Y.Doc;
  let rootDoc: Y.Doc;
  let root: RootEntity;

  let depAEntityId: string;
  let depBEntityId: string;
  let depAEntity: DepEntity;
  let depBEntity: DepEntity;

  beforeEach(async () => {
    // Initialize dependency docs with their entities as roots
    const depAEntity_temp = new DepEntity({ name: "Alpha", version: 1 });
    const depBEntity_temp = new DepEntity({ name: "Beta", version: 2 });

    const { doc: depADoc, root: depARoot } = await initTestPlexus<DepEntity>(
      depAEntity_temp,
      {},
      "depA",
    );
    const { doc: depBDoc, root: depBRoot } = await initTestPlexus<DepEntity>(
      depBEntity_temp,
      {},
      "depB",
    );

    depA = depADoc;
    depB = depBDoc;
    depAEntity = depARoot;
    depBEntity = depBRoot;
    depAEntityId = depAEntity.uuid;
    depBEntityId = depBEntity.uuid;

    // Create root with basic structure (empty dependencies initially)
    const testRoot = new RootEntity({
      name: "Root",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(), // Start empty - will use addDependency()
      dependencyVersion: {}, // Start empty - will be populated via addDependency()
    });

    // Initialize main doc with root and dependencies
    const { plexus, root: loadedRoot } =
      await initTestPlexus<RootEntity>(testRoot);
    rootDoc = plexus.doc;
    root = loadedRoot;

    // Register dependency factories for this test
    (plexus as any).registerDependencyFactory("depA", async () => depA);
    (plexus as any).registerDependencyFactory("depB", async () => depB);

    // Now explicitly add dependencies using the new API
    await plexus.addDependency(
      "depA" as DependencyId,
      "1.0.0" as DependencyVersion,
    );
    await plexus.addDependency(
      "depB" as DependencyId,
      "2.0.0" as DependencyVersion,
    );
  });

  it("should automatically resolve and track dependency entities", () => {
    // Verify dependencies are available through root
    expect(root.dependencies.size).toBe(2);
    const deps = Array.from(root.dependencies);
    expect(deps.some((dep) => dep.name === "Alpha")).toBe(true);
    expect(deps.some((dep) => dep.name === "Beta")).toBe(true);

    // Verify dependency versions are tracked
    expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
    expect(root.dependencyVersion["depB" as DependencyId]).toBe("2.0.0");
  });

  it("stores tuple refs when writing dependency entities to root", () => {
    // Get dependency references from Set
    const deps = Array.from(root.dependencies);
    const depAObj = deps.find((dep) => dep.name === "Alpha")!;
    const depBObj = deps.find((dep) => dep.name === "Beta")!;

    // Write into root collections
    root.ref = depAObj;
    root.depsRecord["a"] = depAObj;
    root.depsList.push(depBObj);

    // Inspect Y storage in root - dependency references should be stored as tuples
    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;

    expect(rootFields.get("ref")).toEqual([depAEntityId, "depA"]);
    expect(rootFields.get("depsRecord").get("a")).toEqual([
      depAEntityId,
      "depA",
    ]);
    expect(rootFields.get("depsList").get(0)).toEqual([depBEntityId, "depB"]);
  });

  it("supports multiple dependencies in the same root", () => {
    // Get dependencies from Set
    const deps = Array.from(root.dependencies);
    const a = deps.find((dep) => dep.name === "Alpha")!;
    const b = deps.find((dep) => dep.name === "Beta")!;

    root.depsList.push(a, b);

    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;
    const arr = rootFields.get("depsList") as Y.Array<any>;

    expect(arr.get(0)).toEqual([depAEntityId, "depA"]);
    expect(arr.get(1)).toEqual([depBEntityId, "depB"]);
  });

  it("throws when dependency is not provided to Plexus", async () => {
    // Create a fresh root with empty dependencies
    const failRoot = new RootEntity({
      name: "FailRoot",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(),
      dependencyVersion: {},
    });

    // Create fresh plexus without registering all dependencies
    const { plexus: freshPlexus } = await initTestPlexus<RootEntity>(failRoot);

    // Only register depA, not depB
    (freshPlexus as any).registerDependencyFactory("depA", async () => depA);
    // depB is intentionally missing

    // Should succeed for depA
    await expect(
      freshPlexus.addDependency(
        "depA" as DependencyId,
        "1.0.0" as DependencyVersion,
      ),
    ).resolves.toBeDefined();

    // Should fail for missing depB
    await expect(
      freshPlexus.addDependency(
        "depB" as DependencyId,
        "2.0.0" as DependencyVersion,
      ),
    ).rejects.toThrow('Dependency "depB" not found');
  });
});
