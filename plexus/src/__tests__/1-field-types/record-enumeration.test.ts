/**
 * Record enumeration tests
 *
 * Tests for Object.keys(), Object.values(), Object.entries(),
 * for...in loops, spread operator, and other enumeration methods
 * on Plexus record fields.
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
  @syncing accessor value: number = 0;
}

@syncing("Container")
class Container extends PlexusModel<null> {
  @syncing.record accessor primitiveRecord: Record<string, string> = {};
  @syncing.child.record accessor childRecord: Record<string, Item> = {};
}

describe("Record Enumeration", () => {
  describe("Object.keys()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.keys(root.primitiveRecord)).to.deep.equal([]);
    });

    it("returns keys of primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "valueA";
      root.primitiveRecord["b"] = "valueB";
      root.primitiveRecord["c"] = "valueC";

      const keys = Object.keys(root.primitiveRecord);
      expect(keys).to.have.lengthOf(3).and.include.members(["a", "b", "c"]);
    });

    it("returns keys of child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["first"] = new Item({ name: "First" });
      root.childRecord["second"] = new Item({ name: "Second" });

      const keys = Object.keys(root.childRecord);
      expect(keys).to.have.lengthOf(2).and.include.members(["first", "second"]);
    });

    it("updates after adding keys", () => {
      const { root } = initTestPlexus(new Container());

      expect(Object.keys(root.primitiveRecord)).to.have.lengthOf(0);

      root.primitiveRecord["new"] = "value";
      expect(Object.keys(root.primitiveRecord)).to.have.lengthOf(1).and.include("new");
    });

    it("updates after removing keys", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["key"] = "value";
      expect(Object.keys(root.primitiveRecord)).to.include("key");

      delete root.primitiveRecord["key"];
      expect(Object.keys(root.primitiveRecord)).to.not.include("key");
    });
  });

  describe("Object.values()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.values(root.primitiveRecord)).to.deep.equal([]);
    });

    it("returns values of primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "alpha";
      root.primitiveRecord["b"] = "beta";

      const values = Object.values(root.primitiveRecord);
      expect(values).to.have.lengthOf(2).and.include.members(["alpha", "beta"]);
    });

    it("returns child instances from child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["one"] = new Item({ name: "One", value: 1 });
      root.childRecord["two"] = new Item({ name: "Two", value: 2 });

      const values = Object.values(root.childRecord);
      expect(values).to.have.lengthOf(2);
      expect(values.map((v) => v.name).sort()).to.have.ordered.members(["One", "Two"]);
    });
  });

  describe("Object.entries()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.entries(root.primitiveRecord)).to.deep.equal([]);
    });

    it("returns key-value pairs for primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["x"] = "X";
      root.primitiveRecord["y"] = "Y";

      const entries = Object.entries(root.primitiveRecord);
      expect(entries).to.have.lengthOf(2);

      const obj = Object.fromEntries(entries);
      expect(obj).to.deep.equal({ x: "X", y: "Y" });
    });

    it("returns key-child pairs for child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["item1"] = new Item({ name: "Item1" });
      root.childRecord["item2"] = new Item({ name: "Item2" });

      const entries = Object.entries(root.childRecord);
      expect(entries).to.have.lengthOf(2);

      expect(entries).to.satisfy((e: [string, Item][]) =>
        e.every(([key, value]) => typeof key === "string" && value instanceof Item),
      );
    });
  });

  describe("for...in enumeration", () => {
    it("iterates over empty record without iterations", () => {
      const { root } = initTestPlexus(new Container());
      const keys: string[] = [];

      for (const key in root.primitiveRecord) {
        keys.push(key);
      }

      expect(keys).to.have.lengthOf(0);
    });

    it("iterates over all keys in record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["first"] = "1";
      root.primitiveRecord["second"] = "2";
      root.primitiveRecord["third"] = "3";

      const keys: string[] = [];
      for (const key in root.primitiveRecord) {
        keys.push(key);
      }

      expect(keys).to.have.lengthOf(3).and.include.members(["first", "second", "third"]);
    });
  });

  describe("spread operator", () => {
    it("spreads empty record to empty object", () => {
      const { root } = initTestPlexus(new Container());
      const spread = { ...root.primitiveRecord };

      expect(Object.keys(spread)).to.have.lengthOf(0);
    });

    it("spreads record contents", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "A";
      root.primitiveRecord["b"] = "B";

      const spread = { ...root.primitiveRecord };
      expect(spread).to.deep.equal({ a: "A", b: "B" });
    });

    it("spreads child record with live references", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["item"] = new Item({ name: "Original" });

      const spread = { ...root.childRecord };
      expect(spread.item.name).to.equal("Original");

      // Changes to original reflect in spread (same reference)
      root.childRecord["item"].name = "Modified";
      expect(spread.item.name).to.equal("Modified");
    });
  });

  describe("Object.hasOwn / in operator", () => {
    it("returns false for non-existent key", () => {
      const { root } = initTestPlexus(new Container());

      expect([
        Object.hasOwn(root.primitiveRecord, "missing"),
        "missing" in root.primitiveRecord,
      ]).to.have.ordered.members([false, false]);
    });

    it("returns true for existing key", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["exists"] = "value";

      expect([Object.hasOwn(root.primitiveRecord, "exists"), "exists" in root.primitiveRecord]).to.have.ordered.members(
        [true, true],
      );
    });

    it("returns false after key deletion", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["temp"] = "temporary";
      expect("temp" in root.primitiveRecord).to.eq(true);

      delete root.primitiveRecord["temp"];
      expect("temp" in root.primitiveRecord).to.eq(false);
    });
  });

  describe("enumeration reactivity", () => {
    it("notifies when iterating keys and key added", () => {
      const { root } = initTestPlexus(new Container());
      root.primitiveRecord["initial"] = "value";

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.primitiveRecord), notify);

      root.primitiveRecord["new"] = "newValue";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies when iterating keys and key removed", () => {
      const { root } = initTestPlexus(new Container());
      root.primitiveRecord["toRemove"] = "value";

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.primitiveRecord), notify);

      delete root.primitiveRecord["toRemove"];
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies when using 'in' operator and key presence changes", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => "key" in root.primitiveRecord, notify);

      root.primitiveRecord["key"] = "value";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("edge cases", () => {
    it("handles numeric string keys", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["0"] = "zero";
      root.primitiveRecord["1"] = "one";
      root.primitiveRecord["100"] = "hundred";

      expect(Object.keys(root.primitiveRecord)).to.include.members(["0", "1", "100"]);
    });

    it("handles keys with special characters", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["with-dash"] = "dash";
      root.primitiveRecord["with.dot"] = "dot";
      root.primitiveRecord["with_underscore"] = "underscore";

      const keys = Object.keys(root.primitiveRecord);
      expect(keys).to.include.members(["with-dash", "with.dot", "with_underscore"]);
    });

    it("preserves key order (insertion order)", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["z"] = "last";
      root.primitiveRecord["a"] = "first";
      root.primitiveRecord["m"] = "middle";

      const keys = Object.keys(root.primitiveRecord);
      // JavaScript objects maintain insertion order for string keys
      expect(keys).to.have.ordered.members(["z", "a", "m"]);
    });
  });

  describe("State consistency on failed adoption", () => {
    // These tests ensure that when adoption validation fails (e.g., cycle detection),
    // no state changes have occurred - the operation should be atomic (all-or-nothing).

    @syncing("RecordTreeNode")
    class RecordTreeNode extends PlexusModel {
      @syncing accessor name!: string;
      @syncing.child.record accessor children!: Record<string, RecordTreeNode>;
    }

    it("set: should not orphan existing value when replacement adoption fails", () => {
      // Create hierarchy: root -> child -> grandchild -> existing
      const existing = new RecordTreeNode({ name: "existing", children: {} });
      const grandchild = new RecordTreeNode({ name: "grandchild", children: { existing } });
      const child = new RecordTreeNode({ name: "child", children: { grandchild } });
      const rootNode = new RecordTreeNode({ name: "root", children: { child } });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children["child"];
      const grandchildNode = childNode.children["grandchild"];
      const existingNode = grandchildNode.children["existing"];

      // grandchild tries to replace "existing" with childNode (its ancestor) - would create cycle
      expect(() => {
        grandchildNode.children["existing"] = childNode;
      }).to.throw(/would create cycle/i);

      // Original value should still be properly parented
      expect([existingNode.parent, grandchildNode.children["existing"], childNode.parent]).to.have.ordered.members([
        grandchildNode,
        existingNode,
        root,
      ]);
    });

    it("set: should not orphan existing value when new key adoption fails", () => {
      // Create hierarchy: root -> child -> grandchild
      const grandchild = new RecordTreeNode({ name: "grandchild", children: {} });
      const child = new RecordTreeNode({ name: "child", children: { grandchild } });
      const rootNode = new RecordTreeNode({ name: "root", children: { child } });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children["child"];
      const grandchildNode = childNode.children["grandchild"];

      // grandchild tries to add childNode (its ancestor) as new key - would create cycle
      expect(() => {
        grandchildNode.children["newKey"] = childNode;
      }).to.throw(/would create cycle/i);

      // grandchild's children should be unchanged (no "newKey")
      expect(Object.keys(grandchildNode.children)).to.deep.equal([]);
      expect(childNode.parent).to.equal(root);
    });

    it("assign: should not orphan existing items when new items adoption fails", () => {
      // Create hierarchy: root -> child -> grandchild -> [item1, item2]
      const item1 = new RecordTreeNode({ name: "item1", children: {} });
      const item2 = new RecordTreeNode({ name: "item2", children: {} });
      const grandchild = new RecordTreeNode({ name: "grandchild", children: { item1, item2 } });
      const child = new RecordTreeNode({ name: "child", children: { grandchild } });
      const rootNode = new RecordTreeNode({ name: "root", children: { child } });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children["child"];
      const grandchildNode = childNode.children["grandchild"];
      const item1Node = grandchildNode.children["item1"];
      const item2Node = grandchildNode.children["item2"];
      const newItem = new RecordTreeNode({ name: "new", children: {} });

      // grandchild tries to assign including child (its ancestor) - would create cycle
      expect(() => {
        grandchildNode.children = { newItem, badItem: childNode };
      }).to.throw(/would create cycle/i);

      // Original items should still be properly parented
      expect([
        item1Node.parent,
        item2Node.parent,
        grandchildNode.children["item1"],
        grandchildNode.children["item2"],
        newItem.parent,
        childNode.parent,
      ]).to.have.ordered.members([grandchildNode, grandchildNode, item1Node, item2Node, null, root]);
      expect(Object.keys(grandchildNode.children).sort()).to.have.ordered.members(["item1", "item2"]);
    });

    it("assign: should preserve state when valid item in batch but invalid item throws", () => {
      // This tests that even if some items are valid, if one fails, none should be added
      const grandchild = new RecordTreeNode({ name: "grandchild", children: {} });
      const child = new RecordTreeNode({ name: "child", children: { grandchild } });
      const rootNode = new RecordTreeNode({ name: "root", children: { child } });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children["child"];
      const grandchildNode = childNode.children["grandchild"];
      const validItem = new RecordTreeNode({ name: "valid", children: {} });

      // Try to assign one valid item and one invalid (ancestor)
      expect(() => {
        grandchildNode.children = { valid: validItem, invalid: childNode };
      }).to.throw(/would create cycle/i);

      // Neither item should have been added
      expect([Object.keys(grandchildNode.children), validItem.parent, childNode.parent]).to.deep.equal([
        [],
        null,
        root,
      ]);
    });
  });
});
