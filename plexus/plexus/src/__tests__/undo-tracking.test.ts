/**
 * Test to verify that Y.UndoManager operations trigger plexus tracking system
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { createTrackedFunction } from "../tracking";
import { Plexus } from "../Plexus";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name: string = "";
  @syncing
  accessor count: number = 0;
}

class TestPlexus extends Plexus<TestModel> {
  protected createDefaultRoot(): TestModel {
    return new TestModel({ name: "initial", count: 0 });
  }
}

describe("Y.UndoManager tracking", () => {
  let doc: Y.Doc;
  let testPlexus: TestPlexus;
  let root: TestModel;

  beforeEach(async () => {
    doc = new Y.Doc();
    testPlexus = new TestPlexus(doc);
    root = await testPlexus.rootPromise;
  });

  it("should track modifications from normal operations", async () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Normal modification tracked, count:", notificationCount);
      },
      () => {
        // Access the field to register interest
        return root.name;
      }
    );

    // Initial run
    const result1 = trackedFn();
    expect(result1).toBe("initial");
    expect(notificationCount).toBe(0); // No notifications yet

    // Modify the field
    testPlexus.transact(() => {
      root.name = "modified";
    });

    // Should trigger notification
    expect(notificationCount).toBe(1);
    console.log("✓ Normal modification test PASSED");
  });

  it("should track modifications from UndoManager.undo()", async () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Undo modification tracked, count:", notificationCount);
      },
      () => {
        // Access the field to register interest
        return root.name;
      }
    );

    // Initial run to establish tracking
    const result1 = trackedFn();
    expect(result1).toBe("initial");
    expect(notificationCount).toBe(0);

    // Make a change (this creates an undo stack item)
    testPlexus.transact(() => {
      root.name = "modified";
    });
    expect(notificationCount).toBe(1);

    // Re-run tracked function to reset tracking on new value
    const result2 = trackedFn();
    expect(result2).toBe("modified");

    // Now undo - this should trigger tracking notification
    console.log("About to undo...");
    testPlexus.undoManager.undo();

    // The critical assertion: did undo trigger tracking?
    if (notificationCount === 1) {
      console.error("✗ FAILED: Undo did NOT trigger tracking notification!");
      console.error("  Expected notificationCount: 2");
      console.error("  Actual notificationCount:", notificationCount);
    } else {
      console.log("✓ Undo modification test PASSED");
    }

    expect(notificationCount).toBe(2); // Should have been notified about undo

    // Verify the value actually changed
    const result3 = trackedFn();
    expect(result3).toBe("initial");
  });

  it("should track modifications from UndoManager.redo()", async () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Redo modification tracked, count:", notificationCount);
      },
      () => {
        return root.name;
      }
    );

    // Initial run
    trackedFn();
    expect(notificationCount).toBe(0);

    // Make a change
    testPlexus.transact(() => {
      root.name = "modified";
    });
    expect(notificationCount).toBe(1);

    // Re-run to reset tracking
    trackedFn();

    // Undo
    testPlexus.undoManager.undo();
    expect(notificationCount).toBe(2);

    // Re-run to reset tracking
    trackedFn();

    // Now redo - this should also trigger tracking
    console.log("About to redo...");
    testPlexus.undoManager.redo();

    // The critical assertion
    if (notificationCount === 2) {
      console.error("✗ FAILED: Redo did NOT trigger tracking notification!");
      console.error("  Expected notificationCount: 3");
      console.error("  Actual notificationCount:", notificationCount);
    } else {
      console.log("✓ Redo modification test PASSED");
    }

    expect(notificationCount).toBe(3);

    // Verify the value
    const result = trackedFn();
    expect(result).toBe("modified");
  });

  it("should track modifications from UndoManager for multiple fields", async () => {
    let nameNotifications = 0;
    let countNotifications = 0;

    const trackedNameFn = createTrackedFunction(
      () => {
        nameNotifications++;
      },
      () => root.name
    );

    const trackedCountFn = createTrackedFunction(
      () => {
        countNotifications++;
      },
      () => root.count
    );

    // Initial runs
    trackedNameFn();
    trackedCountFn();

    // Modify both fields
    testPlexus.transact(() => {
      root.name = "new-name";
      root.count = 42;
    });

    expect(nameNotifications).toBe(1);
    expect(countNotifications).toBe(1);

    // Re-run to reset tracking
    trackedNameFn();
    trackedCountFn();

    // Undo should trigger both
    testPlexus.undoManager.undo();

    console.log("Name notifications:", nameNotifications);
    console.log("Count notifications:", countNotifications);

    expect(nameNotifications).toBe(2);
    expect(countNotifications).toBe(2);
  });
});
