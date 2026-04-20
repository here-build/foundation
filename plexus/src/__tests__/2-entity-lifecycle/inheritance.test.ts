import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// Create a proper inheritance hierarchy to test
@syncing("BaseEntity")
abstract class BaseEntity extends PlexusModel {
  @syncing
  accessor baseField!: string;

  @syncing
  accessor baseNumber: number = 42; // Default value

  @syncing
  accessor baseOptional: string | null = null;
}

@syncing("MiddleEntity")
abstract class MiddleEntity extends BaseEntity {
  @syncing
  accessor middleField!: string;

  @syncing.list
  accessor middleList: string[] = ["default1", "default2"]; // Default array

  @syncing.record
  accessor middleMap: Record<string, number> = { defaultKey: 100 }; // Default object
}

@syncing("ConcreteEntity")
class ConcreteEntity extends MiddleEntity {
  @syncing
  accessor concreteField!: string;

  @syncing.set
  accessor concreteSet: Set<string> = new Set(["item1", "item2"]); // Default set

  @syncing.child.list
  accessor children: ChildEntity[] = []; // Default empty array for child list
}

@syncing("ChildEntity")
class ChildEntity extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value: number = 999; // Default value
}

// Another concrete entity for testing
@syncing("AnotherConcreteEntity")
class AnotherConcreteEntity extends MiddleEntity {
  @syncing
  accessor specificField: string = "specific-default";
}

// Classes for testing inheritance with decorator overrides
@syncing("ParentWithStringish")
class ParentWithStringish extends PlexusModel {
  @syncing
  accessor stringish = "stringish";
  accessor stringishWithDefault = "stringishWithDefault";
}

@syncing("ChildWithStringish")
class ChildWithStringish extends ParentWithStringish {
  @syncing
  // @ts-expect-error - intentionally narrowing type in child
  accessor stringish!: "stringish" | "updatedStringish";
  @syncing
  accessor stringishWithDefault = "stringishWithDefaultOverride";
}

@syncing("SiteWithStringish")
class SiteWithStringish extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor inherited: ChildWithStringish = new ChildWithStringish();

  @syncing
  accessor defined!: ChildWithStringish | null;
}

