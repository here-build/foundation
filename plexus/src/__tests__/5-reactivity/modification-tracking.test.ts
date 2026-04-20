import { reaction } from "mobx";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";

beforeAll(() => { enableMobXIntegration(); });

@syncing("TestModel")
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor count!: number;
}

describe("Simple Data Change Notifications", () => {
  let obj: TestModel;

  beforeEach(() => {
    obj = new TestModel({
      name: "test",
      count: 5,
    });
  });

  it("should notify when accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const dispose = reaction(
      () => obj.name,
      notifyChanges,
    );

    // Reaction runs the data fn initially but does NOT call effect
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify the accessed field - should notify synchronously
    obj.name = "changed";
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose();
  });

  it("should NOT notify when non-accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const dispose = reaction(
      () => obj.name, // Only track obj.name
      notifyChanges,
    );

    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify a field that was NOT accessed - should not notify
    obj.count = 10;
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);
    dispose();
  });

  it("should work with multiple functions", () => {
    const notifyChanges1 = vi.fn();
    const notifyChanges2 = vi.fn();

    const dispose1 = reaction(() => obj.name, notifyChanges1);
    const dispose2 = reaction(() => obj.name, notifyChanges2);

    // Change the shared field - both should be notified
    obj.name = "changed";
    expect(notifyChanges1).to.have.property("mock").with.property("calls").with.lengthOf(1);
    expect(notifyChanges2).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose1();
    dispose2();
  });
});
