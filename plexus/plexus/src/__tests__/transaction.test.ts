import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Plexus } from "../Plexus";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { createTrackedFunction } from "../tracking";
import { isTransacting, pendingNotifications } from "../utils";
import { entityClasses } from "../globals";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

// Test entity class
@syncing
class TestEntity extends PlexusModel {
  @syncing
  accessor value!: string;

  @syncing
  accessor count!: number;

  @syncing.child
  accessor child!: TestEntity | null;
}

// Test Plexus implementation
class TestPlexus extends Plexus<TestEntity> {
  constructor(doc: Y.Doc, autoSetupRoot = true) {
    // Set up root data before calling super to avoid loadRoot errors
    if (autoSetupRoot) {
      const models = doc.getMap(YJS_GLOBALS.models);
      const rootModel = new Y.Map();
      rootModel.set(YJS_GLOBALS.modelMetadataType, "TestEntity");
      rootModel.set("value", "initial");
      rootModel.set("count", 0);
      rootModel.set("child", null);
      models.set("root", rootModel);
      TestPlexus.rootSetup = true;
    }

    super(doc);
  }

  protected createDefaultRoot(): TestEntity {
    return new TestEntity({ value: "default", count: 0, child: null });
  }

  async fetchDependency(): Promise<Y.Doc> {
    throw new Error("Not implemented for tests");
  }

  // Helper to get root entity
  getRoot(): TestEntity {
    return this.loadEntity("root") as TestEntity;
  }

  private static rootSetup = false;
}