// Helper to create materialized site as root for stringish tests
async function createTestSiteWithStringish(
  name: string,
): Promise<{ site: SiteWithStringish; entityId: string; doc: Y.Doc }> {
  const ephemeralSite = new SiteWithStringish({ name });
  const { doc, root: site } = initTestPlexus<SiteWithStringish>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

describe("Plexus Inheritance and Default Values", () => {
  describe("Inherited fields sync properly", () => {
    it("should sync inherited fields from base classes", async () => {
      const entity = new ConcreteEntity({
        baseField: "base-value",
        middleField: "middle-value",
        concreteField: "concrete-value",
      });

      const { plexus, root, doc } = initTestPlexus(entity);

      // Verify all inherited fields are accessible
      expect([root.baseField, root.middleField, root.concreteField]).to.have.ordered.members([
        "base-value",
        "middle-value",
        "concrete-value",
      ]);

      // Modify inherited fields and verify sync
      root.baseField = "updated-base";
      root.middleField = "updated-middle";

      expect([root.baseField, root.middleField]).to.have.ordered.members(["updated-base", "updated-middle"]);

      // Create another doc synced with the first
      const doc2 = new Y.Doc({ guid: doc.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

      const { root: root2 } = connectTestPlexus<ConcreteEntity>(doc2);

      // Verify inherited fields synced to second doc
      expect([root2.baseField, root2.middleField, root2.concreteField]).to.have.ordered.members([
        "updated-base",
        "updated-middle",
        "concrete-value",
      ]);
    });

    it("should sync inherited collection fields properly", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
      });

      const { root } = initTestPlexus(entity);

      // Inherited list should have defaults
      expect(root.middleList).to.deep.equal(["default1", "default2"]);

      // Modify inherited list
      root.middleList.push("new-item");
      expect(root.middleList).to.deep.equal(["default1", "default2", "new-item"]);

      // Inherited map should have defaults
      expect(root.middleMap).to.deep.equal({ defaultKey: 100 });

      // Modify inherited map
      root.middleMap.newKey = 200;
      expect(root.middleMap.newKey).to.equal(200);
    });
  });

  describe("Default values are properly applied", () => {
    it("should apply default primitive values", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        // Not providing values for fields with defaults
      });

      const { root } = initTestPlexus(entity);

      // Check default primitive values
      expect([root.baseNumber, root.baseOptional]).to.have.ordered.members([42, null]); // Default from BaseEntity
    });

    it("should apply default collection values", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        // Not providing collection values
      });

      const { root } = initTestPlexus(entity);

      // Check default array
      expect(root.middleList).to.deep.equal(["default1", "default2"]).and.be.instanceOf(Array);

      // Check default map
      expect(root.middleMap).to.deep.equal({ defaultKey: 100 });
      expect(typeof root.middleMap).to.equal("object");

      // Check default set
      expect(root.concreteSet).to.be.instanceOf(Set);
      expect([...root.concreteSet]).to.deep.equal(["item1", "item2"]);

      // Check default empty child list
      expect(root.children).to.deep.equal([]).and.be.instanceOf(Array);
    });

    it("should apply defaults to inherited fields in different concrete classes", async () => {
      const entity1 = new ConcreteEntity({
        baseField: "base1",
        middleField: "middle1",
        concreteField: "concrete1",
      });

      const entity2 = new AnotherConcreteEntity({
        baseField: "base2",
        middleField: "middle2",
      });

      const { root: root1 } = initTestPlexus(entity1);
      const { root: root2 } = initTestPlexus(entity2);

      // Both should have the same inherited defaults
      expect([root1.baseNumber, root2.baseNumber]).to.have.ordered.members([42, 42]);

      expect([root1.middleList, root2.middleList]).to.deep.equal([
        ["default1", "default2"],
        ["default1", "default2"],
      ]);

      expect([root1.middleMap, root2.middleMap]).to.deep.equal([{ defaultKey: 100 }, { defaultKey: 100 }]);

      // But AnotherConcreteEntity has its own specific default
      expect(root2.specificField).to.equal("specific-default");
    });

    it("should allow overriding default values during construction", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        baseNumber: 999, // Override default
        middleList: ["custom1"], // Override default array
        middleMap: { customKey: 500 }, // Override default map
        concreteSet: new Set(["custom"]), // Override default set
      });

      const { root } = initTestPlexus(entity);

      // Verify overridden values
      expect([root.baseNumber, root.middleList, root.middleMap, [...root.concreteSet]]).to.deep.equal([
        999,
        ["custom1"],
        { customKey: 500 },
        ["custom"],
      ]);
    });
  });

  describe("Cross-doc sync preserves values (no default override)", () => {
    it("should not override synced values with defaults when spawning entity from another doc", async () => {
      // Create first entity with custom values
      const entity1 = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        baseNumber: 123, // Custom value, not default
        middleList: ["custom1", "custom2"],
        middleMap: { customKey: 789 },
      });

      const { doc: doc1 } = initTestPlexus(entity1);

      // Create second doc and sync
      const doc2 = new Y.Doc({ guid: doc1.guid });

      // Establish sync before creating plexus
      doc1.on("update", (update) => {
        Y.applyUpdate(doc2, update);
      });
      doc2.on("update", (update) => {
        Y.applyUpdate(doc1, update);
      });

      // Apply initial state
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Create plexus on second doc - this should NOT reset to defaults
      const { root: root2 } = connectTestPlexus<ConcreteEntity>(doc2);

      // Values should be from doc1, NOT defaults
      expect([root2.baseNumber, root2.middleList, root2.middleMap]).to.deep.equal([
        123,
        ["custom1", "custom2"],
        { customKey: 789 },
      ]); // NOT defaults
    });

    it("should preserve child entity values during cross-doc sync", async () => {
      const child1 = new ChildEntity({
        name: "child1",
        value: 555, // Custom value, not default 999
      });

      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        children: [child1],
      });

      const { doc: doc1, root: root1 } = initTestPlexus(entity);

      // Add another child after initialization
      const child2 = new ChildEntity({
        name: "child2",
        value: 777,
      });
      root1.children.push(child2);

      // Create second doc and sync
      const doc2 = new Y.Doc({ guid: doc1.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      const { root: root2 } = connectTestPlexus<ConcreteEntity>(doc2);

      // Check children are preserved with their custom values
      expect([
        root2.children.length,
        root2.children[0].name,
        root2.children[0].value,
        root2.children[1].name,
        root2.children[1].value,
      ]).to.have.ordered.members([2, "child1", 555, "child2", 777]); // NOT default 999
    });

    it("should handle real-time sync without resetting to defaults", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        baseNumber: 100,
      });

      const { doc: doc1, root: root1 } = initTestPlexus(entity);

      // Create second doc
      const doc2 = new Y.Doc({ guid: doc1.guid });

      // Initial sync - apply doc1's state to doc2
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Set up bidirectional sync
      doc1.on("update", (update) => {
        Y.applyUpdate(doc2, update);
      });
      doc2.on("update", (update) => {
        Y.applyUpdate(doc1, update);
      });

      const { root: root2 } = connectTestPlexus<ConcreteEntity>(doc2);

      // Verify initial sync
      expect(root2.baseNumber).to.equal(100);

      // Make changes on doc1
      root1.baseNumber = 200;
      root1.middleList = ["realtime1", "realtime2"];

      // Changes should sync to doc2 without resetting to defaults
      expect([root2.baseNumber, root2.middleList]).to.deep.equal([200, ["realtime1", "realtime2"]]);

      // Make changes on doc2
      root2.middleMap.realtimeKey = 999;

      // Changes should sync back to doc1, original values should not be reset
      expect([root1.middleMap.realtimeKey, root1.baseNumber, root1.middleList]).to.deep.equal([
        999,
        200,
        ["realtime1", "realtime2"],
      ]);
    });
  });

  describe("Complex inheritance scenarios", () => {
    it("should handle deep inheritance chains with multiple abstract classes", async () => {
      @syncing("Layer1")
      abstract class Layer1 extends PlexusModel {
        @syncing accessor l1: string = "layer1-default";
      }

      @syncing("Layer2")
      abstract class Layer2 extends Layer1 {
        @syncing accessor l2: number = 222;
      }

      @syncing("Layer3")
      abstract class Layer3 extends Layer2 {
        @syncing.list accessor l3: string[] = ["l3-default"];
      }

      @syncing("DeepConcrete")
      class DeepConcrete extends Layer3 {
        @syncing accessor concrete: boolean = true;
      }

      const entity = new DeepConcrete({});
      const { root } = initTestPlexus(entity);

      // All defaults from all layers should be applied
      expect([root.l1, root.l2, root.l3, root.concrete]).to.deep.equal(["layer1-default", 222, ["l3-default"], true]);

      // All fields should be modifiable and sync
      root.l1 = "modified-l1";
      root.l2 = 333;
      root.l3.push("new-item");
      root.concrete = false;

      expect([root.l1, root.l2, root.l3, root.concrete]).to.deep.equal([
        "modified-l1",
        333,
        ["l3-default", "new-item"],
        false,
      ]);
    });

    it("should handle multiple concrete classes from same abstract base", async () => {
      @syncing("AbstractProduct")
      abstract class AbstractProduct extends PlexusModel {
        @syncing accessor name!: string;
        @syncing accessor price: number = 0;
        @syncing.list accessor tags: string[] = ["product"];
      }

      @syncing("Book")
      class Book extends AbstractProduct {
        @syncing accessor isbn!: string;
        @syncing accessor pages: number = 0;
      }

      @syncing("Movie")
      class Movie extends AbstractProduct {
        @syncing accessor duration!: number;
        @syncing accessor rating: string = "PG";
      }

      const book = new Book({
        name: "Test Book",
        isbn: "123-456",
        pages: 300,
      });

      const movie = new Movie({
        name: "Test Movie",
        duration: 120,
      });

      const { root: bookRoot } = initTestPlexus(book);
      const { root: movieRoot } = initTestPlexus(movie);

      // Both should have inherited defaults
      expect([bookRoot.price, bookRoot.tags, movieRoot.price, movieRoot.tags]).to.deep.equal([
        0,
        ["product"],
        0,
        ["product"],
      ]);

      // Each should have their own specific fields
      expect([bookRoot.isbn, bookRoot.pages, movieRoot.duration, movieRoot.rating]).to.have.ordered.members([
        "123-456",
        300,
        120,
        "PG",
      ]);
    });
  });

  describe("Decorator override stability across sync", () => {
    it("should maintain stability even with bad overwrites", async () => {
      const { site: site1, doc: doc1 } = await createTestSiteWithStringish("stability");

      site1.defined = new ChildWithStringish({
        stringish: "stringishPassed",
        stringishWithDefault: "stringishWithDefaultPassed",
      });
      expect([site1.defined!.stringish, site1.defined!.stringishWithDefault]).to.have.ordered.members([
        "stringishPassed",
        "stringishWithDefaultPassed",
      ]);
      expect([site1.inherited.stringish, site1.inherited.stringishWithDefault]).to.have.ordered.members([
        "stringish",
        "stringishWithDefaultOverride",
      ]);
      site1.inherited.stringish = "updatedStringish";
      site1.inherited.stringishWithDefault = "updatedStringishWithDefault";

      const doc2 = new Y.Doc({ guid: doc1.guid });
      syncDocs(doc1, doc2);

      // Access from doc2
      const { root: site2 } = connectTestPlexus<SiteWithStringish>(doc2);

      expect([site2.defined!.stringish, site2.defined!.stringishWithDefault]).to.have.ordered.members([
        "stringishPassed",
        "stringishWithDefaultPassed",
      ]);
      expect([site2.inherited.stringish, site2.inherited.stringishWithDefault]).to.have.ordered.members([
        "updatedStringish",
        "updatedStringishWithDefault",
      ]);

      doc2.destroy();
    });
  });

  describe("Field type override (changing schema type in child)", () => {
    it("should allow changing field from reference to owned child", async () => {
      @syncing("SharedArg")
      class SharedArg extends PlexusModel {
        @syncing accessor name!: string;
        @syncing accessor value: number = 0;
      }

      @syncing("WeakRefParent")
      class WeakRefParent extends PlexusModel {
        @syncing accessor id!: string;
        @syncing accessor arg!: SharedArg; // Weak reference
      }

      @syncing("OwnedChildVersion")
      class OwnedChildVersion extends WeakRefParent {
        // @ts-expect-error
        @syncing.child accessor arg!: SharedArg; // Override as owned child
      }

      // Create a shared arg
      const sharedArg = new SharedArg({
        name: "shared",
        value: 100,
      });

      // Test 1: Parent should have weak reference
      const parent = new WeakRefParent({
        id: "parent",
        arg: sharedArg,
      });
      const { root: parentRoot } = initTestPlexus(parent);
      expect([parentRoot.arg.name, parentRoot.arg.value]).to.have.ordered.members(["shared", 100]);

      // Modifying through parent should affect shared instance
      parentRoot.arg.value = 200;
      expect(sharedArg.value).to.equal(200);

      // Test 2: Child should own the arg
      const ownedArg = new SharedArg({
        name: "owned",
        value: 300,
      });

      const child = new OwnedChildVersion({
        id: "child",
        arg: ownedArg,
      });
      const { root: childRoot } = initTestPlexus(child);
      expect([childRoot.arg.name, childRoot.arg.value, childRoot.arg.parent]).to.have.ordered.members([
        "owned",
        300,
        childRoot,
      ]);
    });

    it("should handle list to child.list override", async () => {
      @syncing("Item")
      class Item extends PlexusModel {
        @syncing accessor name!: string;
      }

      @syncing("ListParent")
      class ListParent extends PlexusModel {
        @syncing.list accessor items: Item[] = [];
      }

      @syncing("ChildListVersion")
      class ChildListVersion extends ListParent {
        @syncing.child.list accessor items: Item[] = []; // Override as child list
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });

      // Parent version - items are references
      const parent = new ListParent({
        items: [item1, item2],
      });
      const { root: parentRoot } = initTestPlexus(parent);
      expect([parentRoot.items.length, parentRoot.items[0].parent]).to.have.ordered.members([2, null]); // Not owned

      // Child version - items are owned
      const child = new ChildListVersion({
        items: [new Item({ name: "owned1" }), new Item({ name: "owned2" })],
      });
      const { root: childRoot } = initTestPlexus(child);
      expect([childRoot.items.length, childRoot.items[0].parent, childRoot.items[1].parent]).to.have.ordered.members([
        2,
        childRoot,
        childRoot,
      ]); // Owned
    });

    it("should handle map to child.map override", async () => {
      @syncing("Config")
      class Config extends PlexusModel {
        @syncing accessor key!: string;
        @syncing accessor value!: string;
      }

      @syncing("MapParent")
      class MapParent extends PlexusModel {
        @syncing.record accessor configs: Record<string, Config> = {};
      }

      @syncing("ChildMapVersion")
      class ChildMapVersion extends MapParent {
        @syncing.child.record accessor configs: Record<string, Config> = {}; // Override as child map
      }

      const config1 = new Config({ key: "k1", value: "v1" });

      // Parent version - configs are references
      const parent = new MapParent({
        configs: { first: config1 },
      });
      const { root: parentRoot } = initTestPlexus(parent);
      expect([parentRoot.configs.first.key, parentRoot.configs.first.parent]).to.have.ordered.members(["k1", null]); // Not owned

      // Child version - configs are owned
      const child = new ChildMapVersion({
        configs: {
          owned: new Config({ key: "k2", value: "v2" }),
        },
      });
      const { root: childRoot } = initTestPlexus(child);
      expect([childRoot.configs.owned.key, childRoot.configs.owned.parent]).to.have.ordered.members(["k2", childRoot]); // Owned
    });

    it("should handle complex override chain with mixed ownership", async () => {
      @syncing("Node")
      class Node extends PlexusModel {
        @syncing accessor id!: string;
        @syncing accessor label: string = "node";
      }

      @syncing("BaseGraph")
      abstract class BaseGraph extends PlexusModel {
        @syncing accessor root!: Node; // Reference
        @syncing.list accessor nodes: Node[] = []; // Reference list
      }

      @syncing("OwnedRootGraph")
      abstract class OwnedRootGraph extends BaseGraph {
        // @ts-expect-error
        @syncing.child override accessor root!: Node;
      }

      @syncing("FullyOwnedGraph")
      class FullyOwnedGraph extends OwnedRootGraph {
        @syncing.child.list accessor nodes: Node[] = []; // Override: nodes are now owned too
      }

      // Create nodes
      const rootNode = new Node({ id: "root", label: "Root Node" });
      const node1 = new Node({ id: "n1", label: "Node 1" });
      const node2 = new Node({ id: "n2", label: "Node 2" });

      // Test the fully owned version
      const graph = new FullyOwnedGraph({
        root: rootNode,
        nodes: [node1, node2],
      });

      const { root: graphRoot, doc } = initTestPlexus(graph);

      // Both root and nodes should be owned
      expect([graphRoot.root.parent, graphRoot.nodes[0].parent, graphRoot.nodes[1].parent]).to.have.ordered.members([
        graphRoot,
        graphRoot,
        graphRoot,
      ]);

      // Test cross-doc sync preserves ownership
      const doc2 = new Y.Doc({ guid: doc.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

      const { root: graphRoot2 } = connectTestPlexus<FullyOwnedGraph>(doc2);
      expect([graphRoot2.root.parent, graphRoot2.nodes[0].parent, graphRoot2.nodes[1].parent]).to.have.ordered.members([
        graphRoot2,
        graphRoot2,
        graphRoot2,
      ]);
    });

    it("should handle field type override with default values", async () => {
      @syncing("Value")
      class Value extends PlexusModel {
        @syncing accessor data: string = "default";
      }

      @syncing("WeakParent")
      class WeakParent extends PlexusModel {
        @syncing accessor value: Value | null = null; // Nullable reference with null default
      }

      @syncing("OwnedChild")
      class OwnedChild extends WeakParent {
        @syncing.child override accessor value: Value = new Value({
          data: "child-default",
        }); // Non-null owned with instance default
      }

      // Parent uses null default
      const parent = new WeakParent({});
      const { root: parentRoot } = initTestPlexus(parent);
      expect(parentRoot.value).to.eq(null);

      // Child uses instance default and owns it
      const child = new OwnedChild();
      const { root: childRoot } = initTestPlexus(child);
      expect([childRoot.value !== null, childRoot.value.data, childRoot.value.parent]).to.have.ordered.members([
        true,
        "child-default",
        childRoot,
      ]); // Owned

      // Can override the default
      const childWithOverride = new OwnedChild({
        value: new Value({ data: "override" }),
      });
      const { root: overrideRoot } = initTestPlexus(childWithOverride);
      expect([overrideRoot.value.data, overrideRoot.value.parent]).to.have.ordered.members(["override", overrideRoot]); // Still owned
    });
  });
});
