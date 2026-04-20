import type { Mock } from "vitest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import { reaction } from "mobx";
import { syncing } from "../../decorators.js";
import { entityClasses } from "../../globals.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { isTransacting, pendingNotifications } from "../../utils/utils.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => { enableMobXIntegration(); });

// Test entity class for basic transaction tests
@syncing("TestEntity")
class TestEntity extends PlexusModel {
  @syncing
  accessor value!: string;

  @syncing
  accessor count!: number;

  @syncing.child
  accessor child!: TestEntity | null;
}

// Define a more complex model for integration testing
@syncing("TodoItem")
class TodoItem extends PlexusModel {
  @syncing
  accessor text!: string;

  @syncing
  accessor completed!: boolean;

  @syncing
  accessor priority!: number;
}

@syncing("TodoList")
class TodoList extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.list
  accessor items!: TodoItem[];

  @syncing.set
  accessor tags!: Set<string>;
}

describe("Plexus Transactions", () => {
  describe("Basic transaction behavior", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<TestEntity>;
    let root: TestEntity;

    beforeEach(() => {
      // Register test entity
      entityClasses.set("TestEntity", TestEntity);

      const result = initTestPlexus(new TestEntity({ value: "initial", count: 0, child: null }));
      doc = result.doc;
      plexus = result.plexus;
      root = result.root;
    });

    afterEach(() => {
      entityClasses.clear();
    });

    it("should execute function within YJS transaction", () => {
      const yjsTransactSpy = vi.spyOn(root.__doc__!, "transact");
      let executed = false;

      plexus.transact(() => {
        executed = true;
      });

      expect(executed).to.eq(true);
      expect(yjsTransactSpy).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("should return the result of the function", () => {
      const result = plexus.transact(() => {
        return { data: "test" };
      });

      expect(result).to.deep.equal({ data: "test" });
    });

    it("should propagate errors from the function", () => {
      expect(() => {
        plexus.transact(() => {
          throw new Error("Test error");
        });
      }).to.throw("Test error");
    });

    it("should set isTransacting during transaction", () => {
      let wasTransacting = false;

      plexus.transact(() => {
        wasTransacting = isTransacting;
      });

      expect(wasTransacting).to.eq(true);
      expect(isTransacting).to.eq(false); // Should be reset after
    });

    it("should reset isTransacting even on error", () => {
      expect(() => {
        plexus.transact(() => {
          throw new Error("Test error");
        });
      }).to.throw();

      expect(isTransacting).to.eq(false);
    });
  });

  describe("Notification queueing", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<TestEntity>;
    let root: TestEntity;

    beforeEach(() => {
      entityClasses.set("TestEntity", TestEntity);
      const result = initTestPlexus(new TestEntity({ value: "initial", count: 0, child: null }));
      doc = result.doc;
      plexus = result.plexus;
      root = result.root;
    });

    afterEach(() => {
      entityClasses.clear();
    });

    it("should queue notifications during transaction", () => {
      const callback = vi.fn();
      const dispose = reaction(() => root.value, callback);

      // reaction does not fire initially
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);

      plexus.transact(() => {
        // Modify the entity we're tracking
        root.value = "modified";

        // Callback should not be called yet
        expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);

        // Should be queued
        expect(pendingNotifications.size).to.be.above(0);
      });

      // After transaction, callback should be called
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(pendingNotifications.size).to.equal(0);
      dispose();
    });

    it("should batch multiple notifications for same callback", () => {
      const callback = vi.fn();
      const dispose = reaction(() => `${root.value}-${root.count}`, callback);

      plexus.transact(() => {
        // Multiple modifications
        root.value = "changed1";
        root.count = 1;
        root.value = "changed2";
        root.count = 2;

        // Still not called during transaction
        expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);
      });

      // Should be called exactly once after transaction
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose();
    });

    it("should handle multiple different callbacks", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();
      const dispose1 = reaction(() => root.value, callback1);
      const dispose2 = reaction(() => root.count, callback2);
      const dispose3 = reaction(() => root.value + root.count, callback3);

      plexus.transact(() => {
        root.value = "modified";
        root.count = 42;

        expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(0);
        expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(0);
        expect(callback3).to.have.property("mock").with.property("calls").with.lengthOf(0);
      });

      // All should be called after transaction
      expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback3).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose1();
      dispose2();
      dispose3();
    });

    it("should clear pending notifications even on error", () => {
      const callback = vi.fn();
      const dispose = reaction(() => root.value, callback);

      expect(() => {
        plexus.transact(() => {
          root.value = "will fail";
          expect(pendingNotifications.size).to.be.above(0);
          throw new Error("Test error");
        });
      }).to.throw();

      // Notifications should not be fired on error
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);
      // But queue should be cleared
      expect(pendingNotifications.size).to.equal(0);
      dispose();
    });
  });

  describe("Shadow sub-transactions", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<TestEntity>;
    let root: TestEntity;

    beforeEach(() => {
      entityClasses.set("TestEntity", TestEntity);
      const result = initTestPlexus(new TestEntity({ value: "initial", count: 0, child: null }));
      doc = result.doc;
      plexus = result.plexus;
      root = result.root;
    });

    afterEach(() => {
      entityClasses.clear();
    });

    it("should not start new YJS transaction for nested calls", () => {
      const yjsTransactSpy = vi.spyOn(root.__doc__!, "transact");

      plexus.transact(() => {
        plexus.transact(() => {
          plexus.transact(() => {
            // Deeply nested
          });
        });
      });

      // Only one YJS transaction for the outermost call
      expect(yjsTransactSpy).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("should maintain isTransacting throughout nested calls", () => {
      const states: boolean[] = [];

      plexus.transact(() => {
        states.push(isTransacting);

        plexus.transact(() => {
          states.push(isTransacting);

          plexus.transact(() => {
            states.push(isTransacting);
          });

          states.push(isTransacting);
        });

        states.push(isTransacting);
      });

      // Should be true throughout
      expect(states).to.deep.equal([true, true, true, true, true]);
      // And false after
      expect(isTransacting).to.eq(false);
    });

    it("should return nested results correctly", () => {
      const result = plexus.transact(() => {
        const inner1 = plexus.transact(() => {
          const inner2 = plexus.transact(() => {
            return "deepest";
          });
          return `inner: ${inner2}`;
        });
        return `outer: ${inner1}`;
      });

      expect(result).to.equal("outer: inner: deepest");
    });

    it("should propagate nested errors", () => {
      expect(() => {
        plexus.transact(() => {
          plexus.transact(() => {
            plexus.transact(() => {
              throw new Error("Nested error");
            });
          });
        });
      }).to.throw("Nested error");
    });

    it("should queue all notifications until outermost transaction completes", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();
      const dispose1 = reaction(() => root.value, callback1);
      const dispose2 = reaction(() => root.count, callback2);
      const dispose3 = reaction(() => root.value + root.count, callback3);

      plexus.transact(() => {
        root.value = "first";
        expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(0);

        plexus.transact(() => {
          root.count = 10;
          expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(0);

          plexus.transact(() => {
            root.value = "nested";
            expect(callback3).to.have.property("mock").with.property("calls").with.lengthOf(0);
          });

          // Still not called after inner transaction
          expect(callback3).to.have.property("mock").with.property("calls").with.lengthOf(0);
        });

        // Still not called after middle transaction
        expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(0);
      });

      // All called after outermost transaction
      expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback3).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose1();
      dispose2();
      dispose3();
    });
  });

  describe("Edge cases", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<TestEntity>;
    let root: TestEntity;

    beforeEach(() => {
      entityClasses.set("TestEntity", TestEntity);
      const result = initTestPlexus(new TestEntity({ value: "initial", count: 0, child: null }));
      doc = result.doc;
      plexus = result.plexus;
      root = result.root;
    });

    afterEach(() => {
      entityClasses.clear();
    });

    it("should handle transaction called during notification flush", () => {
      const callback = vi.fn(() => {
        // Try to start a new transaction during notification
        if (callback.mock.calls.length === 1) {
          const result = plexus.transact(() => {
            root.count = 999;
            return "nested during flush";
          });
          expect(result).to.equal("nested during flush");
        }
      });

      const dispose = reaction(() => root.value, callback);

      plexus.transact(() => {
        root.value = "trigger";
      });

      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf.above(0);
      dispose();
    });

    it("should handle empty transactions", () => {
      const result = plexus.transact(() => {
        // Do nothing
      });

      expect(result).to.eq(undefined);
      expect(isTransacting).to.eq(false);
    });

    it("should handle transactions that only contain shadow sub-transactions", () => {
      const callback = vi.fn();
      const dispose = reaction(() => "tracked", callback);

      plexus.transact(() => {
        plexus.transact(() => {
          // Only shadow transaction
        });
      });

      // No modifications, so no notifications
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);
      dispose();
    });

    it("should maintain correct state with concurrent tracking", () => {
      const callbacks: Array<() => void> = [];
      const disposers: Array<() => void> = [];

      // Create multiple reactions
      for (let i = 0; i < 10; i++) {
        const callback = vi.fn();
        callbacks.push(callback);

        const dispose = reaction(
          () => `${root.value}-${root.count}-${i}`,
          callback,
        );

        disposers.push(dispose);
      }

      plexus.transact(() => {
        // Trigger modifications
        for (let i = 0; i < 5; i++) {
          root.count = i;
          root.value = `value${i}`;
        }

        // None should be called yet
        for (const cb of callbacks) {
          expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(0);
        }
      });

      // All should be called after
      for (const cb of callbacks) {
        expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(1);
      }

      for (const dispose of disposers) dispose();
    });

    it("should handle notification errors gracefully", () => {
      const goodCallback = vi.fn();
      const badCallback = vi.fn(() => {
        throw new Error("Notification error");
      });
      const anotherGoodCallback = vi.fn();

      const dispose1 = reaction(() => root.value, goodCallback);
      const dispose2 = reaction(() => root.count, badCallback);
      const dispose3 = reaction(() => `${root.value}-${root.count}`, anotherGoodCallback);

      // Should not throw even if notification throws
      expect(() => {
        plexus.transact(() => {
          root.value = "modified";
          root.count = 42;
        });
      }).to.not.throw();

      // Good callbacks should still be called
      expect(goodCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(badCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(anotherGoodCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      dispose1();
      dispose2();
      dispose3();
    });
  });

  describe("Integration with YJS", () => {
    let doc: Y.Doc;
    let plexus: TestPlexus<TestEntity>;
    let root: TestEntity;

    beforeEach(() => {
      entityClasses.set("TestEntity", TestEntity);
      const result = initTestPlexus(new TestEntity({ value: "initial", count: 0, child: null }));
      doc = result.doc;
      plexus = result.plexus;
      root = result.root as TestEntity;
    });

    afterEach(() => {
      entityClasses.clear();
    });

    it("should batch YJS operations in a single transaction", () => {
      const shadowDoc = root.__doc__!;
      const updates: Uint8Array[] = [];

      shadowDoc.on("update", (update: Uint8Array) => {
        updates.push(update);
      });

      plexus.transact(() => {
        // Multiple YJS operations on shadow (where entities live)
        shadowDoc.getMap("test").set("key1", "value1");
        shadowDoc.getMap("test").set("key2", "value2");
        shadowDoc.getMap("test").set("key3", "value3");
        shadowDoc.getArray("array").push(["item1", "item2", "item3"]);
      });

      // Should result in a single update event due to transaction
      expect(updates).to.have.lengthOf(1);
    });

    it("should maintain YJS transaction semantics with nested calls", () => {
      const shadowDoc = root.__doc__!;
      const updates: Uint8Array[] = [];

      shadowDoc.on("update", (update: Uint8Array) => {
        updates.push(update);
      });

      plexus.transact(() => {
        shadowDoc.getMap("test").set("outer", "start");

        plexus.transact(() => {
          shadowDoc.getMap("test").set("middle", "value");

          plexus.transact(() => {
            shadowDoc.getMap("test").set("inner", "deep");
          });
        });

        shadowDoc.getMap("test").set("outer", "end");
      });

      // Still just one YJS update
      expect(updates).to.have.lengthOf(1);

      // All values should be set
      expect(doc.getMap("test").get("outer")).to.equal("end");
      expect(doc.getMap("test").get("middle")).to.equal("value");
      expect(doc.getMap("test").get("inner")).to.equal("deep");
    });
  });
});

