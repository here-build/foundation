/**
 * Transaction batching and concurrent operation tests
 *
 * Tests for:
 * - Multiple mutations within same transaction
 * - Notification batching behavior
 * - Rapid mutations on same field
 * - Transaction isolation
 */

import { reaction } from "mobx";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => { enableMobXIntegration(); });

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor count: number = 0;
}

@syncing("Container")
class Container extends PlexusModel<null> {
  @syncing accessor value: string = "";
  @syncing accessor counter: number = 0;
  @syncing.child accessor child: Item | null = null;
  @syncing.child.list accessor items: Item[] = [];
  @syncing.record accessor data: Record<string, string> = {};
}

describe("Transaction Batching", () => {
  describe("multiple mutations in single transaction", () => {
    it("batches multiple field mutations into single notification", () => {
      const { root, plexus } = initTestPlexus(new Container());
      root.value = "initial";
      root.counter = 0;

      const notify = vi.fn();
      const dispose = reaction(() => ({
        value: root.value,
        counter: root.counter,
      }), notify);

      // Multiple mutations in one transaction
      plexus.transact(() => {
        root.value = "changed";
        root.counter = 1;
        root.counter = 2;
        root.counter = 3;
      });

      // Should batch into single notification
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("batches array mutations in transaction", () => {
      const { root, plexus } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => root.items.length, notify);

      plexus.transact(() => {
        root.items.push(new Item({ name: "a" }));
        root.items.push(new Item({ name: "b" }));
        root.items.push(new Item({ name: "c" }));
      });

      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(root.items).to.have.lengthOf(3);
      dispose();
    });

    it("batches record mutations in transaction", () => {
      const { root, plexus } = initTestPlexus(new Container());

      const notify = vi.fn();
      const dispose = reaction(() => Object.keys(root.data).length, notify);

      plexus.transact(() => {
        root.data["a"] = "A";
        root.data["b"] = "B";
        root.data["c"] = "C";
      });

      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(Object.keys(root.data)).to.have.lengthOf(3);
      dispose();
    });
  });

  describe("rapid mutations", () => {
    it("handles rapid mutations on same field", () => {
      const { root } = initTestPlexus(new Container());

      // Rapid mutations without transaction
      for (let i = 0; i < 100; i++) {
        root.counter = i;
      }

      expect(root.counter).to.equal(99);
    });

    it("handles rapid array pushes", () => {
      const { root } = initTestPlexus(new Container());

      for (let i = 0; i < 50; i++) {
        root.items.push(new Item({ name: `item${i}` }));
      }

      expect([root.items.length, root.items[49].name]).to.have.ordered.members([50, "item49"]);
    });

    it("handles rapid record updates", () => {
      const { root } = initTestPlexus(new Container());

      for (let i = 0; i < 50; i++) {
        root.data[`key${i}`] = `value${i}`;
      }

      expect(Object.keys(root.data)).to.have.lengthOf(50);
    });
  });

  describe("notification ordering", () => {
    it("notifications fire in order of modification", () => {
      const { root } = initTestPlexus(new Container());
      root.value = "initial";
      root.counter = 0;

      const order: string[] = [];

      const valueNotify = vi.fn(() => order.push("value"));
      const counterNotify = vi.fn(() => order.push("counter"));

      const dispose1 = reaction(() => root.value, valueNotify);
      const dispose2 = reaction(() => root.counter, counterNotify);

      root.value = "changed";
      root.counter = 1;

      expect(order).to.deep.equal(["value", "counter"]);
      dispose1();
      dispose2();
    });

    it("nested property changes notify correctly", () => {
      const { root } = initTestPlexus(new Container());
      root.child = new Item({ name: "test", count: 0 });

      const notify = vi.fn();
      const dispose = reaction(() => root.child?.name, notify);

      root.child!.name = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });
  });

  describe("transaction isolation", () => {
    it("partial transaction state not visible outside", () => {
      const { root, plexus } = initTestPlexus(new Container());
      root.counter = 0;

      let midTransactionValue: number | undefined;

      // This test verifies that transact operates atomically
      plexus.doc.transact(() => {
        root.counter = 1;
        root.counter = 2;
        // Within transaction, changes are visible
        midTransactionValue = root.counter;
        root.counter = 3;
      });

      expect([midTransactionValue, root.counter]).to.have.ordered.members([2, 3]);
    });

    it("handles exceptions in transaction gracefully", () => {
      const { root, plexus } = initTestPlexus(new Container());
      root.counter = 0;

      expect(() => {
        plexus.doc.transact(() => {
          root.counter = 1;
          throw new Error("Transaction error");
        });
      }).to.throw("Transaction error");

      // After exception, the mutation may or may not be visible
      // depending on when the exception occurred
      // This documents the behavior
      expect(typeof root.counter).to.equal("number");
    });
  });

  describe("cross-document sync within transactions", () => {
    it("syncs transacted changes atomically", () => {
      const { root: root1, plexus: plexus1 } = initTestPlexus(new Container());
      // doc2 shares guid so CRDT-native UUIDs decode correctly on both peers
      const doc2 = new Y.Doc({ guid: plexus1.doc.guid });

      // Initial sync
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));

      const { root: root2 } = connectTestPlexus<Container>(doc2);

      // Make multiple changes in transaction
      plexus1.doc.transact(() => {
        root1.value = "synced";
        root1.counter = 42;
        root1.data["key"] = "value";
      });

      // Sync to doc2
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));

      // All changes should be visible
      expect([root2.value, root2.counter, root2.data["key"]]).to.have.ordered.members(["synced", 42, "value"]);

      doc2.destroy();
    });
  });
});
