/**
 * Comprehensive tests for Set proxy implementation in plexus
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { Storageable } from "../proxy-runtime-types";
import * as Y from "yjs";
import { initTestPlexus } from "./test-plexus";

// Test model with a set field
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
class TestModelWithSet extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.set
  accessor components!: Set<TestComponent>;

  constructor(props) {
    super(props);
  }
}

describe("Set Proxy Implementation", () => {
  let doc: Y.Doc;

  beforeEach(async () => {
    // Just create a basic doc for the non-materialized tests
    doc = new Y.Doc();
  });

  describe("Ephemeral Sets", () => {
    it("should create empty sets", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set()
      });

      expect(model.tags).toBeInstanceOf(Set);
      expect(model.components).toBeInstanceOf(Set);
      expect(model.tags.size).toBe(0);
      expect(model.components.size).toBe(0);
    });

    it("should support basic Set operations", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set()
      });

      // Basic set operations
      expect(model.tags.has("tag1")).toBe(true);
      expect(model.tags.has("tag3")).toBe(false);
      expect(model.tags.size).toBe(2);

      // Add operation
      model.tags.add("tag3");
      expect(model.tags.has("tag3")).toBe(true);
      expect(model.tags.size).toBe(3);

      // Delete operation
      expect(model.tags.delete("tag1")).toBe(true);
      expect(model.tags.has("tag1")).toBe(false);
      expect(model.tags.size).toBe(2);

      // Delete non-existent
      expect(model.tags.delete("nonexistent")).toBe(false);
    });

    it("should support Set iteration methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set()
      });

      // Test values()
      const values = Array.from(model.tags.values());
      expect(values).toEqual(expect.arrayContaining(["tag1", "tag2", "tag3"]));

      // Test forEach
      const collected: string[] = [];
      model.tags.forEach((value) => collected.push(value));
      expect(collected).toEqual(expect.arrayContaining(["tag1", "tag2", "tag3"]));

      // Test entries()
      const entries = Array.from(model.tags.entries());
      expect(entries).toEqual(
        expect.arrayContaining([
          ["tag1", "tag1"],
          ["tag2", "tag2"],
          ["tag3", "tag3"]
        ])
      );
    });

    const hasSetComparators =
      typeof (new Set() as any).isDisjointFrom === "function" &&
      typeof (new Set() as any).isSubsetOf === "function" &&
      typeof (new Set() as any).isSupersetOf === "function";

    (hasSetComparators ? it : it.skip)("should support Set comparison methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set()
      });

      const otherSet = new Set(["tag2", "tag3"]);
      const subSet = new Set(["tag1"]);
      const superSet = new Set(["tag1", "tag2", "tag3"]);

      // Test set relationship methods
      expect((model.tags as any).isDisjointFrom(new Set(["tag3", "tag4"]))).toBe(true);
      expect((model.tags as any).isDisjointFrom(otherSet)).toBe(false);

      expect((model.tags as any).isSubsetOf(superSet)).toBe(true);
      expect((model.tags as any).isSubsetOf(subSet)).toBe(false);

      expect((model.tags as any).isSupersetOf(subSet)).toBe(true);
      expect((model.tags as any).isSupersetOf(superSet)).toBe(false);
    });

    it("should support clear operation", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set()
      });

      expect(model.tags.size).toBe(3);
      model.tags.clear();
      expect(model.tags.size).toBe(0);
      expect(model.tags.has("tag1")).toBe(false);
    });

    it("should work with entity sets", () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1, comp2])
      });

      expect(model.components.size).toBe(2);
      expect(model.components.has(comp1)).toBe(true);
      expect(model.components.has(comp2)).toBe(true);

      // Add another component
      const comp3 = new TestComponent({ name: "Component 3", version: 3 });
      model.components.add(comp3);
      expect(model.components.size).toBe(3);
      expect(model.components.has(comp3)).toBe(true);

      // Remove a component
      expect(model.components.delete(comp1)).toBe(true);
      expect(model.components.has(comp1)).toBe(false);
      expect(model.components.size).toBe(2);
    });
  });

  describe("Materialized Sets (YJS-backed)", () => {
    it("should materialize sets to YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set()
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify the loaded root has correct data
      expect(root.name).toBe("Test Model");
      expect(root.tags.size).toBe(2);
      expect(root.tags.has("tag1")).toBe(true);
      expect(root.tags.has("tag2")).toBe(true);

      // Check that YJS arrays were created
      const yprojectFields = plexusDoc.getMap<Y.Map<Storageable>>("models");
      const entityId = root.uuid;
      const tagsArray = yprojectFields.get(entityId)?.get("tags") as Y.Array<any>;

      expect(tagsArray).toBeInstanceOf(Y.Array);
      expect(tagsArray.length).toBe(2);
      expect(tagsArray.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should sync set changes through YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set()
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify initial state
      expect(root.tags.has("tag1")).toBe(true);
      expect(root.tags.size).toBe(1);

      // Changes should sync through YJS
      root.tags.add("tag2");
      expect(root.tags.has("tag2")).toBe(true);
      expect(root.tags.size).toBe(2);

      // Check YJS backing
      const yprojectFields = plexusDoc.getMap<Y.Map<Storageable>>("models");
      const entityId = root.uuid;
      const tagsArray = yprojectFields.get(entityId)?.get("tags") as Y.Array<any>;
      expect(tagsArray.length).toBe(2);
      expect(tagsArray.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should handle entity sets in materialized state", async () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1]),
      });

      // Materialize via Plexus
      const { root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify initial component set
      expect(root.components.size).toBe(1);
      expect(root.components.has(comp1)).toBe(true);

      // Add component to materialized set
      root.components.add(comp2);
      expect(root.components.size).toBe(2);
      expect(root.components.has(comp1)).toBe(true);
      expect(root.components.has(comp2)).toBe(true);

      // Remove component
      expect(root.components.delete(comp1)).toBe(true);
      expect(root.components.size).toBe(1);
      expect(root.components.has(comp1)).toBe(false);
      expect(root.components.has(comp2)).toBe(true);
    });
  });

  describe("Set Edge Cases", () => {
    it("should handle empty sets properly", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set()
      });

      expect(model.tags.size).toBe(0);
      expect(model.tags.clear()).toBe(undefined); // Native Set.clear() returns undefined
      expect(model.tags.delete("nonexistent")).toBe(false);
      expect(model.tags.has("anything")).toBe(false);

      // Iteration should work on empty sets
      const values = Array.from(model.tags.values());
      expect(values).toEqual([]);

      const collected: string[] = [];
      model.tags.forEach((value) => collected.push(value));
      expect(collected).toEqual([]);
    });

    it("should maintain Set uniqueness", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set()
      });

      // Adding duplicate should not increase size
      model.tags.add("tag1");
      expect(model.tags.size).toBe(1);
      expect(model.tags.has("tag1")).toBe(true);

      // Should work with entities too
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      model.components.add(comp1);
      model.components.add(comp1); // Adding same entity
      expect(model.components.size).toBe(1);
      expect(model.components.has(comp1)).toBe(true);
    });
  });
});
