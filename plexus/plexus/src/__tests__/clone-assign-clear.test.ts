/**
 * Comprehensive tests for new plexus methods: clone(), assign(), clear()
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { createTrackedFunction } from "../tracking";
import * as Y from "yjs";

// Test models for comprehensive testing
@syncing
class TestComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;

  constructor(props) {
    super(props);
  }
}

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;

  @syncing
  accessor component!: TestComponent | null;

  @syncing.list
  accessor items!: string[];

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.map
  accessor metadata!: Record<string, string>;

  @syncing.set
  accessor references!: Set<TestComponent>;

  constructor(props) {
    super(props);
  }
}

@syncing
class EdgeCaseParent extends PlexusModel {
  @syncing.child
  accessor value!: EdgeCaseChild;
  @syncing.child
  accessor field!: TestComponent;
}

@syncing
class EdgeCaseChild extends PlexusModel {
  @syncing
  accessor field!: TestComponent;
}

describe("clone(), assign(), clear() methods", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("clone() method", () => {
    it("should create a new entity with same primitive values", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set()
      });

      const cloned = original.clone();

      // Different entities
      expect(cloned.uuid).not.toBe(original.uuid);

      // Same primitive values
      expect({ ...cloned }).toMatchObject({
        name: "test",
        value: 42,
        component: null,
        items: [],
        metadata: {}
      });
      expect([...cloned.tags]).toEqual([]);
      expect([...cloned.references]).toEqual([]);
    });

    it("should shallow clone collections (new collection, same elements)", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp1,
        items: ["a", "b", "c"],
        tags: new Set(["tag1", "tag2"]),
        metadata: { key1: "value1", key2: "value2" },
        references: new Set([comp1, comp2])
      });

      const cloned = original.clone();

      // Collections are different instances
      expect(cloned.items).not.toBe(original.items);
      expect(cloned.tags).not.toBe(original.tags);
      expect(cloned.metadata).not.toBe(original.metadata);
      expect(cloned.references).not.toBe(original.references);

      // But contain same elements
      expect(cloned).toMatchObject({
        items: ["a", "b", "c"],
        metadata: { key1: "value1", key2: "value2" }
      });
      expect([...cloned.tags]).toEqual(expect.arrayContaining(["tag1", "tag2"]));
      expect([...cloned.references]).toEqual(expect.arrayContaining([comp1, comp2]));
    });

    it("should preserve entity references (not clone referenced entities)", () => {
      const comp = new TestComponent({ name: "referenced", version: 1 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp])
      });

      const cloned = original.clone();

      // Referenced entity should be the same instance
      expect(cloned.component).toBe(comp);
      expect(cloned.component?.uuid).toBe(comp.uuid);
      expect([...cloned.references]).toContain(comp);

      // Verify it's actually the same reference
      cloned.component!.name = "modified";
      expect(comp.name).toBe("modified");
    });

    it("should trigger access tracking when reading fields during clone", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["a", "b"],
        tags: new Set(["tag1"]),
        metadata: { key: "value" },
        references: new Set()
      });

      const notifyChanges = vi.fn();

      const trackedClone = createTrackedFunction(notifyChanges, () => {
        return original.clone();
      });

      const cloned = trackedClone();
      expect(cloned.name).toBe("test");

      // Modifying fields that were accessed during clone should notify
      original.name = "changed";
      expect(notifyChanges).toHaveBeenCalled();
    });

    it("should properly handle edge case", () => {
      const field = new TestComponent({});
      const parent = new EdgeCaseParent({
        value: new EdgeCaseChild({
          field
        }),
        field
      }).clone();
      expect(parent.field).not.toBe(field);
      expect(parent.field).toBe(parent.value.field);
    })
  });

  describe("array.assign() method", () => {
    it("should replace entire array contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old1", "old2", "old3"],
        tags: new Set(),
        metadata: {},
        references: new Set()
      });

      const newItems = ["new1", "new2"];
      model.items = newItems;

      expect(model.items).toEqual(["new1", "new2"]);
      expect(model.items).not.toBe(newItems);
      newItems.push("new3");
      expect(model.items).toEqual(["new1", "new2"]);
    });

    it("should handle empty array assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["item1", "item2"],
        tags: new Set(),
        metadata: {},
        references: new Set()
      });

      model.items = [];
      expect(model.items).toEqual([]);
      expect(model.items.length).toBe(0);
    });

    it("should trigger modification tracking", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old"],
        tags: new Set(),
        metadata: {},
        references: new Set()
      });

      const notifyChanges = vi.fn();

      const trackedRead = createTrackedFunction(notifyChanges, () => {
        return model.items.length;
      });

      expect(trackedRead()).toBe(1);

      model.items = ["new1", "new2"];
      expect(notifyChanges).toHaveBeenCalled();
    });
  });

  describe("set.assign() method", () => {
    it("should replace entire set contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old1", "old2"]),
        metadata: {},
        references: new Set()
      });

      model.tags = new Set(["new1", "new2", "new3"]);

      expect([...model.tags]).toEqual(expect.arrayContaining(["new1", "new2", "new3"]));
    });

    it("should handle duplicate values in assignment (maintains set uniqueness)", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old"]),
        metadata: {},
        references: new Set()
      });

      model.tags = new Set(["new1", "new2", "new1", "new2"]);
      expect([...model.tags]).toEqual(expect.arrayContaining(["new1", "new2"]));
      expect(model.tags.size).toBe(2);
    });

    it("should work with entity references", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });
      const comp3 = new TestComponent({ name: "comp3", version: 3 });

      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp1])
      });

      model.references = new Set([comp2, comp3]);
      expect([...model.references]).toEqual(expect.arrayContaining([comp2, comp3]));
      expect(model.references.has(comp1)).toBe(false);
      expect(model.references.has(comp2)).toBe(true);
      expect(model.references.has(comp3)).toBe(true);
    });
  });

  describe("map.assign() method", () => {
    it("should replace entire map contents with Record object", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { old1: "value1", old2: "value2" },
        references: new Set()
      });

      model.metadata = { new1: "newValue1", new2: "newValue2" };

      expect(model.metadata).toEqual({ new1: "newValue1", new2: "newValue2" });
      expect(Object.keys(model.metadata)).toEqual(["new1", "new2"]);
    });

    it("should handle empty assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { existing: "value" },
        references: new Set()
      });

      model.metadata = {};
      expect(model.metadata).toEqual({});
      expect(Object.keys(model.metadata)).toEqual([]);
    });
  });

  describe("clear() methods", () => {
    it("should clear set contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["tag1", "tag2", "tag3"]),
        metadata: {},
        references: new Set()
      });

      const result = model.tags.clear();
      expect(model.tags.size).toBe(0);
      expect([...model.tags]).toEqual([]);
      expect(result).toBe(undefined); // Native Set.clear() returns undefined
    });

    it("should clear map contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { key1: "value1", key2: "value2" },
        references: new Set()
      });

      model.metadata = {};
      expect(model.metadata).toEqual({});
      expect(Object.keys(model.metadata)).toEqual([]);
    });

    it("should handle clearing empty collections", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set()
      });

      expect(model.tags.clear()).toBe(undefined); // Native Set.clear() returns undefined
      model.metadata = {};
      expect(model.tags.size).toBe(0);
      expect(Object.keys(model.metadata)).toEqual([]);
    });
  });

  describe("method combinations", () => {
    it("should work with clone and assign together", () => {
      const original = new TestModel({
        name: "original",
        value: 100,
        component: null,
        items: ["item1", "item2"],
        tags: new Set(["tag1"]),
        metadata: { key: "value" },
        references: new Set()
      });

      const cloned = original.clone();

      // Modify the cloned entity collections
      cloned.items = ["new1", "new2", "new3"];
      cloned.tags = new Set(["newTag1", "newTag2"]);
      cloned.metadata = { newKey: "newValue" };

      // Original should be unchanged
      expect(original.items).toEqual(["item1", "item2"]);
      expect([...original.tags]).toEqual(["tag1"]);
      expect(original.metadata).toEqual({ key: "value" });

      // Cloned should have new values
      expect(cloned.items).toEqual(["new1", "new2", "new3"]);
      expect([...cloned.tags]).toEqual(expect.arrayContaining(["newTag1", "newTag2"]));
      expect(cloned.metadata).toEqual({ newKey: "newValue" });
    });

    it("should work with clear and assign together", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old1", "old2"],
        tags: new Set(["oldTag1", "oldTag2"]),
        metadata: { oldKey1: "oldValue1", oldKey2: "oldValue2" },
        references: new Set()
      });

      // Clear everything
      model.tags.clear();
      model.metadata = {};

      expect(model.tags.size).toBe(0);
      expect(Object.keys(model.metadata)).toEqual([]);

      // Then assign new values
      model.items = ["new1"];
      model.tags = new Set(["newTag"]);
      model.metadata = { newKey: "newValue" };

      expect(model.items).toEqual(["new1"]);
      expect([...model.tags]).toEqual(["newTag"]);
      expect(model.metadata).toEqual({ newKey: "newValue" });
    });
  });
});
