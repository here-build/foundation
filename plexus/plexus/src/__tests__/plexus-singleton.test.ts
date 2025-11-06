import { describe, expect, it } from "vitest";
import { TestPlexus, initTestPlexus } from "./test-plexus";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;

  constructor(props) {
    super(props);
  }
}

describe("Plexus singleton per Y.Doc", () => {
  it("allows multiple instances for the same document but shares dependencies", async () => {
    const rootEntity = new Root({ name: "r" });
    const { doc, plexus: plexus1 } = await initTestPlexus<Root>(rootEntity);

    // Second instance should be allowed but will share dependency mappings
    const plexus2 = new TestPlexus<Root>(doc);

    // Both should exist
    expect(plexus1).toBeDefined();
    expect(plexus2).toBeDefined();

    // They are different instances
    expect(plexus1).not.toBe(plexus2);

    // But they share the same doc
    expect(plexus2.doc).toBe(doc);

    // Wait for root to load on second plexus
    const root1 = await plexus1.rootPromise;
    const root2 = await plexus2.rootPromise;

    // Both should return the exact same root entity instance
    expect(root2).toBe(root1);
    expect(root2).toBe(rootEntity);
  });
});
