import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { createTestPlexus, initTestPlexus } from "./test-plexus";
import { backingStorageSymbol } from "../proxy-runtime-types";

// Create a proper inheritance hierarchy to test
@syncing
abstract class BaseEntity extends PlexusModel {
  @syncing
  accessor baseField!: string;

  @syncing
  accessor baseNumber: number = 42; // Default value

  @syncing
  accessor baseOptional: string | null = null;
}

@syncing
abstract class MiddleEntity extends BaseEntity {
  @syncing
  accessor middleField!: string;

  @syncing.list
  accessor middleList: string[] = ["default1", "default2"]; // Default array

  @syncing.map
  accessor middleMap: Record<string, number> = { defaultKey: 100 }; // Default object

  constructor(props) {
    super(props);
  }
}

@syncing
class ConcreteEntity extends MiddleEntity {
  @syncing
  accessor concreteField!: string;

  @syncing.set
  accessor concreteSet: Set<string> = new Set(["item1", "item2"]); // Default set

  @syncing.child.list
  accessor children: ChildEntity[] = []; // Default empty array for child list

  constructor(props) {
    super(props);
  }
}

@syncing
class ChildEntity extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value: number = 999; // Default value

  constructor(props) {
    super(props);
  }
}

// Another concrete entity for testing
@syncing
class AnotherConcreteEntity extends MiddleEntity {
  @syncing
  accessor specificField: string = "specific-default";

  constructor(props) {
    super(props);
  }
}

