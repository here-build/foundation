/**
 * Garbage Collection Edge Cases Test
 *
 * Tests for WeakRef cleanup and GC behavior during Plexus operations.
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// Test schema definitions
@syncing("Component")
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor type!: string;

  @syncing.list
  accessor children: Component[] = [];

  @syncing.record
  accessor metadata: Record<string, string> = {};
}

@syncing("Site")
class Site extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.record
  accessor components!: Record<string, Component>;
}

// Helper to create materialized site as root
async function createTestSite(name: string): Promise<{ site: Site; entityId: string }> {
  const ephemeralSite = new Site({ name, components: {} });
  const { root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid };
}

describe("Garbage Collection Edge Cases", () => {
  it("should handle WeakRef cleanup during operations", async () => {
    const { site } = await createTestSite("GC Test");

    // Create many entities to stress the cache system
    const entities: any[] = [];
    for (let i = 0; i < 100; i++) {
      entities.push(
        new Component({
          name: `Entity${i}`,
          type: "component",
          children: [],
          metadata: {},
        }),
      );
    }

    const parent = new Component({
      name: "Parent",
      type: "container",
      children: entities,
      metadata: {},
    });

    // Materialize everything
    site.components["parent"] = parent;

    // Clear references to force potential GC
    entities.length = 0;

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Verify entities are still accessible through parent
    expect(site.components["parent"].children).to.have.lengthOf(100);
    expect(site.components["parent"].children[0].name).to.equal("Entity0");
    expect(site.components["parent"].children[99].name).to.equal("Entity99");

    // Verify we can still perform operations
    site.components["parent"].children.push(
      new Component({ name: "NewEntity", type: "component", children: [], metadata: {} }),
    );

    expect(site.components["parent"].children).to.have.lengthOf(101);
    expect(site.components["parent"].children[100].name).to.equal("NewEntity");
  });
});
