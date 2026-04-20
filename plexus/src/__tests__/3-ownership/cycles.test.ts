/**
 * Circular References Tests for Plexus Proxy System
 *
 * Tests for handling circular and self-referential structures
 * in the contagious proxy system and cross-document sync.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// Extended Y.Doc type for testing
type TestYDoc = Y.Doc;

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

describe("Circular References", () => {
  let doc1: TestYDoc;
  let doc2: TestYDoc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  it("should handle simple circular references without infinite recursion", async () => {
    const { site } = await createTestSite("Circular Test");

    // Create circular reference: A -> B -> C -> A
    const componentA = new Component({
      name: "A",
      type: "component",
      children: [],
      metadata: {},
    });

    const componentB = new Component({
      name: "B",
      type: "component",
      children: [],
      metadata: {},
    });

    const componentC = new Component({
      name: "C",
      type: "component",
      children: [],
      metadata: {},
    });

    // Build the circle
    componentA.children.push(componentB);
    componentB.children.push(componentC);
    componentC.children.push(componentA); // CIRCULAR!

    // This should materialize all without infinite recursion
    site.components["a"] = componentA;

    // Verify structure integrity and circular identity
    expect([
      site.components["a"].name,
      site.components["a"].children[0].name,
      site.components["a"].children[0].children[0].name,
      site.components["a"].children[0].children[0].children[0].name,
      site.components["a"] === site.components["a"].children[0].children[0].children[0],
    ]).to.have.ordered.members(["A", "B", "C", "A", true]);
  });

  it("should handle self-references correctly", async () => {
    const { site } = await createTestSite("Self-Reference Test");

    const component = new Component({
      name: "Recursive",
      type: "component",
      children: [],
      metadata: {},
    });

    // Self-reference
    component.children.push(component);

    // Materialize
    site.components["recursive"] = component;

    // Verify self-identity is preserved
    expect([
      site.components["recursive"] === site.components["recursive"].children[0],
      site.components["recursive"].name,
      site.components["recursive"].children[0].name,
    ]).to.have.ordered.members([true, "Recursive", "Recursive"]);
  });

  it("should sync circular references across documents", async () => {
    const { site: site1, doc: doc1 } = await createTestSite("Circular Sync Test");
    doc2 = new Y.Doc({ guid: doc1.guid });

    const compA = new Component({ name: "A", type: "component", children: [], metadata: {} });
    const compB = new Component({ name: "B", type: "component", children: [], metadata: {} });

    // Create circular reference
    compA.children.push(compB);
    compB.children.push(compA);

    site1.components["a"] = compA;

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Access from doc2
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const compA2 = site2.components["a"];

    // Verify circular structure and identity preserved across documents
    expect([
      compA2.name,
      compA2.children[0].name,
      compA2.children[0].children[0].name,
      compA2 === compA2.children[0].children[0],
    ]).to.have.ordered.members(["A", "B", "A", true]);
  });
});
