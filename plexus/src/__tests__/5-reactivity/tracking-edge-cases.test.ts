/**
 * Tracking edge cases - tests for potential gaps in modification notifications
 *
 * These tests document expected behavior for edge cases in the tracking system.
 * Some tests may fail initially to identify bugs.
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

@syncing("Container")
class Container extends PlexusModel<null> {
  @syncing.map accessor map: Map<string, string> = new Map();
  @syncing.child.list accessor items: Item[] = [];
  @syncing.record accessor record: Record<string, string> = {};
}

describe("Tracking Edge Cases", () => {
  describe("Map.values() tracking", () => {
    it("notifies values() subscribers when existing value is updated", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const dispose = reaction(() => [...root.map.values()], notify);

      // Modifying existing key's value should notify values() subscribers
      root.map.set("key", "updated");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies values() subscribers when new key-value added", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("existing", "value");

      const notify = vi.fn();
      const dispose = reaction(() => [...root.map.values()], notify);

      root.map.set("new", "newValue");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies values() subscribers when value is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const dispose = reaction(() => [...root.map.values()], notify);

      root.map.delete("key");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("Array length tracking with index assignment", () => {
    it("notifies length subscribers when array extended via index assignment", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => root.items.length, notify);

      // Extending array via index assignment should notify length subscribers
      root.items[0] = new Item({ name: "first" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies length subscribers when array extended with gaps", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => root.items.length, notify);

      // Creating sparse array via index should notify
      root.items[5] = new Item({ name: "at-five" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("does NOT notify length subscribers when replacing existing element", () => {
      const { root } = initTestPlexus(new Container());
      root.items.push(new Item({ name: "initial" }));

      const notify = vi.fn();
      const dispose = reaction(() => root.items.length, notify);

      // Replacing existing element should NOT notify length (length unchanged)
      root.items[0] = new Item({ name: "replaced" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });
  });

  describe("Record enumeration tracking", () => {
    it("notifies Object.keys() subscribers when key added", () => {
      const { root } = initTestPlexus(new Container());
      root.record["existing"] = "value";

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.record), notify);

      root.record["new"] = "newValue";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies Object.values() subscribers when value changed", () => {
      const { root } = initTestPlexus(new Container());
      root.record["key"] = "initial";

      const notify = vi.fn();
      const dispose = reaction(() => Object.values(root.record), notify);

      root.record["key"] = "updated";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies Object.keys() subscribers when key removed", () => {
      const { root } = initTestPlexus(new Container());
      root.record["key"] = "value";

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.record), notify);

      delete root.record["key"];
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("Map.get() specific key tracking", () => {
    it("notifies get(key) subscribers when that specific key changes", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("tracked", "initial");
      root.map.set("other", "otherValue");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.get("tracked"), notify);

      // Only the tracked key should trigger notification
      root.map.set("tracked", "updated");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("does NOT notify get(key) subscribers when different key changes", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("tracked", "initial");
      root.map.set("other", "otherValue");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.get("tracked"), notify);

      // Changing a different key should NOT notify
      root.map.set("other", "updated");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });
  });

  describe("Map.has() tracking", () => {
    it("notifies has() subscribers when key is added", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => root.map.has("key"), notify);

      root.map.set("key", "value");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies has() subscribers when key is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.has("key"), notify);

      root.map.delete("key");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("does NOT notify has() subscribers when value changes (key still exists)", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.has("key"), notify);

      // Value change should NOT notify has() (key presence unchanged)
      root.map.set("key", "updated");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });
  });

  describe("Array Object.keys() tracking", () => {
    it("does NOT notify Object.keys() subscribers when replacing existing element", () => {
      const { root } = initTestPlexus(new Container());
      root.items.push(new Item({ name: "initial" }));

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.items), notify);

      // Replacing existing element should NOT notify Object.keys() (keys unchanged)
      root.items[0] = new Item({ name: "replaced" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });

    it("notifies Object.keys() subscribers when array length changes via push", () => {
      const { root } = initTestPlexus(new Container());
      root.items.push(new Item({ name: "first" }));

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.items), notify);

      root.items.push(new Item({ name: "second" }));
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies Object.keys() subscribers when array length changes via pop", () => {
      const { root } = initTestPlexus(new Container());
      root.items.push(new Item({ name: "first" }));
      root.items.push(new Item({ name: "second" }));

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.items), notify);

      root.items.pop();
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("Record Object.keys() tracking (value-only changes)", () => {
    it("does NOT notify Object.keys() subscribers when existing value changes", () => {
      const { root } = initTestPlexus(new Container());
      root.record["key"] = "initial";

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.record), notify);

      // Value-only change should NOT notify Object.keys() (keys unchanged)
      root.record["key"] = "updated";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });
  });

  describe("Map.size tracking", () => {
    it("notifies size subscribers when key is added", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => root.map.size, notify);

      root.map.set("key", "value");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("notifies size subscribers when key is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.size, notify);

      root.map.delete("key");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("does NOT notify size subscribers when value changes (size unchanged)", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const dispose = reaction(() => root.map.size, notify);

      // Value change should NOT notify size (size unchanged)
      root.map.set("key", "updated");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });
  });
});
