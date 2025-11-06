import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { createTrackedFunction } from "../tracking";

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor count!: number;

  constructor(props) {
    super(props);
  }
}

describe("Simple Data Change Notifications", () => {
  let obj: TestModel;

  beforeEach(() => {
    obj = new TestModel({
      name: "test",
      count: 5
    });
  });

  it("should notify when accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const trackedFn = createTrackedFunction(notifyChanges, () => {
      return obj.name; // Access obj.name
    });

    // First execution - just captures access, no notification
    expect(trackedFn()).toBe("test");
    expect(notifyChanges).toHaveBeenCalledTimes(0);

    // Modify the accessed field - should notify synchronously
    obj.name = "changed";
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should NOT notify when non-accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const trackedFn = createTrackedFunction(notifyChanges, () => {
      return obj.name; // Only access obj.name
    });

    expect(trackedFn()).toBe("test");
    expect(notifyChanges).toHaveBeenCalledTimes(0);

    // Modify a field that was NOT accessed - should not notify
    obj.count = 10;
    expect(notifyChanges).toHaveBeenCalledTimes(0);
  });

  it("should work with multiple functions", () => {
    const notifyChanges1 = vi.fn();
    const notifyChanges2 = vi.fn();

    const trackedFn1 = createTrackedFunction(notifyChanges1, () => obj.name);
    const trackedFn2 = createTrackedFunction(notifyChanges2, () => obj.name);

    // Both functions access obj.name
    expect(trackedFn1()).toBe("test");
    expect(trackedFn2()).toBe("test");

    // Change the shared field - both should be notified
    obj.name = "changed";
    expect(notifyChanges1).toHaveBeenCalledTimes(1);
    expect(notifyChanges2).toHaveBeenCalledTimes(1);
  });
});
