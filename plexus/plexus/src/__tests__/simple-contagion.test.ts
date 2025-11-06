/**
 * Minimal test to debug contagion system
 */

import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { isPlexusEntity } from "../index";
import { initTestPlexus } from "./test-plexus";

// Extended Y.Doc type for testing
type TestYDoc = Y.Doc;

// Simple test schema
@syncing
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  constructor(props) {
    super(props);
  }
}

@syncing
class Site extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.map
  accessor components!: Record<string, Component>;

  constructor(props) {
    super(props);
  }
}

describe("Simple Contagion Test", () => {
  let doc: Y.Doc;
  let spawnedSite: Site;

  beforeEach(async () => {
    // Step 1: Create ephemeral site
    const ephemeralSite = new Site({ name: "Test Site", components: {} });

    // Step 2: Initialize with Plexus
    const result = await initTestPlexus<Site>(ephemeralSite);
    doc = result.doc;
    spawnedSite = result.root;

    console.log("1. Created and loaded site via Plexus");
  });

  afterEach(() => {
    doc?.destroy();
  });

  it("should materialize ephemeral entity and allow spawn", () => {
    // Verify initial site state
    expect(spawnedSite.name).toBe("Test Site");

    console.log("2. Verified site loaded correctly");

    // Step 3: Create ephemeral component
    const ephemeralComponent = new Component({ name: "Header" });
    expect(ephemeralComponent.name).toBe("Header");

    console.log("3. Created ephemeral component");

    // Step 4: Trigger contagion by adding to site
    spawnedSite.components["header"] = ephemeralComponent;

    console.log("4. Added component to site");

    // Step 5: Verify component is accessible
    const retrievedComponent = spawnedSite.components["header"];
    console.log("5. Retrieved component:", retrievedComponent);
    console.log("6. Retrieved component name:", retrievedComponent.name);

    expect(retrievedComponent).toBeTruthy();
    expect(retrievedComponent.name).toBe("Header");
  });
});
