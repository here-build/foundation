/**
 * Resource Exhaustion Edge Cases Test
 *
 * Tests for handling very large collections and deep nesting without crashing.
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

describe("Resource Exhaustion Edge Cases", () => {
  it("should handle very large collections without crashing", async () => {
    const { site } = await createTestSite("Large Collection Test");

    const parent = new Component({
      name: "Large Parent",
      type: "container",
      children: [],
      metadata: {},
    });

    // Create large collection (but not too large to timeout tests)
    const children: Component[] = [];
    for (let i = 0; i < 1000; i++) {
      children.push(
        new Component({
          name: `Child${i}`,
          type: "child",
          children: [],
          metadata: { index: i.toString() },
        }),
      );
    }

    parent.children.push(...children);
    site.components["large"] = parent; // Materialize everything

    expect(parent.children).to.have.lengthOf(1000);
    expect(parent.children[0].name).to.equal("Child0");
    expect(parent.children[999].name).to.equal("Child999");
  });

  it("should handle deep nesting without stack overflow", async () => {
    const { site } = await createTestSite("Deep Nesting Test");

    // Create deep nesting chain (100 levels)
    let current = new Component({
      name: "Root",
      type: "component",
      children: [],
      metadata: {},
    });

    const root = current;

    for (let i = 1; i < 100; i++) {
      const child = new Component({
        name: `Level${i}`,
        type: "component",
        children: [],
        metadata: {},
      });
      current.children.push(child);
      current = child;
    }

    site.components["deep"] = root; // Materialize deep structure

    // Verify deep access works
    let node = site.components["deep"];
    for (let i = 1; i < 100; i++) {
      expect(node.children[0].name).to.equal(`Level${i}`);
      node = node.children[0];
    }
  });
});
