import { beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus, TestPlexus } from "./test-plexus";
import type { DependencyId, DependencyVersion } from "../Plexus";

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

@syncing
class RootEntity extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.set
  accessor dependencies!: Set<DepEntity>;

  @syncing.map
  accessor dependencyVersion!: Record<DependencyId, DependencyVersion>;

  constructor(props) {
    super(props);
  }
}

const waitTick = () => new Promise((r) => setTimeout(r, 0));

describe("Plexus dependency resolution paths", () => {
  let plexus: TestPlexus<RootEntity>;
  let root: RootEntity;

  beforeEach(async () => {
    const emptyRoot = new RootEntity({
      name: "Root",
      dependencies: new Set(),
      dependencyVersion: {},
    });
    const result = await initTestPlexus<RootEntity>(emptyRoot);
    plexus = result.plexus as TestPlexus<RootEntity>;
    root = result.root;
  });

  it("addDependency uses registered factory once and caches by id", async () => {
    let depAFetches = 0;

    plexus.registerDependencyFactory("depA", async () => {
      depAFetches++;
      const depEntity = new DepEntity({ name: "Alpha", version: 1 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      return doc;
    });

    const depA1 = await plexus.addDependency<DepEntity>(
      "depA" as DependencyId,
      "1.0.0" as DependencyVersion,
    );
    expect(root.dependencies.has(depA1)).toBe(true);
    expect(depAFetches).toBe(1);

    // Second add with same id should reuse cached doc
    const depA2 = await plexus.addDependency<DepEntity>(
      "depA" as DependencyId,
      "1.0.0" as DependencyVersion,
    );
    expect(root.dependencies.has(depA2)).toBe(true);
    expect(depAFetches).toBe(1);
  });

  it("updateDependency is a no-op when version is unchanged", async () => {
    let depAFetches = 0;

    plexus.registerDependencyFactory("depA", async () => {
      depAFetches++;
      const depEntity = new DepEntity({ name: "Alpha", version: 1 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      return doc;
    });

    const dep = await plexus.addDependency<DepEntity>(
      "depA" as DependencyId,
      "1.0.0" as DependencyVersion,
    );
    expect(root.dependencies.has(dep)).toBe(true);
    expect(depAFetches).toBe(1);

    // Same version: should not fetch again
    await plexus.updateDependency(dep, "1.0.0" as DependencyVersion);
    expect(depAFetches).toBe(1);

    // New version: in TestPlexus stub, fetchDependency caches by id,
    // so updateDependency should not increase factory calls.
    await plexus.updateDependency(dep, "1.1.0" as DependencyVersion);
    expect(depAFetches).toBe(1);
  });
});
