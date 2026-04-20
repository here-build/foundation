/**
 * Tests for concurrent mutation races across documents.
 *
 * These tests verify that the Plexus system handles concurrent modifications
 * from multiple documents correctly, with proper CRDT convergence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

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

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// Helper to create materialized site as root
async function createTestSite(name: string): Promise<{ site: Site; entityId: string; doc: Y.Doc }> {
  const ephemeralSite = new Site({ name, components: {} });
  const { doc, root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

describe("Concurrent Mutation Races", () => {
  it("should handle concurrent cross-document mutations", async () => {
    const { site: site1, doc: doc1 } = await createTestSite("Race Test");
    // doc2 shares guid so CRDT-native UUIDs decode correctly on both peers
    const doc2 = new Y.Doc({ guid: doc1.guid });
    const comp1 = new Component({
      name: "Original",
      type: "component",
      children: [],
      metadata: {},
    });
    site1.components["shared"] = comp1;

    // Initial sync
    syncDocs(doc1, doc2);

    // Set up doc2 properly using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);

    const comp1_doc1 = site1.components["shared"];
    const comp1_doc2 = site2.components["shared"];

    // Concurrent mutations on primitive fields
    comp1_doc1.name = "Modified by Doc1";
    comp1_doc1.metadata["source"] = "doc1";

    comp1_doc2.name = "Modified by Doc2";
    comp1_doc2.metadata["source"] = "doc2";

    // Add children only from doc1 (the one with Plexus) to avoid contagion issues
    const child1 = new Component({
      name: "Child1",
      type: "child",
      children: [],
      metadata: {},
    });
    const child2 = new Component({
      name: "Child2",
      type: "child",
      children: [],
      metadata: {},
    });

    comp1_doc1.children.push(child1, child2);

    // Sync and verify state consistency
    syncDocs(doc1, doc2);

    // Both documents should have the children now
    expect([comp1_doc1.children.length, comp1_doc2.children.length]).to.have.ordered.members([2, 2]);

    // Names may be resolved by CRDT (last write wins or merge)
    expect(comp1_doc1.name).to.equal(comp1_doc2.name); // Should be identical after sync

    // Verify children are present in both
    const childNames1 = comp1_doc1.children.map((c) => c.name).sort();
    const childNames2 = comp1_doc2.children.map((c) => c.name).sort();
    expect([childNames1, childNames2]).to.deep.equal([
      ["Child1", "Child2"],
      ["Child1", "Child2"],
    ]);
  });
});
