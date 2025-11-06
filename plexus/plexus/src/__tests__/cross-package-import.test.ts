import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedFunction } from "../index";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;
}

describe("Cross Package Import Test", () => {
  let obj: TestModel;

  beforeEach(() => {
    obj = new TestModel({
      name: "test"
    });
  });

  it("should work when imported from index", () => {
    const callback = vi.fn();

    const trackedFn = createTrackedFunction(callback, () => obj.name);

    expect(trackedFn()).toBe("test");
    expect(callback).toHaveBeenCalledTimes(0);

    obj.name = "changed";
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
