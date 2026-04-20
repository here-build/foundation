/**
 * Null handling edge case tests
 *
 * Tests behavior of null values across all field types:
 * - Nullable primitive fields
 * - Nullable child references
 * - Null entries in collections (arrays, records, maps, sets)
 * - Transitions between null and non-null states
 */

import { reaction } from "mobx";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => { enableMobXIntegration(); });

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("NullableContainer")
class NullableContainer extends PlexusModel<null> {
  @syncing accessor nullableString: string | null = null;
  @syncing accessor nullableNumber: number | null = null;
  @syncing accessor nullableBoolean: boolean | null = null;
  @syncing.child accessor nullableChild: Item | null = null;
  @syncing.child.list accessor children: (Item | null)[] = [];
  @syncing.child.record accessor childRecord: Record<string, Item | null> = {};
  // Non-child collections for testing null as primitive value
  @syncing.record accessor primitiveRecord: Record<string, string | null> = {};
  @syncing.map accessor primitiveMap: Map<string, number | null> = new Map();
  @syncing.set accessor primitiveSet: Set<string | null> = new Set();
}

describe("Null Handling Edge Cases", () => {
  describe("nullable primitive fields", () => {
    it("initializes nullable fields as null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      expect([root.nullableString, root.nullableNumber, root.nullableBoolean]).to.have.ordered.members([
        null,
        null,
        null,
      ]);
    });

    it("can set nullable field from null to value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      root.nullableNumber = 42;
      root.nullableBoolean = true;

      expect([root.nullableString, root.nullableNumber, root.nullableBoolean]).to.have.ordered.members([
        "hello",
        42,
        true,
      ]);
    });

    it("can set nullable field from value back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      root.nullableString = null;
      root.nullableNumber = 42;
      root.nullableNumber = null;

      expect([root.nullableString, root.nullableNumber]).to.have.ordered.members([null, null]);
    });

    it("distinguishes null from undefined in nullable fields", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Null is the explicit empty value
      expect(root.nullableString).to.eq(null);
      expect(root.nullableString).to.not.eq(undefined);

      // Setting a value and then null
      root.nullableString = "test";
      root.nullableString = null;
      expect(root.nullableString).to.eq(null);
    });
  });

  describe("nullable child references", () => {
    it("initializes nullable child as null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      expect(root.nullableChild).to.eq(null);
    });

    it("can assign child to nullable field", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      expect([root.nullableChild !== null, root.nullableChild!.name]).to.have.ordered.members([true, "test"]);
    });

    it("can clear child back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      root.nullableChild = null;
      expect(root.nullableChild).to.eq(null);
    });

    it("can replace one child with another", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child1 = new Item({ name: "first" });
      const child2 = new Item({ name: "second" });

      root.nullableChild = child1;
      const firstName = root.nullableChild!.name;

      root.nullableChild = child2;
      expect([firstName, root.nullableChild!.name]).to.have.ordered.members(["first", "second"]);
    });
  });

  describe("null entries in arrays", () => {
    it("can push null to array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      expect([root.children.length, root.children[0]]).to.have.ordered.members([1, null]);
    });

    it("can have mixed null and non-null entries", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }), null);
      root.children.push(new Item({ name: "third" }));

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
      ]).to.have.ordered.members([3, "first", null, "third"]);
    });

    it("can set array element to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "will-be-nulled" }));
      const beforeNull = root.children[0]!.name;

      root.children[0] = null;
      expect([beforeNull, root.children[0]]).to.have.ordered.members(["will-be-nulled", null]);
    });

    it("can set null element to non-null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      const wasNull = root.children[0];

      root.children[0] = new Item({ name: "was-null" });
      expect([wasNull, root.children[0]!.name]).to.have.ordered.members([null, "was-null"]);
    });

    it("handles splice with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(new Item({ name: "second" }));

      // Insert null in the middle
      root.children.splice(1, 0, null);

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
      ]).to.have.ordered.members([3, "first", null, "second"]);
    });

    it("handles unshift with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "existing" }));
      root.children.unshift(null);

      expect([root.children.length, root.children[0], root.children[1]!.name]).to.have.ordered.members([
        2,
        null,
        "existing",
      ]);
    });
  });

  describe("null entries in records", () => {
    it("can set null value in record - null is preserved as explicit value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["empty"] = null;
      // Null is an explicit "nothing" value, distinct from undefined (key deletion)
      expect("empty" in root.childRecord).to.eq(true);
      expect(root.childRecord["empty"]).to.eq(null);
    });

    it("setting to null preserves the key with null value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "will-be-nulled" });
      const beforeNull = root.childRecord["key"]!.name;

      root.childRecord["key"] = null;
      expect([beforeNull, "key" in root.childRecord, root.childRecord["key"]]).to.have.ordered.members([
        "will-be-nulled",
        true,
        null,
      ]);
    });

    it("setting to undefined removes the key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "will-be-removed" });
      const beforeRemove = "key" in root.childRecord;

      // @ts-expect-error - undefined is used for deletion, not as a stored value
      root.childRecord["key"] = undefined;
      expect([beforeRemove, "key" in root.childRecord]).to.have.ordered.members([true, false]);
    });

    it("delete removes key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "to-delete" });
      const beforeDelete = "key" in root.childRecord;

      delete root.childRecord["key"];
      expect([beforeDelete, "key" in root.childRecord]).to.have.ordered.members([true, false]);
    });
  });

  describe("null reactivity", () => {
    it("notifies when nullable field changes to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.nullableString = "initial";

      const notify = vi.fn();
      const dispose = reaction(() => root.nullableString, notify);

      root.nullableString = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies when nullable field changes from null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      const notify = vi.fn();
      const dispose = reaction(() => root.nullableString, notify);

      root.nullableString = "set-from-null";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies when nullable child cleared", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.nullableChild = new Item({ name: "test" });

      const notify = vi.fn();
      const dispose = reaction(() => root.nullableChild, notify);

      root.nullableChild = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies when array element set to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.children.push(new Item({ name: "test" }));

      const notify = vi.fn();
      const dispose = reaction(() => root.children[0], notify);

      root.children[0] = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("null edge cases", () => {
    it("handles multiple null entries in array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Multiple nulls are allowed (unlike child duplicates)
      root.children.push(null, null, null);
      expect([root.children.length, root.children.every((c) => c === null)]).to.have.ordered.members([3, true]);
    });

    it("can filter out nulls from array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }), null);
      root.children.push(new Item({ name: "third" }), null);

      const nonNull = root.children.filter((c): c is Item => c !== null);
      expect([nonNull.length, nonNull[0].name, nonNull[1].name]).to.have.ordered.members([2, "first", "third"]);
    });

    it("assigns array with mixed null values", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const item1 = new Item({ name: "a" });
      const item2 = new Item({ name: "b" });

      (root.children as any).assign([item1, null, item2, null]);

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
        root.children[3],
      ]).to.have.ordered.members([4, "a", null, "b", null]);
    });
  });

  describe("null in primitive records", () => {
    it("stores null as explicit value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveRecord["key"] = null;
      expect("key" in root.primitiveRecord).to.eq(true);
      expect(root.primitiveRecord["key"]).to.eq(null);
    });

    it("distinguishes null from missing key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveRecord["present"] = null;
      expect(["present" in root.primitiveRecord, "absent" in root.primitiveRecord]).to.have.ordered.members([
        true,
        false,
      ]);
    });

    it("can transition: value → null → value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveRecord["key"] = "hello";
      const first = root.primitiveRecord["key"];

      root.primitiveRecord["key"] = null;
      const second = root.primitiveRecord["key"];

      root.primitiveRecord["key"] = "world";
      const third = root.primitiveRecord["key"];

      expect([first, second, third]).to.have.ordered.members(["hello", null, "world"]);
    });
  });

  describe("null in maps", () => {
    it("stores null as explicit value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveMap.set("key", null);
      expect([root.primitiveMap.has("key"), root.primitiveMap.get("key")]).to.have.ordered.members([true, null]);
    });

    it("distinguishes null from missing key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveMap.set("present", null);
      expect([root.primitiveMap.has("present"), root.primitiveMap.has("absent")]).to.have.ordered.members([
        true,
        false,
      ]);
    });

    it("can transition: value → null → value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveMap.set("key", 42);
      const first = root.primitiveMap.get("key");

      root.primitiveMap.set("key", null);
      const second = root.primitiveMap.get("key");

      root.primitiveMap.set("key", 99);
      const third = root.primitiveMap.get("key");

      expect([first, second, third]).to.have.ordered.members([42, null, 99]);
    });

    it("counts null values in size", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveMap.set("a", 1);
      root.primitiveMap.set("b", null);
      root.primitiveMap.set("c", 3);

      expect(root.primitiveMap.size).to.eq(3);
    });
  });

  describe("null in sets", () => {
    it("can add null to set", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveSet.add(null);
      expect([root.primitiveSet.has(null), root.primitiveSet.size]).to.have.ordered.members([true, 1]);
    });

    it("can have mixed null and non-null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveSet.add("hello");
      root.primitiveSet.add(null);
      root.primitiveSet.add("world");

      expect([
        root.primitiveSet.size,
        root.primitiveSet.has(null),
        root.primitiveSet.has("hello"),
      ]).to.have.ordered.members([3, true, true]);
    });

    it("null is deduplicated like any other value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveSet.add(null);
      root.primitiveSet.add(null);

      expect(root.primitiveSet.size).to.eq(1);
    });

    it("can delete null from set", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.primitiveSet.add(null);
      const hadNull = root.primitiveSet.has(null);

      root.primitiveSet.delete(null);
      expect([hadNull, root.primitiveSet.has(null), root.primitiveSet.size]).to.have.ordered.members([true, false, 0]);
    });
  });
});
