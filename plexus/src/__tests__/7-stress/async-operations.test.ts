/**
 * Async Operations Edge Cases Test
 *
 * Tests for async modifications and Promise resolution with proxy entities.
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

describe("Async Operations Edge Cases", () => {
  it("should handle async modifications during materialization", async () => {
    const { site } = await createTestSite("Async Test");

    const component = new Component({
      name: "Original",
      type: "component",
      children: [],
      metadata: {},
    });

    // Set up async modification
    const asyncModification = new Promise((resolve) => {
      setTimeout(() => {
        component.name = "Modified Async";
        resolve(void 0);
      }, 1);
    });

    // Trigger materialization
    site.components["test"] = component;

    // Wait for async modification
    await asyncModification;

    // Both sync and async changes should be preserved
    expect(component.name).to.equal("Modified Async");
  });

  it("should handle Promise resolution accessing proxy entities", async () => {
    const { site } = await createTestSite("Promise Test");

    const component = new Component({
      name: "Promise",
      type: "component",
      children: [],
      metadata: {},
    });

    site.components["test"] = component;

    // Promise accessing materialized entity
    await new Promise((resolve) => {
      setTimeout(() => {
        expect(component.name).to.equal("Promise");
        component.metadata["accessed"] = "true";
        resolve(void 0);
      }, 1);
    });

    expect(component.metadata["accessed"]).to.equal("true");
  });
});