describe("Plexus Inheritance and Default Values", () => {
  describe("Inherited fields sync properly", () => {
    it("should sync inherited fields from base classes", async () => {
      const entity = new ConcreteEntity({
        baseField: "base-value",
        middleField: "middle-value",
        concreteField: "concrete-value",
      });

      const { plexus, root, doc } = await initTestPlexus(entity);

      // Verify all inherited fields are accessible
      expect(root.baseField).toBe("base-value");
      expect(root.middleField).toBe("middle-value");
      expect(root.concreteField).toBe("concrete-value");

      console.log(backingStorageSymbol);
      // Modify inherited fields and verify sync
      root.baseField = "updated-base";
      root.middleField = "updated-middle";

      expect(root.baseField).toBe("updated-base");
      expect(root.middleField).toBe("updated-middle");

      // Create another doc synced with the first
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

      const { root: root2 } = await createTestPlexus<ConcreteEntity>(doc2);

      // Verify inherited fields synced to second doc
      expect(root2.baseField).toBe("updated-base");
      expect(root2.middleField).toBe("updated-middle");
      expect(root2.concreteField).toBe("concrete-value");
    });

    it("should sync inherited collection fields properly", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
      });

      const { root } = await initTestPlexus(entity);

      // Inherited list should have defaults
      expect(root.middleList).toEqual(["default1", "default2"]);

      // Modify inherited list
      root.middleList.push("new-item");
      expect(root.middleList).toEqual(["default1", "default2", "new-item"]);

      // Inherited map should have defaults
      expect(root.middleMap).toEqual({ defaultKey: 100 });

      // Modify inherited map
      root.middleMap.newKey = 200;
      expect(root.middleMap.newKey).toBe(200);
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

      const { root } = await initTestPlexus(entity);

      // Check default primitive values
      expect(root.baseNumber).toBe(42); // Default from BaseEntity
      expect(root.baseOptional).toBe(null); // Default null
    });

    it("should apply default collection values", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        // Not providing collection values
      });

      const { root } = await initTestPlexus(entity);

      // Check default array
      expect(root.middleList).toEqual(["default1", "default2"]);
      expect(root.middleList).toBeInstanceOf(Array);

      // Check default map
      expect(root.middleMap).toEqual({ defaultKey: 100 });
      expect(typeof root.middleMap).toBe("object");

      // Check default set
      expect(root.concreteSet).toBeInstanceOf(Set);
      expect(Array.from(root.concreteSet)).toEqual(["item1", "item2"]);

      // Check default empty child list
      expect(root.children).toEqual([]);
      expect(root.children).toBeInstanceOf(Array);
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

      const { root: root1 } = await initTestPlexus(entity1);
      const { root: root2 } = await initTestPlexus(entity2);

      // Both should have the same inherited defaults
      expect(root1.baseNumber).toBe(42);
      expect(root2.baseNumber).toBe(42);

      expect(root1.middleList).toEqual(["default1", "default2"]);
      expect(root2.middleList).toEqual(["default1", "default2"]);

      expect(root1.middleMap).toEqual({ defaultKey: 100 });
      expect(root2.middleMap).toEqual({ defaultKey: 100 });

      // But AnotherConcreteEntity has its own specific default
      expect(root2.specificField).toBe("specific-default");
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

      const { root } = await initTestPlexus(entity);

      // Verify overridden values
      expect(root.baseNumber).toBe(999);
      expect(root.middleList).toEqual(["custom1"]);
      expect(root.middleMap).toEqual({ customKey: 500 });
      expect(Array.from(root.concreteSet)).toEqual(["custom"]);
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

      const { doc: doc1 } = await initTestPlexus(entity1);

      // Create second doc and sync
      const doc2 = new Y.Doc();

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
      const { root: root2 } = await createTestPlexus<ConcreteEntity>(doc2);

      // Values should be from doc1, NOT defaults
      expect(root2.baseNumber).toBe(123); // NOT default 42
      expect(root2.middleList).toEqual(["custom1", "custom2"]); // NOT default ["default1", "default2"]
      expect(root2.middleMap).toEqual({ customKey: 789 }); // NOT default { defaultKey: 100 }
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

      const { doc: doc1, root: root1 } = await initTestPlexus(entity);

      // Add another child after initialization
      const child2 = new ChildEntity({
        name: "child2",
        value: 777,
      });
      root1.children.push(child2);

      // Create second doc and sync
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      const { root: root2 } = await createTestPlexus<ConcreteEntity>(doc2);

      // Check children are preserved with their custom values
      expect(root2.children).toHaveLength(2);
      expect(root2.children[0].name).toBe("child1");
      expect(root2.children[0].value).toBe(555); // NOT default 999
      expect(root2.children[1].name).toBe("child2");
      expect(root2.children[1].value).toBe(777); // NOT default 999
    });

    it("should handle real-time sync without resetting to defaults", async () => {
      const entity = new ConcreteEntity({
        baseField: "base",
        middleField: "middle",
        concreteField: "concrete",
        baseNumber: 100,
      });

      const { doc: doc1, root: root1 } = await initTestPlexus(entity);

      // Create second doc
      const doc2 = new Y.Doc();

      // Initial sync - apply doc1's state to doc2
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Set up bidirectional sync
      doc1.on("update", (update) => {
        Y.applyUpdate(doc2, update);
      });
      doc2.on("update", (update) => {
        Y.applyUpdate(doc1, update);
      });

      const { root: root2 } = await createTestPlexus<ConcreteEntity>(doc2);

      // Verify initial sync
      expect(root2.baseNumber).toBe(100);

      // Make changes on doc1
      root1.baseNumber = 200;
      root1.middleList = ["realtime1", "realtime2"];

      // Changes should sync to doc2 without resetting to defaults
      expect(root2.baseNumber).toBe(200);
      expect(root2.middleList).toEqual(["realtime1", "realtime2"]);

      // Make changes on doc2
      root2.middleMap.realtimeKey = 999;

      // Changes should sync back to doc1
      expect(root1.middleMap.realtimeKey).toBe(999);

      // Original values should not be reset to defaults
      expect(root1.baseNumber).toBe(200);
      expect(root1.middleList).toEqual(["realtime1", "realtime2"]);
    });
  });

  describe("Complex inheritance scenarios", () => {
    it("should handle deep inheritance chains with multiple abstract classes", async () => {
      @syncing
      abstract class Layer1 extends PlexusModel {
        @syncing accessor l1: string = "layer1-default";
      }

      @syncing
      abstract class Layer2 extends Layer1 {
        @syncing accessor l2: number = 222;
      }

      @syncing
      abstract class Layer3 extends Layer2 {
        @syncing.list accessor l3: string[] = ["l3-default"];
      }

      @syncing
      class DeepConcrete extends Layer3 {
        @syncing accessor concrete: boolean = true;
      }

      const entity = new DeepConcrete({});
      const { root } = await initTestPlexus(entity);

      // All defaults from all layers should be applied
      expect(root.l1).toBe("layer1-default");
      expect(root.l2).toBe(222);
      expect(root.l3).toEqual(["l3-default"]);
      expect(root.concrete).toBe(true);

      // All fields should be modifiable and sync
      root.l1 = "modified-l1";
      root.l2 = 333;
      root.l3.push("new-item");
      root.concrete = false;

      expect(root.l1).toBe("modified-l1");
      expect(root.l2).toBe(333);
      expect(root.l3).toEqual(["l3-default", "new-item"]);
      expect(root.concrete).toBe(false);
    });

    it("should handle multiple concrete classes from same abstract base", async () => {
      @syncing
      abstract class AbstractProduct extends PlexusModel {
        @syncing accessor name!: string;
        @syncing accessor price: number = 0;
        @syncing.list accessor tags: string[] = ["product"];
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class Book extends AbstractProduct {
        @syncing accessor isbn!: string;
        @syncing accessor pages: number = 0;
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class Movie extends AbstractProduct {
        @syncing accessor duration!: number;
        @syncing accessor rating: string = "PG";
        constructor(props) {
          super(props);
        }
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

      const { root: bookRoot } = await initTestPlexus(book);
      const { root: movieRoot } = await initTestPlexus(movie);

      // Both should have inherited defaults
      expect(bookRoot.price).toBe(0);
      expect(bookRoot.tags).toEqual(["product"]);
      expect(movieRoot.price).toBe(0);
      expect(movieRoot.tags).toEqual(["product"]);

      // Each should have their own specific fields
      expect(bookRoot.isbn).toBe("123-456");
      expect(bookRoot.pages).toBe(300);
      expect(movieRoot.duration).toBe(120);
      expect(movieRoot.rating).toBe("PG");
    });
  });

  describe("Field type override (changing schema type in child)", () => {
    it("should allow changing field from reference to owned child", async () => {
      @syncing
      class SharedArg extends PlexusModel {
        @syncing accessor name!: string;
        @syncing accessor value: number = 0;

        constructor(props) {
          super(props);
        }
      }

      @syncing
      class WeakRefParent extends PlexusModel {
        @syncing accessor id!: string;
        @syncing accessor arg!: SharedArg; // Weak reference
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class OwnedChildVersion extends WeakRefParent {
        // @ts-expect-error
        @syncing.child accessor arg!: SharedArg; // Override as owned child
        constructor(props) {
          super(props);
        }
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
      const { root: parentRoot } = await initTestPlexus(parent);
      expect(parentRoot.arg.name).toBe("shared");
      expect(parentRoot.arg.value).toBe(100);

      // Modifying through parent should affect shared instance
      parentRoot.arg.value = 200;
      expect(sharedArg.value).toBe(200);

      // Test 2: Child should own the arg
      const ownedArg = new SharedArg({
        name: "owned",
        value: 300,
      });

      const child = new OwnedChildVersion({
        id: "child",
        arg: ownedArg,
      });
      const { root: childRoot } = await initTestPlexus(child);
      expect(childRoot.arg.name).toBe("owned");
      expect(childRoot.arg.value).toBe(300);

      // Check parent relationship is established for owned version
      expect(childRoot.arg.parent).toBe(childRoot);
    });

    it("should handle list to child.list override", async () => {
      @syncing
      class Item extends PlexusModel {
        @syncing accessor name!: string;
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class ListParent extends PlexusModel {
        @syncing.list accessor items: Item[] = [];
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class ChildListVersion extends ListParent {
        @syncing.child.list accessor items: Item[] = []; // Override as child list
        constructor(props) {
          super(props);
        }
      }

      const item1 = new Item({ name: "item1" });
      const item2 = new Item({ name: "item2" });

      // Parent version - items are references
      const parent = new ListParent({
        items: [item1, item2],
      });
      const { root: parentRoot } = await initTestPlexus(parent);
      expect(parentRoot.items).toHaveLength(2);
      expect(parentRoot.items[0].parent).toBeNull(); // Not owned

      // Child version - items are owned
      const child = new ChildListVersion({
        items: [new Item({ name: "owned1" }), new Item({ name: "owned2" })],
      });
      const { root: childRoot } = await initTestPlexus(child);
      expect(childRoot.items).toHaveLength(2);
      expect(childRoot.items[0].parent).toBe(childRoot); // Owned
      expect(childRoot.items[1].parent).toBe(childRoot); // Owned
    });

    it("should handle map to child.map override", async () => {
      @syncing
      class Config extends PlexusModel {
        @syncing accessor key!: string;
        @syncing accessor value!: string;
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class MapParent extends PlexusModel {
        @syncing.map accessor configs: Record<string, Config> = {};
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class ChildMapVersion extends MapParent {
        @syncing.child.map accessor configs: Record<string, Config> = {}; // Override as child map
        constructor(props) {
          super(props);
        }
      }

      const config1 = new Config({ key: "k1", value: "v1" });

      // Parent version - configs are references
      const parent = new MapParent({
        configs: { first: config1 },
      });
      const { root: parentRoot } = await initTestPlexus(parent);
      expect(parentRoot.configs.first.key).toBe("k1");
      expect(parentRoot.configs.first.parent).toBeNull(); // Not owned

      // Child version - configs are owned
      const child = new ChildMapVersion({
        configs: {
          owned: new Config({ key: "k2", value: "v2" }),
        },
      });
      const { root: childRoot } = await initTestPlexus(child);
      expect(childRoot.configs.owned.key).toBe("k2");
      expect(childRoot.configs.owned.parent).toBe(childRoot); // Owned
    });

    it("should handle complex override chain with mixed ownership", async () => {
      @syncing
      class Node extends PlexusModel {
        @syncing accessor id!: string;
        @syncing accessor label: string = "node";
        constructor(props) {
          super(props);
        }
      }

      @syncing
      abstract class BaseGraph extends PlexusModel {
        @syncing accessor root!: Node; // Reference
        @syncing.list accessor nodes: Node[] = []; // Reference list
        constructor(props) {
          super(props);
        }
      }

      @syncing
      abstract class OwnedRootGraph extends BaseGraph {
        // @ts-expect-error
        @syncing.child override accessor root!: Node;
        // nodes remains reference list
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class FullyOwnedGraph extends OwnedRootGraph {
        @syncing.child.list accessor nodes: Node[] = []; // Override: nodes are now owned too
        // root remains owned from OwnedRootGraph
        constructor(props) {
          super(props);
        }
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

      const { root: graphRoot, doc } = await initTestPlexus(graph);

      // Both root and nodes should be owned
      expect(graphRoot.root.parent).toBe(graphRoot);
      expect(graphRoot.nodes[0].parent).toBe(graphRoot);
      expect(graphRoot.nodes[1].parent).toBe(graphRoot);

      // Test cross-doc sync preserves ownership
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

      const { root: graphRoot2 } =
        await createTestPlexus<FullyOwnedGraph>(doc2);
      expect(graphRoot2.root.parent).toBe(graphRoot2);
      expect(graphRoot2.nodes[0].parent).toBe(graphRoot2);
      expect(graphRoot2.nodes[1].parent).toBe(graphRoot2);
    });

    it("should handle field type override with default values", async () => {
      @syncing
      class Value extends PlexusModel {
        @syncing accessor data: string = "default";
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class WeakParent extends PlexusModel {
        @syncing accessor value: Value | null = null; // Nullable reference with null default
        constructor(props) {
          super(props);
        }
      }

      @syncing
      class OwnedChild extends WeakParent {
        @syncing.child override accessor value: Value = new Value({
          data: "child-default",
        }); // Non-null owned with instance default
        constructor(props?: Partial<OwnedChild>) {
          super(props);
        }
      }

      // Parent uses null default
      const parent = new WeakParent({});
      const { root: parentRoot } = await initTestPlexus(parent);
      expect(parentRoot.value).toBeNull();

      // Child uses instance default and owns it
      const child = new OwnedChild();
      const { root: childRoot } = await initTestPlexus(child);
      expect(childRoot.value).not.toBeNull();
      expect(childRoot.value.data).toBe("child-default");
      expect(childRoot.value.parent).toBe(childRoot); // Owned

      // Can override the default
      const childWithOverride = new OwnedChild({
        value: new Value({ data: "override" }),
      });
      const { root: overrideRoot } = await initTestPlexus(childWithOverride);
      expect(overrideRoot.value.data).toBe("override");
      expect(overrideRoot.value.parent).toBe(overrideRoot); // Still owned
    });
  });
});