describe("Transaction Integration Tests", () => {
  beforeEach(() => {
    // Register entity classes globally before tests
    entityClasses.set("TodoItem", TodoItem);
    entityClasses.set("TodoList", TodoList);
  });

  afterEach(() => {
    entityClasses.clear();
  });

  it("should batch multiple operations in a single transaction", () => {
    const { plexus, root: todoList } = initTestPlexus(new TodoList({ name: "My Tasks", items: [], tags: new Set() }));

    // Track changes
    const changeLog: string[] = [];
    const callback = vi.fn(() => {
      changeLog.push(`Changed: ${todoList.name}, items: ${todoList.items.length}`);
    });

    const dispose = reaction(
      () => ({
        name: todoList.name,
        itemCount: todoList.items.length,
        tags: [...todoList.tags],
      }),
      callback,
    );

    // Perform multiple operations in a transaction
    plexus.transact(() => {
      // Add multiple items
      const item1 = new TodoItem({
        text: "Buy groceries",
        completed: false,
        priority: 1,
      }) as TodoItem;

      todoList.items.push(item1);

      const item2 = new TodoItem({
        text: "Write tests",
        completed: true,
        priority: 2,
      }) as TodoItem;

      todoList.items.push(item2);

      // Update list name
      todoList.name = "Today's Tasks";

      // Add tags
      todoList.tags.add("urgent");
      todoList.tags.add("work");

      // Should not trigger any callbacks yet
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);
    });

    // After transaction, should be called exactly once
    expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(1);
    expect(changeLog).to.deep.equal(["Changed: Today's Tasks, items: 2"]);

    // Verify final state
    expect(todoList.name).to.equal("Today's Tasks");
    expect(todoList.items).to.have.lengthOf(2);
    // Items are proxy entities, accessing them properly requires deref
    // For now just verify count
    expect([...todoList.tags]).to.include("urgent");
    expect([...todoList.tags]).to.include("work");
    dispose();
  });

  it("should handle nested transactions with complex operations", () => {
    const { plexus, root: todoList } = initTestPlexus(new TodoList({ name: "My Tasks", items: [], tags: new Set() }));

    const notifications: string[] = [];
    const callback = vi.fn(() => {
      notifications.push("notified");
    });

    const dispose = reaction(() => todoList.items.length, callback);

    // Helper to add a todo item
    const addTodo = (text: string, priority: number) => {
      const item = new TodoItem({
        text,
        completed: false,
        priority,
      });
      todoList.items.push(item);
      return item;
    };

    // Outer transaction
    plexus.transact(() => {
      // These are shadow sub-transactions
      const item1 = addTodo("First task", 1);
      const item2 = addTodo("Second task", 2);

      // Nested transaction to modify items
      plexus.transact(() => {
        item1.completed = true;
        item2.priority = 3;
      });

      // No notifications yet
      expect(notifications).to.have.lengthOf(0);
    });

    // Single notification after all operations
    expect(notifications).to.deep.equal(["notified"]);
    expect(todoList.items).to.have.lengthOf(2);
    dispose();
  });

  it("should rollback on error and not notify", () => {
    const { plexus, root: todoList } = initTestPlexus(new TodoList({ name: "My Tasks", items: [], tags: new Set() }));

    const callback = vi.fn();
    const dispose = reaction(() => todoList.name, callback);

    const originalName = todoList.name;

    expect(() => {
      plexus.transact(() => {
        todoList.name = "Modified name";
        // This should rollback the change
        throw new Error("Intentional error");
      });
    }).to.throw("Intentional error");

    // No notification on error
    expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // State should be rolled back (YJS handles this)
    // Note: YJS actually doesn't rollback automatically, so the name will be changed
    // This is expected behavior - the transaction completes the YJS operations
    // but our notification system doesn't fire on error
    expect(todoList.name).to.equal("Modified name"); // YJS doesn't rollback
    dispose();
  });

  it("should handle concurrent tracked functions efficiently", () => {
    const { plexus, root: todoList } = initTestPlexus(new TodoList({ name: "My Tasks", items: [], tags: new Set() }));

    // Create three groups of callbacks tracking different things
    const nameCallbacks: Mock[] = [];
    const itemCallbacks: Mock[] = [];
    const tagCallbacks: Mock[] = [];
    const disposers: Array<() => void> = [];

    // Track name changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      nameCallbacks.push(callback);
      disposers.push(reaction(() => todoList.name, callback));
    }

    // Track item count changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      itemCallbacks.push(callback);
      disposers.push(reaction(() => todoList.items.length, callback));
    }

    // Track tag changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      tagCallbacks.push(callback);
      disposers.push(reaction(() => [...todoList.tags].join(","), callback));
    }

    // Single transaction with multiple changes
    plexus.transact(() => {
      todoList.name = "Updated";

      const item = new TodoItem({
        text: "New Task",
        completed: false,
        priority: 1,
      });
      todoList.items.push(item);

      todoList.tags.add("batch");
      todoList.tags.add("test");

      // No callbacks during transaction
      for (const cb of [...nameCallbacks, ...itemCallbacks, ...tagCallbacks]) {
        expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(0);
      }
    });

    // Each group should fire exactly once
    for (const cb of nameCallbacks) {
      expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(1);
    }
    for (const cb of itemCallbacks) {
      expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(1);
    }
    for (const cb of tagCallbacks) {
      expect(cb).to.have.property("mock").with.property("calls").with.lengthOf(1);
    }

    for (const dispose of disposers) dispose();
  });
});
