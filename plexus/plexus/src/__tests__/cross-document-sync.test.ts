/**
 * Cross-Document Sync Tests for Contagious Proxy System
 *
 * Tests that ephemeral entities properly materialize and sync across multiple Y.Docs
 * using explicit sync() calls rather than live event handlers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { isPlexusEntity } from "../index";
import { primeDoc } from "./test-helpers";
import { createTestPlexus, initTestPlexus } from "./test-plexus";

// Test schema definitions
@syncing
class TplTag extends PlexusModel {
  @syncing
  accessor tag!: string;

  @syncing
  accessor name!: string;

  @syncing.list
  accessor children!: TplTag[];

  @syncing.map
  accessor attrs!: Record<string, string>;
}

@syncing
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor type!: string;

  @syncing
  accessor tplTree!: TplTag | null;

  @syncing.list
  accessor children!: Component[];

  @syncing.map
  accessor metadata!: Record<string, string>;

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

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);

  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("Cross-Document Proxy Sync", () => {
  let doc1: Y.Doc;
  let doc2: Y.Doc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
    primeDoc(doc1);
    primeDoc(doc2);
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  it("should sync ephemeral entity contagion across documents", async () => {
    // Doc1: Create materialized site as root using Plexus
    const ephemeralSite = new Site({ name: "Test Site", components: {} });
    const { doc: doc1, root: site1 } =
      await initTestPlexus<Site>(ephemeralSite);

    // Create ephemeral component
    const ephemeralComponent = new Component({
      name: "Header",
      type: "component",
      tplTree: null,
      children: [],
      metadata: {},
    });

    // Verify ephemeral state
    expect(ephemeralComponent.name).toBe("Header");

    // Trigger contagion by adding to materialized entity
    site1.components["header"] = ephemeralComponent;

    // Verify materialization happened - component should now reference YJS
    expect(site1.components["header"]).toBe(ephemeralComponent); // Same object reference
    expect(site1.components["header"].name).toBe("Header");

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access the same entities (after root was synced) using Plexus
    const { root: site2 } = await createTestPlexus<Site>(doc2);
    const component2 = site2.components["header"];

    // Verify sync worked
    expect(component2).toBeTruthy();
    expect(component2.name).toBe("Header");
    expect(component2.type).toBe("component");
  });

  it("should sync bidirectional changes across documents", async () => {
    // Doc1: Setup initial state using Plexus
    const ephemeralSite = new Site({
      name: "Bidirectional Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } =
      await initTestPlexus<Site>(ephemeralSite);
    const component1 = new Component({
      name: "Original",
      type: "component",
      tplTree: null,
      children: [],
      metadata: { version: "1.0" },
    });
    expect(component1.metadata["version"]).toBe("1.0"); // success
    console.log(component1.metadata); // { version: '1.0' }
    site1.components["comp1"] = component1;
    console.log(component1.metadata); // {}
    expect(component1.metadata["version"]).toBe("1.0"); //fail

    // Initial sync
    syncDocs(doc1, doc2);

    // Doc2: Get reference to same entities using Plexus
    const { root: site2 } = await createTestPlexus<Site>(doc2);
    const component2 = site2.components["comp1"];

    // Doc2: Modify the component
    component2.name = "Modified in Doc2";
    component2.metadata["author"] = "doc2";

    // Sync changes back
    syncDocs(doc1, doc2);

    // Doc1: Verify changes appeared
    expect(component1.name).toBe("Modified in Doc2");
    expect(component1.metadata["author"]).toBe("doc2");
    expect(component1.metadata["version"]).toBe("1.0"); // Original data preserved

    // Doc1: Make counter-changes
    component1.type = "modified-component";
    component1.metadata["lastModified"] = "doc1";

    // Sync back to doc2
    syncDocs(doc1, doc2);

    // Doc2: Verify bidirectional sync
    expect(component2.type).toBe("modified-component");
    expect(component2.metadata["lastModified"]).toBe("doc1");
    expect(component2.metadata["author"]).toBe("doc2"); // Previous changes preserved
  });

  it("should sync nested entities properly", async () => {
    // Doc1: Create nested structure using Plexus
    const ephemeralSite2 = new Site({
      name: "Nested Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } =
      await initTestPlexus<Site>(ephemeralSite2);

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
    expect(site1.components["parent"].tplTree?.tag).toBe("div");
    expect(site1.components["parent"].tplTree?.children[0].tag).toBe("span");
    expect(site1.components["parent"].tplTree?.children[0].attrs["id"]).toBe(
      "child-1",
    );

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access nested structure using Plexus
    const { root: site2 } = await createTestPlexus<Site>(doc2);
    const parent2 = site2.components["parent"];

    // Verify nested structure synced completely
    expect(parent2.name).toBe("Parent");
    expect(parent2.tplTree?.tag).toBe("div");
    expect(parent2.tplTree?.name).toBe("Root");
    expect(parent2.tplTree?.attrs["className"]).toBe("container");
    expect(parent2.tplTree?.children).toHaveLength(1);
    expect(parent2.tplTree?.children[0].tag).toBe("span");
    expect(parent2.tplTree?.children[0].name).toBe("Child");
    expect(parent2.tplTree?.children[0].attrs["id"]).toBe("child-1");

    // Doc2: Modify nested structure
    if (parent2.tplTree) {
      parent2.tplTree.children[0].attrs["modified"] = "true";
      parent2.tplTree.attrs["updated"] = "doc2";
    }
    // Sync back
    syncDocs(doc1, doc2);

    // Doc1: Verify nested changes propagated
    expect(parentComponent.tplTree.children[0].attrs["modified"]).toBe("true");
    expect(parentComponent.tplTree.attrs["updated"]).toBe("doc2");
  });

  it("should sync arrays and primitive collections", async () => {
    // Doc1: Setup component with collections using Plexus
    const ephemeralSite3 = new Site({
      name: "Collections Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } =
      await initTestPlexus<Site>(ephemeralSite3);
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
    expect(parent.children).toHaveLength(2);
    expect(parent.children[0].name).toBe("Child1");
    expect(parent.children[1].name).toBe("Child2");
    expect(parent.metadata["framework"]).toBe("react");

    // Sync to doc2
    syncDocs(doc1, doc2);

    // Doc2: Access collections using Plexus
    const { root: site2 } = await createTestPlexus<Site>(doc2);
    const parent2 = site2.components["parent"];

    // Verify array sync
    expect(parent2.children).toHaveLength(2);
    expect(parent2.children[0].name).toBe("Child1");
    expect(parent2.children[1].name).toBe("Child2");

    // Verify map sync
    expect(parent2.metadata["framework"]).toBe("react");
    expect(parent2.metadata["version"]).toBe("18.0");

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
    expect(parent.children).toHaveLength(3);
    expect(parent.children[2].name).toBe("Child3");
    expect(parent.metadata["newProp"]).toBe("added-in-doc2");
    expect(parent.metadata["tags"]).toBeUndefined();
    expect(parent.metadata["framework"]).toBe("react"); // Preserved

    // Doc1: Test array methods
    const removed = parent.children.pop();
    expect(removed?.name).toBe("Child3");
    expect(parent.children).toHaveLength(2);

    // Sync array mutation
    syncDocs(doc1, doc2);
    expect(parent2.children).toHaveLength(2);
    expect(parent2.children[0].name).toBe("Child1");
    expect(parent2.children[1].name).toBe("Child2");
  });

  it("should handle entity identity across documents", async () => {
    // Doc1: Create entities with cross-references using Plexus
    const ephemeralSite4 = new Site({
      name: "Identity Test Site",
      components: {},
    });
    const { doc: doc1, root: site1 } =
      await initTestPlexus<Site>(ephemeralSite4);

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
    const { root: site2 } = await createTestPlexus<Site>(doc2);
    const comp1_doc2 = site2.components["comp1"];
    const comp2_doc2 = site2.components["comp2"];

    // Verify cross-references work
    expect(comp1_doc2.children[0]).toBe(comp2_doc2); // Same object reference
    expect(comp1_doc2.children[0].name).toBe("Component2");

    // Modify through reference in doc2
    comp1_doc2.children[0].name = "Modified Child";

    // Verify change appears through both references
    expect(comp2_doc2.name).toBe("Modified Child");

    // Sync back to doc1
    syncDocs(doc1, doc2);

    // Verify identity preserved in doc1
    expect(comp1.children[0]).toBe(comp2); // Still same reference
    expect(comp2.name).toBe("Modified Child");
    expect(comp1.children[0].name).toBe("Modified Child");
  });
});
