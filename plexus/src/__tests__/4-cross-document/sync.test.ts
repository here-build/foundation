/**
 * Cross-Document Sync Tests
 *
 * Tests for synchronization behavior between documents, including
 * orphaning edge cases when source documents are destroyed.
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
function createTestSite(name: string): { site: Site; entityId: string; doc: Y.Doc } {
  const ephemeralSite = new Site({ name, components: {} });
  const { doc, root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

describe("Cross-Document Orphaning Edge Cases", () => {
  it("should handle references to destroyed documents", () => {
    const { site: site1, doc: doc1 } = createTestSite("Orphaning Test");
    // doc2 shares guid so CRDT-native UUIDs decode correctly on both peers
    const doc2 = new Y.Doc({ guid: doc1.guid });

    const component = new Component({
      name: "Will Be Orphaned",
      type: "component",
      tplTree: null,
      children: [],
      metadata: {},
    });

    site1.components["test"] = component;

    // Sync to doc2
    syncDocs(doc1, doc2);
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const component2 = site2.components["test"];

    // Destroy doc1
    doc1.destroy();

    // component2 should still be accessible and functional
    expect(component2.name).to.equal("Will Be Orphaned");

    // Modifications should still work on surviving document
    component2.name = "Still Alive";

    expect(component2.name).to.equal("Still Alive");
  });
});

describe("Cross-Document Proxy Sync", () => {
  it("should sync bidirectional changes across documents", async () => {
    // Doc1: Setup initial state using Plexus
    const ephemeralSite = new Site({
      name: "Bidirectional Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } = initTestPlexus<Site>(ephemeralSite);
    // doc2 shares guid so CRDT-native UUIDs decode correctly on both peers
    const doc2 = new Y.Doc({ guid: doc1.guid });
    const component1 = new Component({
      name: "Original",
      type: "component",
      tplTree: null,
      children: [],
      metadata: { version: "1.0" },
    });
    expect(component1.metadata["version"]).to.equal("1.0"); // success
    console.log(component1.metadata); // { version: '1.0' }
    site1.components["comp1"] = component1;
    console.log(component1.metadata); // {}
    expect(component1.metadata["version"]).to.equal("1.0"); //fail

    // Initial sync
    syncDocs(doc1, doc2);

    // Doc2: Get reference to same entities using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const component2 = site2.components["comp1"];

    // Doc2: Modify the component
    component2.name = "Modified in Doc2";
    component2.metadata["author"] = "doc2";

    // Sync changes back
    syncDocs(doc1, doc2);

    // Doc1: Verify changes appeared
    expect([component1.name, component1.metadata["author"], component1.metadata["version"]]).to.have.ordered.members([
      "Modified in Doc2",
      "doc2",
      "1.0", // Original data preserved
    ]);

    // Doc1: Make counter-changes
    component1.type = "modified-component";
    component1.metadata["lastModified"] = "doc1";

    // Sync back to doc2
    syncDocs(doc1, doc2);

    // Doc2: Verify bidirectional sync
    expect([
      component2.type,
      component2.metadata["lastModified"],
      component2.metadata["author"],
    ]).to.have.ordered.members([
      "modified-component",
      "doc1",
      "doc2", // Previous changes preserved
    ]);
  });

  it("should sync nested entities properly", async () => {
    // Doc1: Create nested structure using Plexus
    const ephemeralSite2 = new Site({
      name: "Nested Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } = initTestPlexus<Site>(ephemeralSite2);
    const doc2 = new Y.Doc({ guid: doc1.guid });

    const parentComponent = new Component({
      name: "Parent",
      type: "container",
      tplTree: null,
      children: [],
      metadata: {},
    });

    const tplRoot = new TplTag({
      tag: "div",
      name: "Root",
      children: [],
      attrs: { className: "container" },
    });

    const tplChild = new TplTag({
      tag: "span",
      name: "Child",
      children: [],
      attrs: { id: "child-1" },
    });

    // Build nested structure
    parentComponent.tplTree = tplRoot;
    tplRoot.children.push(tplChild);

    site1.components["parent"] = parentComponent; // Trigger contagion for all

    // Verify nested references work in doc1
    expect([
      site1.components["parent"].tplTree?.tag,
      site1.components["parent"].tplTree?.children[0].tag,
      site1.components["parent"].tplTree?.children[0].attrs["id"],
    ]).to.have.ordered.members(["div", "span", "child-1"]);

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access nested structure using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const parent2 = site2.components["parent"];

    // Verify nested structure synced completely
    expect([
      parent2.name,
      parent2.tplTree?.tag,
      parent2.tplTree?.name,
      parent2.tplTree?.attrs["className"],
      parent2.tplTree?.children[0].tag,
      parent2.tplTree?.children[0].name,
      parent2.tplTree?.children[0].attrs["id"],
    ]).to.have.ordered.members(["Parent", "div", "Root", "container", "span", "Child", "child-1"]);
    expect(parent2.tplTree?.children).to.have.lengthOf(1);

    // Doc2: Modify nested structure
    if (parent2.tplTree) {
      parent2.tplTree.children[0].attrs["modified"] = "true";
      parent2.tplTree.attrs["updated"] = "doc2";
    }
    // Sync back
    syncDocs(doc1, doc2);

    // Doc1: Verify nested changes propagated
    expect([
      parentComponent.tplTree!.children[0].attrs["modified"],
      parentComponent.tplTree!.attrs["updated"],
    ]).to.have.ordered.members(["true", "doc2"]);
  });

  it("should sync arrays and primitive collections", async () => {
    // Doc1: Setup component with collections using Plexus
    const ephemeralSite3 = new Site({
      name: "Collections Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } = initTestPlexus<Site>(ephemeralSite3);
    const doc2 = new Y.Doc({ guid: doc1.guid });
    const parent = new Component({
      name: "Parent",
      type: "container",
      tplTree: null,
      children: [],
      metadata: { tags: "react,component" },
    });

    const child1 = new Component({
      name: "Child1",
      type: "child",
      tplTree: null,
      children: [],
      metadata: {},
    });

    const child2 = new Component({
      name: "Child2",
      type: "child",
      tplTree: null,
      children: [],
      metadata: {},
    });

    // Add to collections
    parent.children.push(child1, child2);
    parent.metadata["framework"] = "react";
    parent.metadata["version"] = "18.0";

    console.log("Before materialization:");
    console.log("parent.children.length:", parent.children.length);
    console.log("parent.children[0]:", parent.children[0]?.name);
    console.log("parent.children[1]:", parent.children[1]?.name);

    site1.components["parent"] = parent; // Materialize all

    console.log("After materialization:");
    console.log("parent.children.length:", parent.children.length);
    console.log("parent.children[0]:", parent.children[0]?.name);
    console.log("parent.children[1]:", parent.children[1]?.name);

    // Verify initial state
    expect(parent.children).to.have.lengthOf(2);
    expect([parent.children[0].name, parent.children[1].name, parent.metadata["framework"]]).to.have.ordered.members([
      "Child1",
      "Child2",
      "react",
    ]);

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access collections using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const parent2 = site2.components["parent"];

    // Verify array sync
    expect(parent2.children).to.have.lengthOf(2);
    expect([parent2.children[0].name, parent2.children[1].name]).to.have.ordered.members(["Child1", "Child2"]);

    // Verify map sync
    expect([parent2.metadata["framework"], parent2.metadata["version"]]).to.have.ordered.members(["react", "18.0"]);

    // Doc2: Modify collections (but add child via doc1 due to contagion requirements)
    const child3 = new Component({
      name: "Child3",
      type: "child",
      tplTree: null,
      children: [],
      metadata: {},
    });

    // Add child via doc1 (which has Plexus) but modify metadata via doc2 to test bidirectional sync
    parent.children.push(child3);
    parent2.metadata["newProp"] = "added-in-doc2";
    delete parent2.metadata["tags"];

    // Sync back
    syncDocs(doc1, doc2);

    // Doc1: Verify collection changes
    expect(parent.children).to.have.lengthOf(3);
    expect(parent.children[2].name).to.equal("Child3");
    expect([parent.metadata["newProp"], parent.metadata["tags"], parent.metadata["framework"]]).to.have.ordered.members(
      [
        "added-in-doc2",
        undefined,
        "react", // Preserved
      ],
    );

    // Doc1: Test array methods
    const removed = parent.children.pop();
    expect(removed?.name).to.equal("Child3");
    expect(parent.children).to.have.lengthOf(2);

    // Sync array mutation
    syncDocs(doc1, doc2);
    expect(parent2.children).to.have.lengthOf(2);
    expect([parent2.children[0].name, parent2.children[1].name]).to.have.ordered.members(["Child1", "Child2"]);
  });

  it("should handle entity identity across documents", async () => {
    // Doc1: Create entities with cross-references using Plexus
    const ephemeralSite4 = new Site({
      name: "Identity Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } = initTestPlexus<Site>(ephemeralSite4);
    const doc2 = new Y.Doc({ guid: doc1.guid });

    const comp1 = new Component({
      name: "Component1",
      type: "parent",
      tplTree: null,
      children: [],
      metadata: {},
    });

    const comp2 = new Component({
      name: "Component2",
      type: "child",
      tplTree: null,
      children: [],
      metadata: {},
    });

    // Create cross-reference
    comp1.children.push(comp2);
    site1.components["comp1"] = comp1;
    site1.components["comp2"] = comp2;

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Verify identity relationships using Plexus
    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const comp1_doc2 = site2.components["comp1"];
    const comp2_doc2 = site2.components["comp2"];

    // Verify cross-references work
    expect(comp1_doc2.children[0] === comp2_doc2).to.eq(true); // Same object reference
    expect(comp1_doc2.children[0].name).to.equal("Component2");

    // Modify through reference in doc2
    comp1_doc2.children[0].name = "Modified Child";

    // Verify change appears through both references
    expect(comp2_doc2.name).to.equal("Modified Child");

    // Sync back to doc1
    syncDocs(doc1, doc2);

    // Verify identity preserved in doc1
    expect(comp1.children[0] === comp2).to.eq(true); // Still same reference
    expect([comp2.name, comp1.children[0].name]).to.have.ordered.members(["Modified Child", "Modified Child"]);
  });
});