describe("Plexus Transactions", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus;

  beforeEach(() => {
    // Register test entity
    entityClasses.set("TestEntity", TestEntity);

    doc = new Y.Doc();
    plexus = new TestPlexus(doc);
  });

  afterEach(() => {
    entityClasses.clear();
  });

  describe("Basic transaction behavior", () => {
    it("should execute function within YJS transaction", () => {
      const yjsTransactSpy = vi.spyOn(doc, "transact");
      let executed = false;

      plexus.transact(() => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(yjsTransactSpy).toHaveBeenCalledTimes(1);
    });

    it("should return the result of the function", () => {
      const result = plexus.transact(() => {
        return { data: "test" };
      });

      expect(result).toEqual({ data: "test" });
    });

    it("should propagate errors from the function", () => {
      expect(() => {
        plexus.transact(() => {
          throw new Error("Test error");
        });
      }).toThrow("Test error");
    });

    it("should set isTransacting during transaction", () => {
      let wasTransacting = false;

      plexus.transact(() => {
        wasTransacting = isTransacting;
      });

      expect(wasTransacting).toBe(true);
      expect(isTransacting).toBe(false); // Should be reset after
    });

    it("should reset isTransacting even on error", () => {
      try {
        plexus.transact(() => {
          throw new Error("Test error");
        });
      } catch {}

      expect(isTransacting).toBe(false);
    });
  });

  describe("Notification queueing", () => {
    it("should queue notifications during transaction", () => {
      const callback = vi.fn();
      const entity = plexus.getRoot();

      // Create a tracked function that accesses the entity
      const tracked = createTrackedFunction(callback, () => {
        // Access entity.value to register tracking
        return entity.value;
      });

      // Execute to register tracking
      const initialValue = tracked();
      expect(initialValue).toBe("initial");

      // Clear any initial calls
      callback.mockClear();

      plexus.transact(() => {
        // Modify the entity we're tracking
        entity.value = "modified";

        // Callback should not be called yet
        expect(callback).not.toHaveBeenCalled();

        // Should be queued
        expect(pendingNotifications.size).toBeGreaterThan(0);
      });

      // After transaction, callback should be called
      expect(callback).toHaveBeenCalledTimes(1);
      expect(pendingNotifications.size).toBe(0);
    });

    it("should batch multiple notifications for same callback", () => {
      const callback = vi.fn();
      const entity = plexus.getRoot();

      // Create tracked function that accesses multiple fields
      const tracked = createTrackedFunction(callback, () => {
        // Access multiple fields
        return `${entity.value}-${entity.count}`;
      });

      tracked();
      callback.mockClear();

      plexus.transact(() => {
        // Multiple modifications
        entity.value = "changed1";
        entity.count = 1;
        entity.value = "changed2";
        entity.count = 2;

        // Still not called during transaction
        expect(callback).not.toHaveBeenCalled();
      });

      // Should be called exactly once after transaction
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple different callbacks", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();
      const entity = plexus.getRoot();

      const tracked1 = createTrackedFunction(callback1, () => entity.value);
      const tracked2 = createTrackedFunction(callback2, () => entity.count);
      const tracked3 = createTrackedFunction(
        callback3,
        () => entity.value + entity.count,
      );

      tracked1();
      tracked2();
      tracked3();

      callback1.mockClear();
      callback2.mockClear();
      callback3.mockClear();

      plexus.transact(() => {
        entity.value = "modified";
        entity.count = 42;

        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).not.toHaveBeenCalled();
        expect(callback3).not.toHaveBeenCalled();
      });

      // All should be called after transaction
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
    });

    it("should clear pending notifications even on error", () => {
      const callback = vi.fn();
      const entity = plexus.getRoot();
      const tracked = createTrackedFunction(callback, () => entity.value);

      tracked();
      callback.mockClear();

      try {
        plexus.transact(() => {
          entity.value = "will fail";
          expect(pendingNotifications.size).toBeGreaterThan(0);
          throw new Error("Test error");
        });
      } catch {}

      // Notifications should not be fired on error
      expect(callback).not.toHaveBeenCalled();
      // But queue should be cleared
      expect(pendingNotifications.size).toBe(0);
    });
  });

  describe("Shadow sub-transactions", () => {
    it("should not start new YJS transaction for nested calls", () => {
      const yjsTransactSpy = vi.spyOn(doc, "transact");

      plexus.transact(() => {
        plexus.transact(() => {
          plexus.transact(() => {
            // Deeply nested
          });
        });
      });

      // Only one YJS transaction for the outermost call
      expect(yjsTransactSpy).toHaveBeenCalledTimes(1);
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
      expect(states).toEqual([true, true, true, true, true]);
      // And false after
      expect(isTransacting).toBe(false);
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

      expect(result).toBe("outer: inner: deepest");
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
      }).toThrow("Nested error");
    });

    it("should queue all notifications until outermost transaction completes", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();
      const entity = plexus.getRoot();

      const tracked1 = createTrackedFunction(callback1, () => entity.value);
      const tracked2 = createTrackedFunction(callback2, () => entity.count);
      const tracked3 = createTrackedFunction(
        callback3,
        () => entity.value + entity.count,
      );

      tracked1();
      tracked2();
      tracked3();

      callback1.mockClear();
      callback2.mockClear();
      callback3.mockClear();

      plexus.transact(() => {
        entity.value = "first";
        expect(callback1).not.toHaveBeenCalled();

        plexus.transact(() => {
          entity.count = 10;
          expect(callback2).not.toHaveBeenCalled();

          plexus.transact(() => {
            entity.value = "nested";
            expect(callback3).not.toHaveBeenCalled();
          });

          // Still not called after inner transaction
          expect(callback3).not.toHaveBeenCalled();
        });

        // Still not called after middle transaction
        expect(callback2).not.toHaveBeenCalled();
      });

      // All called after outermost transaction
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
    });
  });

  describe("Edge cases", () => {
    it("should handle transaction called during notification flush", () => {
      const entity = plexus.getRoot();
      const callback = vi.fn(() => {
        // Try to start a new transaction during notification
        if (callback.mock.calls.length === 1) {
          const result = plexus.transact(() => {
            entity.count = 999;
            return "nested during flush";
          });
          expect(result).toBe("nested during flush");
        }
      });

      const tracked = createTrackedFunction(callback, () => entity.value);
      tracked();
      callback.mockClear();

      plexus.transact(() => {
        entity.value = "trigger";
      });

      expect(callback).toHaveBeenCalled();
    });

    it("should handle empty transactions", () => {
      const result = plexus.transact(() => {
        // Do nothing
      });

      expect(result).toBeUndefined();
      expect(isTransacting).toBe(false);
    });

    it("should handle transactions that only contain shadow sub-transactions", () => {
      const callback = vi.fn();
      const tracked = createTrackedFunction(callback, () => "tracked");
      tracked();
      callback.mockClear();

      plexus.transact(() => {
        plexus.transact(() => {
          // Only shadow transaction
        });
      });

      // No modifications, so no notifications
      expect(callback).not.toHaveBeenCalled();
    });

    it("should maintain correct state with concurrent tracking", () => {
      const entity = plexus.getRoot();
      const callbacks: Array<() => void> = [];
      const trackingFns: Array<() => void> = [];

      // Create multiple tracked functions
      for (let i = 0; i < 10; i++) {
        const callback = vi.fn();
        callbacks.push(callback);

        const tracked = createTrackedFunction(callback, () => {
          // Each accesses the entity
          return `${entity.value}-${entity.count}-${i}`;
        });

        trackingFns.push(tracked);
      }

      // Execute all to register tracking
      trackingFns.forEach((fn) => fn());
      callbacks.forEach((cb) => (cb as any).mockClear());

      plexus.transact(() => {
        // Trigger modifications
        for (let i = 0; i < 5; i++) {
          entity.count = i;
          entity.value = `value${i}`;
        }

        // None should be called yet
        callbacks.forEach((cb) => {
          expect(cb).not.toHaveBeenCalled();
        });
      });

      // All should be called after
      callbacks.forEach((cb) => {
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });

    it("should handle notification errors gracefully", () => {
      const entity = plexus.getRoot();
      const goodCallback = vi.fn();
      const badCallback = vi.fn(() => {
        throw new Error("Notification error");
      });
      const anotherGoodCallback = vi.fn();

      const tracked1 = createTrackedFunction(goodCallback, () => entity.value);
      const tracked2 = createTrackedFunction(badCallback, () => entity.count);
      const tracked3 = createTrackedFunction(
        anotherGoodCallback,
        () => `${entity.value}-${entity.count}`,
      );

      tracked1();
      tracked2();
      tracked3();

      goodCallback.mockClear();
      badCallback.mockClear();
      anotherGoodCallback.mockClear();

      // Should not throw even if notification throws
      expect(() => {
        plexus.transact(() => {
          entity.value = "modified";
          entity.count = 42;
        });
      }).not.toThrow();

      // Good callbacks should still be called
      expect(goodCallback).toHaveBeenCalledTimes(1);
      expect(badCallback).toHaveBeenCalledTimes(1);
      expect(anotherGoodCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("Integration with YJS", () => {
    it("should batch YJS operations in a single transaction", () => {
      const updates: Uint8Array[] = [];

      doc.on("update", (update) => {
        updates.push(update);
      });

      plexus.transact(() => {
        // Multiple YJS operations
        doc.getMap("test").set("key1", "value1");
        doc.getMap("test").set("key2", "value2");
        doc.getMap("test").set("key3", "value3");
        doc.getArray("array").push(["item1", "item2", "item3"]);
      });

      // Should result in a single update event due to transaction
      expect(updates.length).toBe(1);
    });

    it("should maintain YJS transaction semantics with nested calls", () => {
      const updates: Uint8Array[] = [];

      doc.on("update", (update) => {
        updates.push(update);
      });

      plexus.transact(() => {
        doc.getMap("test").set("outer", "start");

        plexus.transact(() => {
          doc.getMap("test").set("middle", "value");

          plexus.transact(() => {
            doc.getMap("test").set("inner", "deep");
          });
        });

        doc.getMap("test").set("outer", "end");
      });

      // Still just one YJS update
      expect(updates.length).toBe(1);

      // All values should be set
      expect(doc.getMap("test").get("outer")).toBe("end");
      expect(doc.getMap("test").get("middle")).toBe("value");
      expect(doc.getMap("test").get("inner")).toBe("deep");
    });
  });
});
