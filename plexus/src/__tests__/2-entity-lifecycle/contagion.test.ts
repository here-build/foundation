/**
 * Contagion (Auto-materialization) Tests
 *
 * Tests the contagion mechanism where ephemeral entities automatically
 * become materialized when attached to materialized entities.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// Test schema definitions
@syncing("TplTag")
class TplTag extends PlexusModel {
  @syncing
  accessor tag!: string;

  @syncing
  accessor name!: string;

  @syncing.list
  accessor children!: TplTag[];

  @syncing.record
  accessor attrs!: Record<string, string>;
}

@syncing("Component")
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor type!: string;

  @syncing
  accessor tplTree!: TplTag | null;

  @syncing.list
  accessor children!: Component[];

  @syncing.record
  accessor metadata!: Record<string, string>;
}

@syncing("Site")
class Site extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.record
  accessor components!: Record<string, Component>;
}

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);

  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("Contagion (Auto-materialization)", () => {
  let doc1: Y.Doc;
  let doc2: Y.Doc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  it("should sync ephemeral entity contagion across documents", () => {
    // Doc1: Create materialized site as root using Plexus
    const ephemeralSite = new Site({ name: "Test Site", components: {} });
    const { doc: testDoc1, root: site1 } = initTestPlexus<Site>(ephemeralSite);
    doc1 = testDoc1;
    doc2 = new Y.Doc({ guid: doc1.guid });

    // Create ephemeral component
    const ephemeralComponent = new Component({
      name: "Header",
      type: "component",
      tplTree: null,
      children: [],
      metadata: {},
    });

    // Verify ephemeral state
    expect(ephemeralComponent.name).to.equal("Header");

    // Trigger contagion by adding to materialized entity
    site1.components["header"] = ephemeralComponent;

    // Verify materialization happened - component should now reference YJS
    expect(site1.components["header"]).to.equal(ephemeralComponent); // Same object reference
    expect(site1.components["header"].name).to.equal("Header");

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access the same entities (after root was synced) using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const component2 = site2.components["header"];

    // Verify sync worked
    expect([component2, component2.name, component2.type]).to.have.ordered.members([component2, "Header", "component"]);
  });
});
