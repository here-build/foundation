import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus } from "./test-plexus";
import { DependencyId, Plexus } from "../Plexus";
import { deref } from "../deref";

@syncing
class Item extends PlexusModel {
  @syncing
  accessor name!: string;

  constructor(props) {
    super(props);
  }
}

@syncing
class Container extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing.child.list
  accessor children!: Item[];

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.map
  accessor meta!: Record<string, string>;

  constructor(props) {
    super(props);
  }
}

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.map
  accessor containers!: Record<string, Container>;

  @syncing.set
  accessor dependencies!: Set<Container>;

  @syncing.map
  accessor dependencyVersion!: Record<string, string>;

  constructor(props) {
    super(props);
  }
}

describe("Clone from dependency node", () => {
  let depDoc: Y.Doc;
  let rootDoc: Y.Doc;
  let depContainerId: string;

  beforeEach(async () => {
    // Create dependency document with Plexus
    const depItem = new Item({ name: "child-dep" });
    const depContainer = new Container({
      title: "dep-container",
      children: [depItem],
      tags: new Set(["dep-tag"]),
      meta: { source: "dep" },
    });

    const { doc: createdDepDoc, root: materializedDepContainer } =
      await initTestPlexus<Container>(depContainer);
    depDoc = createdDepDoc;
    depContainerId = materializedDepContainer.uuid;

    // Create root document with Plexus
    const ephemeralRoot = new Root({
      name: "root",
      containers: {},
      dependencies: new Set(),
      dependencyVersion: {},
    });
    const { doc: createdRootDoc, plexus } =
      await initTestPlexus<Root>(ephemeralRoot);
    rootDoc = createdRootDoc;

    // Set up dependency factory for the root Plexus
    plexus.registerDependencyFactory("dep", async () => depDoc);
  });

  it("produces an editable clone and materializes it into root", async () => {
    const plexus = Plexus.docPlexus.get(rootDoc)!;
    const root = await plexus.rootPromise;

    // Add the dependency and access the entity
    const depC = deref(await plexus.fetchDependency("dep", "latest"), [depContainerId]) as Container;

    const cloned = depC.clone();

    // Basic assertions
    expect(cloned).not.toBe(depC);
    expect(cloned.uuid).not.toBe(depC.uuid);
    expect(cloned.title).toBe("dep-container");
    expect(cloned.children.length).toBe(1);
    expect(cloned.children[0].name).toBe("child-dep");
    // Editable clone
    cloned.title = "local-clone";
    cloned.children[0].name = "child-local";
    cloned.tags.add("local");
    cloned.meta["from"] = "root";
    expect(cloned.title).toBe("local-clone");
    expect(cloned.children[0].name).toBe("child-local");
    expect(cloned.tags.has("local")).toBe(true);
    expect(cloned.meta["from"]).toBe("root");

    // Materialize by inserting into root record
    root.containers["c1"] = cloned;

    // Verify local tuples in storage (no package id)
    const models = rootDoc.getMap<Y.Map<any>>("models");
    const cId = (root.containers["c1"] as any).uuid as string;
    const cFields = models.get(cId)!;
    const children = cFields.get("children") as Y.Array<any>;
    expect(Array.isArray(children.get(0))).toBe(true);
    expect(children.get(0)).toHaveLength(1);
  });

  it("does not mutate dependency when editing the clone", async () => {
    const plexus = Plexus.docPlexus.get(rootDoc)!;

    // Add the dependency and access the entity
    await plexus.addDependency<Container>("dep", "latest");
    const depC = deref(await plexus.fetchDependency("dep", "latest"), [depContainerId]) as Container;


    const cloned = depC.clone();
    cloned.title = "mutated-clone";
    cloned.children[0].name = "mutated-child";

    // Dependency manifestation remains unchanged
    expect(depC.title).toBe("dep-container");
    expect(depC.children[0].name).toBe("child-dep");
  });
});
