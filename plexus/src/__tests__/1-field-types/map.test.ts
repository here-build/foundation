/**
 * PlexusMap Tests
 *
 * Comprehensive tests for the Map field type including:
 * - Basic operations (get/set/has/delete/clear)
 * - Iteration (keys/values/entries/forEach)
 * - Complex key types (Set keys, Array keys, PlexusModel keys, string keys)
 * - Edge cases and security considerations
 * - Persistence via Plexus/YJS
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ============================================
// Test Models
// ============================================

@syncing("Variant")
class Variant extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("FrameMetadata")
class FrameMetadata extends PlexusModel {
  @syncing accessor width!: number;
  @syncing accessor height!: number;
}

@syncing("KeyModel")
class KeyModel extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("ValueModel")
class ValueModel extends PlexusModel {
  @syncing accessor data!: string;
}

@syncing("Component")
class Component extends PlexusModel {
  @syncing accessor name!: string;

  // Map with Set<Variant> keys (canonical/unordered)
  @syncing.map accessor framesByCombo!: Map<Set<Variant>, FrameMetadata>;

  // Map with Variant[] keys (ordered)
  @syncing.map accessor framesByOrderedCombo!: Map<Variant[], FrameMetadata>;

  // Map with primitive keys
  @syncing.map accessor metadataByName!: Map<string, FrameMetadata>;

  // Map with PlexusModel keys (direct)
  @syncing.map accessor metadataByVariant!: Map<Variant, FrameMetadata>;
}

@syncing("TestContainer")
class TestContainer extends PlexusModel {
  @syncing.map accessor mapByString!: Map<string, ValueModel>;
  @syncing.map accessor mapBySet!: Map<Set<KeyModel>, ValueModel>;
  @syncing.map accessor mapByArray!: Map<KeyModel[], ValueModel>;
  @syncing.map accessor mapByModel!: Map<KeyModel, ValueModel>;
}

@syncing("TestSite")
class TestSite extends PlexusModel<null> {
  @syncing.child.list accessor components!: Component[];
  @syncing.child.list accessor variants!: Variant[];
  @syncing.child.list accessor containers!: TestContainer[];
  @syncing.child.list accessor keys!: KeyModel[];
}

describe("Map", () => {
  // ============================================
  // Basic Operations
  // ============================================

  describe("Basic operations", () => {
    it("should support get/set/has/delete with string keys", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const metadata = new FrameMetadata({ width: 100, height: 200 });

      // Set
      component.metadataByName.set("default", metadata);
      expect(component.metadataByName.size).to.equal(1);

      // Get
      expect(component.metadataByName.get("default")).to.equal(metadata);

      // Has
      expect(component.metadataByName.has("default")).to.eq(true);
      expect(component.metadataByName.has("nonexistent")).to.eq(false);

      // Delete
      expect(component.metadataByName.delete("default")).to.eq(true);
      expect(component.metadataByName.size).to.equal(0);
      expect(component.metadataByName.delete("nonexistent")).to.eq(false);
    });

    it("should support clear", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByName.set("a", new FrameMetadata({ width: 1, height: 1 }));
      component.metadataByName.set("b", new FrameMetadata({ width: 2, height: 2 }));
      expect(component.metadataByName.size).to.equal(2);

      component.metadataByName.clear();
      expect(component.metadataByName.size).to.equal(0);
    });
  });

  // ============================================
  // Iteration
  // ============================================

  describe("Iteration", () => {
    it("should support keys/values/entries iteration", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByName.set("first", meta1);
      component.metadataByName.set("second", meta2);

      // keys()
      const keys = [...component.metadataByName.keys()];
      expect(keys).to.include.members(["first", "second"]);

      // values()
      const values = [...component.metadataByName.values()];
      expect(values).to.include.members([meta1, meta2]);

      // entries()
      const entries = [...component.metadataByName.entries()];
      expect(entries).to.have.lengthOf(2);

      // forEach
      const collected: string[] = [];
      for (const [key, val] of component.metadataByName.entries()) {
        collected.push(key as string);
      }
      expect(collected).to.include.members(["first", "second"]);
    });
  });

  // ============================================
  // Set Keys (Canonical/Unordered)
  // ============================================

  describe("Set keys (canonical/unordered)", () => {
    it("should treat Set keys as unordered - same elements, different order = same key", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const metadata = new FrameMetadata({ width: 100, height: 200 });

      // Set with key [v1, v2]
      component.framesByCombo.set(new Set([v1, v2]), metadata);
      expect(component.framesByCombo.size).to.equal(1);

      // Get with key [v2, v1] - should find the same entry!
      const retrieved = component.framesByCombo.get(new Set([v2, v1]));
      expect(retrieved).to.equal(metadata);

      // Has with different order
      expect(component.framesByCombo.has(new Set([v2, v1]))).to.eq(true);
    });

    it("should distinguish different sets", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });
      const v3 = new Variant({ name: "Variant3" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.framesByCombo.set(new Set([v1, v2]), meta1);
      component.framesByCombo.set(new Set([v1, v3]), meta2);

      expect(component.framesByCombo.size).to.equal(2);
      expect(component.framesByCombo.get(new Set([v1, v2]))).to.equal(meta1);
      expect(component.framesByCombo.get(new Set([v1, v3]))).to.equal(meta2);
    });

    it("handles empty Set as key", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const emptySet = new Set<KeyModel>();
      const value = new ValueModel({ data: "empty-set-value" });

      container.mapBySet.set(emptySet, value);
      expect(container.mapBySet.size).to.equal(1);
      expect(container.mapBySet.get(new Set())?.data).to.equal("empty-set-value");
      expect(container.mapBySet.has(new Set())).to.eq(true);
    });

    it("should handle Set keys with same canonical form - last wins on assign", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const k1 = new KeyModel({ name: "key1" });
      const k2 = new KeyModel({ name: "key2" });
      site.keys.push(k1, k2);

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });

      // Same set, different order - should be treated as same key
      container.mapBySet = new Map([
        [new Set([k1, k2]), val1],
        [new Set([k2, k1]), val2], // Same canonical form!
      ]);

      expect(container.mapBySet.size).to.equal(1);
      expect(container.mapBySet.get(new Set([k1, k2]))?.data).to.equal("second");
    });
  });

  // ============================================
  // Array Keys (Ordered)
  // ============================================

  describe("Array keys (ordered)", () => {
    it("should preserve array order - different order = different key", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.framesByOrderedCombo.set([v1, v2], meta1);
      component.framesByOrderedCombo.set([v2, v1], meta2);

      // Different order = different entries
      expect(component.framesByOrderedCombo.size).to.equal(2);
    });

    it("handles empty Array as key", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const emptyArray: KeyModel[] = [];
      const value = new ValueModel({ data: "empty-array-value" });

      container.mapByArray.set(emptyArray, value);
      expect(container.mapByArray.size).to.equal(1);
      expect(container.mapByArray.get([])?.data).to.equal("empty-array-value");
      expect(container.mapByArray.has([])).to.eq(true);
    });

    it("should distinguish Array keys with different order", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const k1 = new KeyModel({ name: "key1" });
      const k2 = new KeyModel({ name: "key2" });
      site.keys.push(k1, k2);

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });

      // Different order = different keys for arrays
      container.mapByArray = new Map([
        [[k1, k2], val1],
        [[k2, k1], val2],
      ]);

      expect(container.mapByArray.size).to.equal(2);
      expect(container.mapByArray.get([k1, k2])?.data).to.equal("first");
      expect(container.mapByArray.get([k2, k1])?.data).to.equal("second");
    });
  });

  // ============================================
  // PlexusModel Keys (Direct)
  // ============================================

  describe("PlexusModel keys (direct)", () => {
    it("should support PlexusModel as direct map key", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);
      component.metadataByVariant.set(v2, meta2);

      expect(component.metadataByVariant.size).to.equal(2);
      expect(component.metadataByVariant.get(v1)).to.equal(meta1);
      expect(component.metadataByVariant.get(v2)).to.equal(meta2);
    });

    it("should use model identity - same model = same key", () => {
      const v1 = new Variant({ name: "Hover" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);

      component.metadataByVariant.set(v1, meta2); // Same key, update value

      expect(component.metadataByVariant.size).to.equal(1);
      expect(component.metadataByVariant.get(v1)).to.equal(meta2);
    });

    it("should distinguish different models with same data", () => {
      // Two variants with the same name but different identity
      const v1 = new Variant({ name: "Same" });
      const v2 = new Variant({ name: "Same" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);
      component.metadataByVariant.set(v2, meta2);

      // Different model instances = different keys
      expect(component.metadataByVariant.size).to.equal(2);
      expect(component.metadataByVariant.get(v1)).to.equal(meta1);
      expect(component.metadataByVariant.get(v2)).to.equal(meta2);
    });

    it("should support delete with model key", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByVariant.set(v1, new FrameMetadata({ width: 100, height: 100 }));
      component.metadataByVariant.set(v2, new FrameMetadata({ width: 200, height: 200 }));

      expect(component.metadataByVariant.delete(v1)).to.eq(true);
      expect(component.metadataByVariant).to.satisfy(
        (m: Map<unknown, unknown>) => m.size === 1 && !m.has(v1) && m.has(v2),
      );
    });

    it("should iterate over model keys", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByVariant.set(v1, new FrameMetadata({ width: 100, height: 100 }));
      component.metadataByVariant.set(v2, new FrameMetadata({ width: 200, height: 200 }));

      const keys = [...component.metadataByVariant.keys()];
      expect(keys).to.have.members([v1, v2]);
    });

    it("should handle model used as both key and value", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      // Create a model that will be both key and part of a Set key
      const model = new KeyModel({ name: "dual-purpose" });
      site.keys.push(model);

      // Model as key in model-keyed map
      const value = new ValueModel({ data: "test" });
      container.mapByModel = new Map([[model, value]]);

      expect(container.mapByModel.size).to.equal(1);
      expect(container.mapByModel.get(model)).to.equal(value);
    });
  });

  // ============================================
  // String Key Edge Cases
  // ============================================

  describe("String key edge cases", () => {
    it("handles string keys with newlines (escaped in JSON)", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const keyWithNewline = "hello\nworld";
      const value = new ValueModel({ data: "newline-key-value" });

      container.mapByString.set(keyWithNewline, value);
      expect(container.mapByString.size).to.equal(1);
      expect(container.mapByString.get("hello\nworld")?.data).to.equal("newline-key-value");
      expect(container.mapByString.has("hello\nworld")).to.eq(true);

      // Different string should not match
      expect(container.mapByString.has("helloworld")).to.eq(false);
      expect(container.mapByString.has("hello")).to.eq(false);
    });

    it("should handle entries with duplicate string keys - last wins", () => {
      const { root: site } = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );

      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });
      const val3 = new ValueModel({ data: "third" });

      // Assign with duplicate keys - last value should win
      container.mapByString = new Map([
        ["key", val1],
        ["key", val2],
        ["key", val3],
      ]);

      expect(container.mapByString.size).to.equal(1);
      expect(container.mapByString.get("key")?.data).to.equal("third");
    });
  });

  // ============================================
  // assign() Method
  // ============================================

  describe("assign() method", () => {
    let doc: Y.Doc;
    let site: TestSite;

    beforeEach(() => {
      const result = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );
      doc = result.doc;
      site = result.root;
    });

    function createContainer(): TestContainer {
      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);
      return container;
    }

    // Note: Plain objects, arrays, and generators are NOT supported
    // Maps follow JavaScript Map constructor protocol:
    // - Only accept Map<K, V> for assignment
    // - This eliminates __proto__, constructor, and generator hazards entirely
    // - Use new Map([...]) to create from entries

    describe("key stability", () => {
      it("should have stable keys immediately after assign", () => {
        const container = createContainer();

        container.mapByString = new Map([
          ["c", new ValueModel({ data: "c" })],
          ["a", new ValueModel({ data: "a" })],
          ["b", new ValueModel({ data: "b" })],
        ]);

        // Keys should be available immediately
        const keys1 = [...container.mapByString.keys()];
        const keys2 = [...container.mapByString.keys()];

        expect(keys1).to.deep.equal(keys2).and.have.lengthOf(3);
      });

      it("should maintain insertion order after assign", () => {
        const container = createContainer();

        // Assign in specific order
        container.mapByString = new Map([
          ["first", new ValueModel({ data: "1" })],
          ["second", new ValueModel({ data: "2" })],
          ["third", new ValueModel({ data: "3" })],
        ]);

        const keys = [...container.mapByString.keys()];
        expect(keys).to.deep.equal(["first", "second", "third"]);
      });
    });

    describe("transaction behavior", () => {
      it("should work identically inside and outside transaction", () => {
        const container1 = new TestContainer({
          mapByString: new Map(),
          mapBySet: new Map(),
          mapByArray: new Map(),
          mapByModel: new Map(),
        });
        const container2 = new TestContainer({
          mapByString: new Map(),
          mapBySet: new Map(),
          mapByArray: new Map(),
          mapByModel: new Map(),
        });
        site.containers.push(container1, container2);

        const entries: [string, ValueModel][] = [
          ["a", new ValueModel({ data: "a" })],
          ["b", new ValueModel({ data: "b" })],
        ];

        // Outside transaction
        container1.mapByString = new Map(entries);

        // Inside transaction
        doc.transact(() => {
          container2.mapByString = new Map(entries);
        }, Plexus);

        expect(container1.mapByString.size).to.equal(container2.mapByString.size);
        expect([...container1.mapByString.keys()]).to.deep.equal([...container2.mapByString.keys()]);
      });

      it("should batch YJS updates within transaction", () => {
        const container = createContainer();

        const updateSpy = vi.fn();
        doc.on("update", updateSpy);

        doc.transact(() => {
          container.mapByString = new Map([
            ["a", new ValueModel({ data: "a" })],
            ["b", new ValueModel({ data: "b" })],
            ["c", new ValueModel({ data: "c" })],
          ]);
        }, Plexus);

        // Should have been batched into fewer updates
        // (exact count depends on implementation)
        expect(updateSpy.mock.calls.length).toBeLessThanOrEqual(2);
      });
    });

    describe("empty iterables", () => {
      function* emptyGen(): Generator<[string, ValueModel]> {
        // Yields nothing
      }

      it("should clear map when assigned empty Map", () => {
        const container = createContainer();
        container.mapByString.set("existing", new ValueModel({ data: "old" }));
        container.mapByString = new Map();
        expect(container.mapByString.size).to.equal(0);
      });
    });

    describe("overlapping key sets", () => {
      it("should handle circular reference between key and value sets", () => {
        const container = createContainer();

        const k1 = new KeyModel({ name: "k1" });
        const k2 = new KeyModel({ name: "k2" });
        site.keys.push(k1, k2);

        const v1 = new ValueModel({ data: "v1" });
        const v2 = new ValueModel({ data: "v2" });

        // Multiple entries with overlapping set keys
        container.mapBySet = new Map([
          [new Set([k1]), v1],
          [new Set([k2]), v2],
          [new Set([k1, k2]), v1], // Combination
        ]);

        expect(container.mapBySet.size).to.equal(3);
        expect(container.mapBySet.get(new Set([k1]))).to.equal(v1);
        expect(container.mapBySet.get(new Set([k2]))).to.equal(v2);
        expect(container.mapBySet.get(new Set([k1, k2]))).to.equal(v1);
      });
    });
  });

  // ============================================
  // forEach Callback Behavior
  // ============================================

  describe("forEach callback behavior", () => {
    let doc: Y.Doc;
    let site: TestSite;

    beforeEach(() => {
      const result = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );
      doc = result.doc;
      site = result.root;
    });

    function createContainer(): TestContainer {
      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);
      return container;
    }

    describe("mutation during iteration", () => {
      it("BUG: mutation during forEach may cause unexpected behavior", () => {
        const container = createContainer();

        container.mapByString.set("a", new ValueModel({ data: "a" }));
        container.mapByString.set("b", new ValueModel({ data: "b" }));
        container.mapByString.set("c", new ValueModel({ data: "c" }));

        const visited: string[] = [];

        // Mutate map during iteration
        for (const [key, value] of container.mapByString.entries()) {
          visited.push(key as string);

          // Try to add a new key during iteration
          if (key === "b") {
            container.mapByString.set("d", new ValueModel({ data: "d" }));
          }
        }

        // BUG: The new key "d" might or might not be visited depending on
        // the iteration state when it was added
        // This documents current behavior - may not visit "d"
        expect(visited).to.include.members(["a", "b", "c"]);

        // The key was added regardless
        expect(container.mapByString.has("d")).to.eq(true);
      });

      it("BUG: deletion during forEach may skip entries", () => {
        const container = createContainer();

        container.mapByString.set("a", new ValueModel({ data: "a" }));
        container.mapByString.set("b", new ValueModel({ data: "b" }));
        container.mapByString.set("c", new ValueModel({ data: "c" }));

        const visited: string[] = [];

        // Delete entries during iteration
        for (const [key, value] of container.mapByString.entries()) {
          visited.push(key as string);

          // Delete "c" when visiting "a"
          if (key === "a") {
            container.mapByString.delete("c");
          }
        }

        // BUG: "c" may or may not be visited depending on iteration order
        // and internal implementation
        expect(visited).to.include.members(["a", "b"]);
        // We can't make strong assertions about "c" - behavior is undefined

        expect(container.mapByString.has("c")).to.eq(false);
      });

      it("should handle clear during forEach", () => {
        const container = createContainer();

        container.mapByString.set("a", new ValueModel({ data: "a" }));
        container.mapByString.set("b", new ValueModel({ data: "b" }));
        container.mapByString.set("c", new ValueModel({ data: "c" }));

        const visited: string[] = [];

        // Clear during iteration - this is destructive
        for (const [key, value] of container.mapByString.entries()) {
          visited.push(key as string);

          if (key === "a") {
            container.mapByString.clear();
          }
        }

        // After clear, iteration should stop (no more entries)
        // But "a" was already being visited
        expect(visited.length).toBeGreaterThanOrEqual(1);
        expect(container.mapByString.size).to.equal(0);
      });
    });

    describe("exception handling", () => {
      it("should propagate exception from callback", () => {
        const container = createContainer();

        container.mapByString.set("a", new ValueModel({ data: "a" }));
        container.mapByString.set("b", new ValueModel({ data: "b" }));
        container.mapByString.set("c", new ValueModel({ data: "c" }));

        const visited: string[] = [];

        expect(() => {
          for (const [key, value] of container.mapByString.entries()) {
            visited.push(key as string);
            if (key === "b") {
              throw new Error("Callback explosion!");
            }
          }
        }).to.throw("Callback explosion!");

        // Should have visited at least "a" and "b" before throwing
        // (exact order depends on iteration)
        expect(visited.length).toBeGreaterThanOrEqual(1);
      });

      it("should preserve map state after callback throws", () => {
        const container = createContainer();

        container.mapByString.set("a", new ValueModel({ data: "a" }));
        container.mapByString.set("b", new ValueModel({ data: "b" }));
        container.mapByString.set("c", new ValueModel({ data: "c" }));

        expect(() => {
          container.mapByString.forEach(() => {
            throw new Error("fail");
          });
        }).to.throw();

        // Map should be unchanged
        expect(container.mapByString.size).to.equal(3);
        expect(container.mapByString.get("a")?.data).to.equal("a");
        expect(container.mapByString.get("b")?.data).to.equal("b");
        expect(container.mapByString.get("c")?.data).to.equal("c");
      });
    });

    it("should support thisArg correctly", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));

      const context = { captured: false };

      container.mapByString.forEach(function (this: typeof context) {
        this.captured = true;
      }, context);

      expect(context.captured).to.eq(true);
    });
  });

  // ============================================
  // Delete Behavior During Iteration
  // ============================================

  describe("delete behavior during iteration", () => {
    let site: TestSite;

    beforeEach(() => {
      const result = initTestPlexus(
        new TestSite({
          components: [],
          variants: [],
          containers: [],
          keys: [],
        }),
      );
      site = result.root;
    });

    function createContainer(): TestContainer {
      const container = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container);
      return container;
    }

    it("delete() properly removes entries from iteration", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      expect(container.mapByString.size).to.equal(2);

      container.mapByString.delete("a");
      expect(container.mapByString.size).to.equal(1);

      // entries() only yields remaining entries
      const entries = [...container.mapByString.entries()];
      expect(entries).to.have.lengthOf(1);
      expect(entries[0][0]).to.equal("b");
      expect(entries[0][1].data).to.equal("b");

      // Verify accessors
      expect(container.mapByString.get("b")?.data).to.equal("b");
      expect(container.mapByString.has("a")).to.eq(false);
    });

    it("keys() iterator excludes deleted keys", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.delete("a");

      const keys = [...container.mapByString.keys()];
      expect(keys).to.have.lengthOf(1).and.include("b").and.not.include("a");
    });

    it("values() iterator excludes deleted entries", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.delete("a");

      const values = [...container.mapByString.values()];
      expect(values).to.have.lengthOf(1);
      expect(values[0].data).to.equal("b");
      expect(values).not.to.include(undefined);
    });
  });

  // ============================================
  // Persistence via Plexus/YJS
  // ============================================

  describe("Persistence via Plexus", () => {
    it("should persist Map data across document sync", () => {
      const doc1 = new Y.Doc({ guid: "test-site" });
      const site1 = new TestSite({
        components: [],
        variants: [],
        containers: [],
        keys: [],
      });
      const plexus1 = Plexus.bootstrap(site1, "test-site", doc1);

      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });
      site1.variants.push(v1, v2);

      const component = new Component({
        name: "Button",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });
      site1.components.push(component);

      // Add map entries
      component.metadataByName.set("default", new FrameMetadata({ width: 400, height: 300 }));
      component.framesByCombo.set(new Set([v1, v2]), new FrameMetadata({ width: 500, height: 400 }));

      // Sync to another doc
      const doc2 = new Y.Doc({ guid: doc1.guid });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
      const plexus2 = Plexus.connect(doc2) as Plexus<TestSite>;

      // Verify data was persisted
      const site2 = plexus2.root;
      const comp2 = site2.components[0];

      expect(comp2.metadataByName.size).to.equal(1);
      expect(comp2.metadataByName.get("default")?.width).to.equal(400);

      // Note: Set keys are serialized to UUIDs, so we need to reconstruct
      // the lookup using the synced variant objects
      const v1Synced = site2.variants[0];
      const v2Synced = site2.variants[1];
      expect(comp2.framesByCombo.size).to.equal(1);

      // The key lookup works with the synced variants
      const combo = comp2.framesByCombo.get(new Set([v1Synced, v2Synced]));
      expect(combo?.width).to.equal(500);
    });
  });
});
